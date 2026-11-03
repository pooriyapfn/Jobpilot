import { EXCLUDED_DOMAINS, EXCLUDED_ATS_COMPANIES } from "./config.ts";
import type { SearchJob } from "./types.ts";

export function isExcluded(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return EXCLUDED_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return true;
  }
}

export function isExcludedATSCompany(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    if (
      hostname === "jobs.lever.co" ||
      hostname === "jobs.ashbyhq.com"
    ) {
      const slug = pathname.split("/")[1];
      return EXCLUDED_ATS_COMPANIES.includes(slug ?? "");
    }
    return false;
  } catch {
    return false;
  }
}

/** Excluded domain / ATS company — unless the job came from an aggregator source on purpose (it carries a listing). */
export function isBlocked(job: Pick<SearchJob, "url" | "listing">): boolean {
  return !job.listing && (isExcluded(job.url) || isExcludedATSCompany(job.url));
}

const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gh_src", "gh_jid", "ref"];

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const param of TRACKING_PARAMS) {
      u.searchParams.delete(param);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function deduplicate(jobs: SearchJob[]): SearchJob[] {
  const map = new Map<string, SearchJob>();

  for (const job of jobs) {
    const key = normalizeUrl(job.url);
    const existing = map.get(key);
    if (existing) {
      for (const q of job.foundByQueries) {
        if (!existing.foundByQueries.includes(q)) {
          existing.foundByQueries.push(q);
        }
      }
      for (const s of job.extraSnippets) {
        if (!existing.extraSnippets.includes(s)) {
          existing.extraSnippets.push(s);
        }
      }
    } else {
      map.set(key, { ...job, url: key });
    }
  }

  return Array.from(map.values());
}
