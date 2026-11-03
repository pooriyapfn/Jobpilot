// Google Jobs via SerpApi (engine=google_jobs). Google indexes every page with JobPosting JSON-LD,
// so this reaches agency and small-company sites that web search rarely ranks. Needs SERPAPI_KEY.

import { candidate } from "../candidate.ts";
import { GOOGLE_JOBS_QUERIES } from "../config.ts";
import { isExcluded } from "../filters.ts";
import { toSourceJobs, type BoardJob, type SourceJob } from "./boards.ts";

interface GoogleJob {
  title?: string;
  company_name?: string;
  location?: string;
  description?: string;
  share_link?: string;
  detected_extensions?: { posted_at?: string; work_from_home?: boolean };
  apply_options?: Array<{ title?: string; link?: string }>;
}

/** Base queries plus one per open region of the candidate ("software engineer remote MENA"). */
export function googleJobsQueries(): string[] {
  return [...GOOGLE_JOBS_QUERIES, ...candidate().regions.map((r) => `software engineer remote ${r}`)];
}

/** "21 hours ago" / "3 days ago" / "1 month ago" → ISO date; unknown → undefined (verify decides). */
export function postedAtToIso(postedAt: string | undefined, now = Date.now()): string | undefined {
  const m = postedAt?.match(/(\d+)\s*\+?\s*(minute|hour|day|week|month)s?\s+ago/i);
  if (!m) return undefined;
  const hours: Record<string, number> = { minute: 1 / 60, hour: 1, day: 24, week: 168, month: 720 };
  return new Date(now - Number(m[1]) * hours[m[2]!.toLowerCase()]! * 3_600_000).toISOString();
}

/** First apply link that isn't an excluded aggregator (LinkedIn, Indeed, …) — the employer's or agency's own page. */
export function pickApplyUrl(job: GoogleJob): string | undefined {
  return job.apply_options?.map((o) => o.link).find((l): l is string => !!l && !isExcluded(l));
}

export function toBoardJob(job: GoogleJob): BoardJob | null {
  const url = pickApplyUrl(job);
  if (!url || !job.title) return null;
  const location = job.location ?? "";
  const remote =
    job.detected_extensions?.work_from_home === true ||
    /remote|anywhere|work from home/i.test(`${location} ${job.title} ${(job.description ?? "").slice(0, 600)}`);
  return {
    title: job.title,
    url,
    location: location || "Remote",
    remote,
    postedAt: postedAtToIso(job.detected_extensions?.posted_at),
    company: job.company_name,
    summary: (job.description ?? "").slice(0, 300),
  };
}

async function search(q: string, apiKey: string): Promise<GoogleJob[]> {
  const params = new URLSearchParams({ engine: "google_jobs", q, hl: "en", api_key: apiKey });
  const res = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`SerpApi ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { jobs_results?: GoogleJob[]; error?: string };
  // "Google hasn't returned any results" is a normal empty answer, not a failure
  if (data.error && !/no results|hasn't returned any results/i.test(data.error)) throw new Error(data.error);
  return data.jobs_results ?? [];
}

export async function fetchGoogleJobs(): Promise<{ jobs: SourceJob[]; note: string }> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return { jobs: [], note: "skipped (no SERPAPI_KEY)" };
  const queries = googleJobsQueries();
  const jobs: SourceJob[] = [];
  let raw = 0;
  for (const q of queries) {
    try {
      const results = await search(q, apiKey);
      raw += results.length;
      for (const g of results) {
        const b = toBoardJob(g);
        if (b) jobs.push(...toSourceJobs([b], g.company_name ?? "", "google-jobs"));
      }
    } catch (err) {
      console.warn(`  google-jobs "${q}" failed: ${(err as Error).message}`);
    }
  }
  return { jobs, note: `${queries.length} queries, ${raw} results` };
}
