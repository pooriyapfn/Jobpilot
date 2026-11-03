// Resolve company names → ATS board (cached) → pre-filtered SourceJobs.
// Cache avoids re-probing ~3 endpoints per company on every run. It is also the registry of known
// companies: every resolved board is polled again on later runs ("known" source) until it has had no
// relevant role for KNOWN_TTL_DAYS.

import { mkdir, readFile, writeFile } from "fs/promises";
import { EXCLUDED_ATS_COMPANIES } from "../config.ts";
import {
  isRelevantTitle,
  mapLimit,
  resolveBoard,
  type BoardJob,
  slugCandidates,
  toSourceJobs,
  type AtsName,
  type SourceJob,
} from "./boards.ts";
import { OUTPUT_DIR } from "../paths.ts";

export interface CompanyRef {
  name: string;
  website?: string;
  /** Provenance tag, e.g. "yc", "funding-news", "watchlist" */
  source: string;
}

interface CacheEntry {
  ats: AtsName | null;
  slug: string | null;
  checkedAt: string;
  /** Where the company was first found, e.g. "yc", "funding-news", "harvest" */
  source?: string;
  addedAt?: string;
  /** Last time its board had a remote role with a relevant title */
  lastRelevantAt?: string;
}

const CACHE_PATH = `${OUTPUT_DIR}ats-slugs.json`;
const MISS_TTL_DAYS = 14; // retry unresolved companies occasionally (they may adopt an ATS)
const KNOWN_TTL_DAYS = 60; // stop polling a known company after this long without a relevant role
const CONCURRENCY = 8;

async function loadCache(): Promise<Record<string, CacheEntry>> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, "utf8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

async function saveCache(cache: Record<string, CacheEntry>): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

const cacheKey = (name: string) => name.trim().toLowerCase();

function missIsFresh(e: CacheEntry): boolean {
  return Date.now() - Date.parse(e.checkedAt) < MISS_TTL_DAYS * 86_400_000;
}

const daysSince = (iso: string | undefined) => (iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : Infinity);

// Boards already polled in this process — sources overlap (watchlist ∩ YC ∩ known)
const polledThisRun = new Set<string>();

/** Known companies with a resolved board that had a relevant role recently (or were added recently). */
export async function knownCompanies(): Promise<CompanyRef[]> {
  const cache = await loadCache();
  return Object.entries(cache)
    .filter(([, e]) => e.slug && e.ats && daysSince(e.lastRelevantAt ?? e.addedAt ?? e.checkedAt) <= KNOWN_TTL_DAYS)
    .map(([name]) => ({ name, source: "known" }));
}

