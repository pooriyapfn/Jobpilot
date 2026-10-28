import { VC_WATCHLIST } from "../config.ts";
import { jobsForCompanies, type CompanyRef } from "./company-boards.ts";
import { fetchFundedCompanies } from "./funding-news.ts";
import { fetchHnHiring } from "./hn-hiring.ts";
import type { SourceJob } from "./boards.ts";
import { fetchYcCompanies } from "./yc.ts";

export type SourceName = "yc" | "funding" | "watchlist" | "hn";
export const ALL_SOURCES: SourceName[] = ["watchlist", "funding", "yc", "hn"];

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
    } else if (s === "hn") {
      try {
        const jobs = await fetchHnHiring();
        results.push({ source: s, jobs, note: "latest Who-is-hiring thread" });
      } catch (err) {
        results.push({ source: s, jobs: [], note: "", error: (err as Error).message });
      }
    }
  }
  return results;
}
