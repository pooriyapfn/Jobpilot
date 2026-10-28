// Resolve company names → ATS board (cached) → pre-filtered SourceJobs.
// Cache avoids re-probing ~3 endpoints per company on every scheduled run.

import { mkdir, readFile, writeFile } from "fs/promises";
import {
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
}

const CACHE_PATH = `${OUTPUT_DIR}ats-slugs.json`;
const MISS_TTL_DAYS = 14; // retry unresolved companies occasionally (they may adopt an ATS)
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

export interface CompanyBoardStats {
  companies: number;
  resolved: number;
  jobs: number;
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

    const workable = c.source !== "yc"; // YC startups rarely use Workable; skip the rate-limited probe
    let board: { ats: AtsName; jobs: BoardJob[] } | null = null;
    let transient = false;

    if (cached?.slug && cached.ats) {
      const r = await resolveBoard(cached.slug, { hint: cached.ats, workable });
      if (r.kind === "hit") board = r;
    } else if (cached && !cached.slug && missIsFresh(cached)) {
      return [] as SourceJob[];
    } else {
      const candidates = slugCandidates(c.name, c.website);
      for (const [i, slug] of candidates.entries()) {
        // Workable bans aggressive probing — only try it for the two most specific slugs
        const r = await resolveBoard(slug, { workable: workable && i < 2 });
        if (r.kind === "hit") {
          board = r;
          cache[key] = { ats: r.ats, slug, checkedAt: new Date().toISOString() };
          break;
        }
        if (r.kind === "transient") transient = true;
      }
      // Never cache a miss caused by rate limits / outages — retry next run
      if (!board && !transient) {
        cache[key] = { ats: null, slug: null, checkedAt: new Date().toISOString() };
      }
    }

    if (!board) return [];
    resolved++;
    return toSourceJobs(board.jobs, c.name, c.source);
  });

  await saveCache(cache);
  const jobs = perCompany.flat();
  return { jobs, stats: { companies: unique.size, resolved, jobs: jobs.length } };
}