/** ATS board behind a job URL: jobs.lever.co/acme/… → { ats: "lever", slug: "acme" } */
export function boardFromUrl(url: string): { ats: AtsName; slug: string } | null {
  let host: string, first: string | undefined;
  try {
    const u = new URL(url);
    host = u.hostname;
    first = u.pathname.split("/").filter(Boolean)[0];
  } catch {
    return null;
  }
  if (!first || EXCLUDED_ATS_COMPANIES.includes(first.toLowerCase())) return null;
  if (host === "jobs.ashbyhq.com") return { ats: "ashby", slug: first };
  if (host === "jobs.lever.co") return { ats: "lever", slug: first };
  if ((host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") && first !== "embed") {
    return { ats: "greenhouse", slug: first };
  }
  if (host === "apply.workable.com" && first !== "j" && first !== "api") return { ats: "workable", slug: first };
  return null;
}

/** Add the ATS boards behind these job URLs to the registry, so later runs poll the whole board. */
export async function harvestBoards(urls: string[], source = "harvest"): Promise<number> {
  const cache = await loadCache();
  const have = new Set(Object.values(cache).map((e) => `${e.ats}:${e.slug}`));
  const now = new Date().toISOString();
  let added = 0;
  for (const url of urls) {
    const b = boardFromUrl(url);
    if (!b || have.has(`${b.ats}:${b.slug}`) || cache[b.slug]) continue;
    have.add(`${b.ats}:${b.slug}`);
    cache[b.slug] = { ats: b.ats, slug: b.slug, checkedAt: now, source, addedAt: now };
    added++;
  }
  if (added) await saveCache(cache);
  return added;
}

export interface CompanyBoardStats {
  companies: number;
  resolved: number;
  jobs: number;
}

type Board = { ats: AtsName; jobs: BoardJob[] };

/** The company's board via the cache, or by probing slug candidates (result cached; transient misses aren't). */
async function lookupBoard(c: CompanyRef, cache: Record<string, CacheEntry>): Promise<Board | null> {
  const key = cacheKey(c.name);
  const cached = cache[key];
  const workable = c.source !== "yc"; // YC startups rarely use Workable; skip the rate-limited probe

  if (cached?.slug && cached.ats) {
    polledThisRun.add(`${cached.ats}:${cached.slug}`);
    const r = await resolveBoard(cached.slug, { hint: cached.ats, workable });
    return r.kind === "hit" ? r : null;
  }
  if (cached && !cached.slug && missIsFresh(cached)) return null;

  let transient = false;
  for (const [i, slug] of slugCandidates(c.name, c.website).entries()) {
    // Workable bans aggressive probing — only try it for the two most specific slugs
    const r = await resolveBoard(slug, { workable: workable && i < 2 });
    if (r.kind === "hit") {
      const now = new Date().toISOString();
      cache[key] = { ats: r.ats, slug, checkedAt: now, source: c.source, addedAt: now };
      polledThisRun.add(`${r.ats}:${slug}`);
      return r;
    }
    if (r.kind === "transient") transient = true;
  }
  // Never cache a miss caused by rate limits / outages — retry next run
  if (!transient) cache[key] = { ats: null, slug: null, checkedAt: new Date().toISOString() };
  return null;
}

export async function jobsForCompanies(
  companies: CompanyRef[]
): Promise<{ jobs: SourceJob[]; stats: CompanyBoardStats }> {
  const cache = await loadCache();

  // Dedup by name — the same startup can appear in several sources
  const unique = new Map<string, CompanyRef>();
  for (const c of companies) {
    const k = cacheKey(c.name);
    if (k && !unique.has(k)) unique.set(k, c);
  }

  let resolved = 0;
  const perCompany = await mapLimit(Array.from(unique.values()), CONCURRENCY, async (c) => {
    const key = cacheKey(c.name);
    const cached = cache[key];
    if (polledThisRun.has(key) || (cached?.slug && polledThisRun.has(`${cached.ats}:${cached.slug}`))) {
      return [] as SourceJob[];
    }
    polledThisRun.add(key);

    const board = await lookupBoard(c, cache);
    if (!board) return [];
    resolved++;
    if (board.jobs.some((j) => j.remote && isRelevantTitle(j.title)) && cache[key]) {
      cache[key].lastRelevantAt = new Date().toISOString();
    }
    return toSourceJobs(board.jobs, c.name, c.source);
  });

  await saveCache(cache);
  const jobs = perCompany.flat();
  return { jobs, stats: { companies: unique.size, resolved, jobs: jobs.length } };
}

// ── Aggregator listing → the employer's own posting ─────────────────────────

const NOISE = /\b(remote|hybrid|contract|contractor|full[- ]?time|part[- ]?time|freelance|worldwide|global|anywhere|us|eu|emea|latam|apac)\b/g;

/** "Senior Software Engineer (Remote, EU)" → "senior software engineer" */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 0–1: same normalized title = 1, otherwise word overlap (Jaccard). */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a), y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const sa = new Set(x.split(" ")), sb = new Set(y.split(" "));
  const inter = [...sa].filter((w) => sb.has(w)).length;
  return inter / new Set([...sa, ...sb]).size;
}

const MATCH_THRESHOLD = 0.75;

/** Best posting on the board for a listing's title, if close enough. */
export function matchPosting(jobs: BoardJob[], title: string): BoardJob | undefined {
  let best: BoardJob | undefined, score = 0;
  for (const j of jobs) {
    const s = titleSimilarity(j.title, title);
    if (s > score) [best, score] = [j, s];
  }
  return score >= MATCH_THRESHOLD ? best : undefined;
}

/**
 * For listings from aggregators (RemoteOK, Himalayas, Wellfound): find the same job on the company's
 * own Greenhouse/Lever/Ashby/Workable board. That page holds the real application form.
 */
export async function findEmployerPostings(
  listings: Array<{ company: string; title: string }>,
  source: string
): Promise<Array<BoardJob | undefined>> {
  const cache = await loadCache();
  const boards = new Map<string, Promise<Board | null>>();
  const out = await mapLimit(listings, 4, async (l) => {
    const key = cacheKey(l.company);
    if (!key) return undefined;
    if (!boards.has(key)) boards.set(key, lookupBoard({ name: l.company, source }, cache).catch(() => null));
    const board = await boards.get(key)!;
    return board ? matchPosting(board.jobs, l.title) : undefined;
  });
  await saveCache(cache);
  return out;
}
