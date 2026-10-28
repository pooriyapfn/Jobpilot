// Public ATS board APIs (no auth). Given a company slug, list its open jobs.
//   Greenhouse: boards-api.greenhouse.io/v1/boards/{slug}/jobs
//   Lever:      api.lever.co/v0/postings/{slug}?mode=json
//   Ashby:      api.ashbyhq.com/posting-api/job-board/{slug}
//   Workable:   apply.workable.com/api/v1/widget/accounts/{slug}

import { classifyGeographicScope } from "../classifier.ts";
import { ROLE_TITLE_INCLUDE, ROLE_TITLE_EXCLUDE, SOURCE_MAX_AGE_DAYS } from "../config.ts";
import type { SearchJob } from "../types.ts";

export type AtsName = "ashby" | "lever" | "greenhouse" | "workable";
export type SourceJob = Omit<SearchJob, "foundByQueries">;

export interface BoardJob {
  title: string;
  url: string;
  location: string;
  remote: boolean;
  postedAt?: string;
  company?: string;
  summary?: string;
}

const FETCH_TIMEOUT_MS = 12_000;

/** Rate limit / 5xx / network error — says nothing about whether the board exists. */
export class TransientError extends Error {}

async function getJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (res.status === 404 || res.status === 400) return null; // no board under this slug
    if (!res.ok) throw new TransientError(`${res.status} ${url}`);
    return await res.json();
  } catch (err) {
    if (err instanceof TransientError) throw err;
    throw new TransientError(`${(err as Error).message} ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

// Workable's Cloudflare rate limit is strict: space its requests out globally.
let workableNextSlot = 0;
const WORKABLE_GAP_MS = 1000;
async function workableSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, workableNextSlot);
  workableNextSlot = at + WORKABLE_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

async function fetchAshby(slug: string): Promise<BoardJob[] | null> {
  const data = (await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`
  )) as { jobs?: Array<Record<string, unknown>> } | null;
  if (!data?.jobs) return null;
  return data.jobs
    .filter((j) => j["isListed"] !== false)
    .map((j) => {
      const location = str(j["location"]) ?? "";
      const secondary = Array.isArray(j["secondaryLocations"])
        ? (j["secondaryLocations"] as Array<Record<string, unknown>>)
            .map((s) => str(s["location"]))
            .filter(Boolean)
        : [];
      return {
        title: str(j["title"]) ?? "",
        url: str(j["jobUrl"]) ?? "",
        location: [location, ...secondary].join("; "),
        // isRemote is true for hybrid roles with a remote option — workplaceType is stricter
        remote: (() => {
          const wt = str(j["workplaceType"])?.toLowerCase();
          if (wt) return wt === "remote";
          return j["isRemote"] === true || /remote/i.test(location);
        })(),
        postedAt: str(j["publishedAt"]),
        summary: str(j["descriptionPlain"])?.slice(0, 400),
      };
    });
}

async function fetchLever(slug: string): Promise<BoardJob[] | null> {
  const data = (await getJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`
  )) as Array<Record<string, unknown>> | null;
  if (!Array.isArray(data)) return null;
  return data.map((j) => {
    const cats = (j["categories"] ?? {}) as Record<string, unknown>;
    const all = Array.isArray(cats["allLocations"]) ? (cats["allLocations"] as string[]) : [];
    const location = all.length ? all.join("; ") : (str(cats["location"]) ?? "");
    const created = typeof j["createdAt"] === "number" ? new Date(j["createdAt"]).toISOString() : undefined;
    return {
      title: str(j["text"]) ?? "",
      url: str(j["hostedUrl"]) ?? "",
      location,
      remote: str(j["workplaceType"])?.toLowerCase() === "remote" || /remote/i.test(location),
      postedAt: created,
      summary: str(j["descriptionPlain"])?.slice(0, 400),
    };
  });
}

async function fetchGreenhouse(slug: string): Promise<BoardJob[] | null> {
  const data = (await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`
  )) as { jobs?: Array<Record<string, unknown>> } | null;
  if (!data?.jobs) return null;
  return data.jobs.map((j) => {
    const location = str((j["location"] as Record<string, unknown> | undefined)?.["name"]) ?? "";
    return {
      title: str(j["title"]) ?? "",
      url: str(j["absolute_url"]) ?? "",
      location,
      // Greenhouse list has no remote flag — location string is the only signal
      remote: /remote|anywhere|worldwide/i.test(location),
      // first_published is the real posting date; updated_at is not (see AtsJobData)
      postedAt: str(j["first_published"]),
      company: str(j["company_name"]),
    };
  });
}

async function fetchWorkable(slug: string): Promise<BoardJob[] | null> {
  // Widget endpoint: one GET returns every published job (the v3 search POST is rate-limited hard)
  await workableSlot();
  const data = (await getJson(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`
  )) as { jobs?: Array<Record<string, unknown>> } | null;
  if (!data?.jobs) return null;

  return data.jobs.flatMap((j) => {
    const shortcode = str(j["shortcode"]);
    if (!shortcode) return [];
    return [
      {
        title: str(j["title"]) ?? "",
        url: `https://apply.workable.com/${slug}/j/${shortcode}/`,
        // city/country is the office on file, not where remote hires may live — keep it as a hint
        // and let the title/page text drive geo checks in verify.
        location: "Remote",
        remote: j["telecommuting"] === true,
        postedAt: str(j["published_on"]) ?? str(j["created_at"]),
        summary: [str(j["city"]), str(j["country"])].filter(Boolean).join(", ") || undefined,
      },
    ];
  });
}

