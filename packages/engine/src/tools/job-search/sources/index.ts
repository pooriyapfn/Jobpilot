import { VC_WATCHLIST } from "../config.ts";
import { fetchHimalayas, fetchRemoteOk } from "./aggregators.ts";
import { harvestBoards, jobsForCompanies, knownCompanies, type CompanyRef } from "./company-boards.ts";
import { fetchFundedCompanies } from "./funding-news.ts";
import { fetchGoogleJobs } from "./google-jobs.ts";
import { fetchHnHiring } from "./hn-hiring.ts";
import type { SourceJob } from "./boards.ts";
import { fetchWatchedSites } from "./watched-sites.ts";
import { fetchYcCompanies } from "./yc.ts";

export type SourceName =
  | "yc" | "funding" | "watchlist" | "hn" | "google" | "sites" | "remoteok" | "himalayas" | "known";
// "known" last: it polls every board found before (and in this run) that the other sources didn't
export const ALL_SOURCES: SourceName[] = [
  "watchlist", "funding", "yc", "hn", "google", "sites", "remoteok", "himalayas", "known",
];

export interface SourceResult {
  source: SourceName;
  jobs: SourceJob[];
  note: string;
  error?: string;
}

async function companySource(
  source: SourceName,
  load: () => Promise<CompanyRef[]>
): Promise<SourceResult> {
  try {
    const companies = await load();
    const { jobs, stats } = await jobsForCompanies(companies);
    return {
      source,
      jobs,
      note: `${stats.companies} companies, ${stats.resolved} with a public ATS board`,
    };
  } catch (err) {
    return { source, jobs: [], note: "", error: (err as Error).message };
  }
}

export async function runSources(enabled: SourceName[] = ALL_SOURCES): Promise<SourceResult[]> {
  const results: SourceResult[] = [];
  // Sequential: keeps ATS request rate polite and log output readable
  for (const s of enabled) {
    if (s === "watchlist") {
      results.push(
        await companySource(s, async () => VC_WATCHLIST.map((name) => ({ name, source: "watchlist" })))
      );
    } else if (s === "funding") {
      results.push(await companySource(s, fetchFundedCompanies));
    } else if (s === "yc") {
      results.push(await companySource(s, fetchYcCompanies));
    } else if (s === "known") {
      results.push(await companySource(s, knownCompanies));
    } else {
      const load = {
        hn: async () => ({ jobs: await fetchHnHiring(), note: "latest Who-is-hiring thread" }),
        google: fetchGoogleJobs,
        sites: fetchWatchedSites,
        remoteok: fetchRemoteOk,
        himalayas: fetchHimalayas,
      }[s];
      try {
        const { jobs, note } = await load();
        results.push({ source: s, jobs, note });
      } catch (err) {
        results.push({ source: s, jobs: [], note: "", error: (err as Error).message });
      }
    }
    // ATS links from any source (HN posts, Google Jobs apply links) grow the known-company registry
    const last = results[results.length - 1];
    if (last && s !== "known") await harvestBoards(last.jobs.map((j) => j.url), s).catch(() => 0);
  }
  return results;
}