const FETCHERS: Record<AtsName, (slug: string) => Promise<BoardJob[] | null>> = {
  ashby: fetchAshby,
  lever: fetchLever,
  greenhouse: fetchGreenhouse,
  workable: fetchWorkable,
};

export async function fetchBoard(ats: AtsName, slug: string): Promise<BoardJob[] | null> {
  return FETCHERS[ats](slug);
}

export type ResolveResult =
  | { kind: "hit"; ats: AtsName; jobs: BoardJob[] }
  | { kind: "miss" }
  | { kind: "transient" };

/** Try each ATS in turn; first board that exists wins. Workable only when allowed (rate-limited). */
export async function resolveBoard(
  slug: string,
  opts: { hint?: AtsName; workable?: boolean } = {}
): Promise<ResolveResult> {
  const all: AtsName[] = ["ashby", "greenhouse", "lever", ...(opts.workable || opts.hint === "workable" ? (["workable"] as AtsName[]) : [])];
  const order = all.sort((a, b) => (a === opts.hint ? -1 : b === opts.hint ? 1 : 0));
  let transient = false;
  for (const ats of order) {
    try {
      const jobs = await fetchBoard(ats, slug);
      if (jobs) return { kind: "hit", ats, jobs };
    } catch (err) {
      if (!(err instanceof TransientError)) throw err;
      transient = true;
    }
  }
  return transient ? { kind: "transient" } : { kind: "miss" };
}

// ── Slug candidates ──────────────────────────────────────────────────────────

/** "Hugging Face, Inc." + https://huggingface.co → ["huggingface", "hugging-face"] */
export function slugCandidates(name: string, website?: string): string[] {
  const out = new Set<string>();
  const words = (n: string) => n.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);

  // Most specific first: "Together AI" → togetherai, together-ai. Stripped forms ("together")
  // come last because short generic slugs collide with unrelated companies.
  const full = words(name);
  if (full.length) {
    out.add(full.join(""));
    if (full.length > 1) out.add(full.join("-"));
  }
  if (website) {
    try {
      const label = new URL(website).hostname.replace(/^www\./, "").split(".")[0];
      if (label) out.add(label);
    } catch {
      /* ignore bad website */
    }
  }
  const stripped = words(name.replace(/\b(inc|llc|ltd|corp|co|labs?|ai|technologies|hq)\b\.?/gi, " "));
  if (stripped.length) out.add(stripped.join(""));

  // 1–3 char slugs collide with unrelated companies — too risky to probe
  return Array.from(out).filter((s) => s.length >= 4);
}

// ── Filtering ────────────────────────────────────────────────────────────────

export function isRelevantTitle(title: string): boolean {
  return ROLE_TITLE_INCLUDE.test(title) && !ROLE_TITLE_EXCLUDE.test(title);
}

function isFreshEnough(postedAt?: string): boolean {
  if (!postedAt) return true; // unknown date → let verify decide
  const t = Date.parse(postedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= SOURCE_MAX_AGE_DAYS * 86_400_000;
}

/** Cheap pre-filter: role title, remote, recent, not obviously country-restricted. */
export function toSourceJobs(jobs: BoardJob[], company: string, sourceTag: string): SourceJob[] {
  const now = new Date().toISOString();
  const out: SourceJob[] = [];
  for (const j of jobs) {
    if (!j.url || !j.title) continue;
    if (!isRelevantTitle(j.title)) continue;
    if (!j.remote) continue;
    if (!isFreshEnough(j.postedAt)) continue;
    const geo = classifyGeographicScope([j.location], j.location, "", j.title);
    if (geo.scope === "specific-country") continue;
    // "Remote" + an unrecognised place ("Korea", "Toronto; Ottawa") = remote within that place.
    // Keep only bare "Remote" or an explicit open scope (worldwide / EMEA / candidate's country).
    const bare = j.location.replace(/remote|hybrid|anywhere|[;,()\-|/]/gi, "").trim();
    if (geo.scope === "unknown" && bare && !/^(europe|emea|global|worldwide)$/i.test(bare)) continue;

    let domain = "";
    try {
      domain = new URL(j.url).hostname;
    } catch {
      continue;
    }
    out.push({
      title: `${j.title} — ${j.company ?? company}`,
      url: j.url,
      description: [j.location, j.postedAt ? `posted ${j.postedAt.slice(0, 10)}` : "", j.summary ?? ""]
        .filter(Boolean)
        .join(" · "),
      extraSnippets: [`source:${sourceTag}`, `company:${j.company ?? company}`],
      sourceDomain: domain,
      discoveredAt: now,
    });
  }
  return out;
}

// ── Bounded concurrency ──────────────────────────────────────────────────────

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}
