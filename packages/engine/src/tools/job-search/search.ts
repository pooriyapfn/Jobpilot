import { braveSearch } from "./brave.ts";
import type { SearchJob } from "./types.ts";

const PAGES = 3;
const REQUEST_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How far back this run looks: since the last run plus a day of overlap (search engines index late),
 * between 1 and 7 days — verify rejects anything older than a week anyway. SEARCH_WINDOW_DAYS overrides.
 */
export function searchWindowDays(lastRunAt: string | undefined, now = Date.now()): number {
  const fixed = Number(process.env.SEARCH_WINDOW_DAYS);
  if (fixed > 0) return Math.min(Math.ceil(fixed), 7);
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN;
  if (Number.isNaN(last)) return 7;
  return Math.min(7, Math.max(1, Math.ceil((now - last) / 86_400_000 + 1)));
}

/** Brave `freshness` for a window: pd / pw, or an explicit date range in between. */
export function braveFreshness(days: number, now = new Date()): string {
  if (days <= 1) return "pd";
  if (days >= 7) return "pw";
  const from = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return `${from}to${now.toISOString().slice(0, 10)}`;
}

export async function searchAllPages(
  query: string,
  onRequest: () => void,
  freshness?: string
): Promise<{ results: Omit<SearchJob, "foundByQueries">[]; requests: number }> {
  const results: Omit<SearchJob, "foundByQueries">[] = [];
  let requests = 0;

  for (let page = 0; page < PAGES; page++) {
    const offset = page * 20;
    onRequest();
    const pageResults = await braveSearch({ query, offset, freshness });
    requests++;

    for (const r of pageResults) {
      const domain = (() => {
        try {
          return new URL(r.url).hostname;
        } catch {
          return "";
        }
      })();

      results.push({
        title: r.title,
        url: r.url,
        description: r.description,
        extraSnippets: r.extraSnippets,
        sourceDomain: domain,
        discoveredAt: new Date().toISOString(),
      });
    }

    if (pageResults.length === 0 || !pageResults[pageResults.length - 1]?.moreResultsAvailable) {
      break;
    }

    if (page < PAGES - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return { results, requests };
}

export async function runAllSearches(
  queries: string[],
  onRequest: () => void,
  freshness?: string
): Promise<Array<{ query: string; results: Omit<SearchJob, "foundByQueries">[] }>> {
  const allResults: Array<{ query: string; results: Omit<SearchJob, "foundByQueries">[] }> = [];

  for (const query of queries) {
    await sleep(REQUEST_DELAY_MS);
    const { results } = await searchAllPages(query, onRequest, freshness);
    allResults.push({ query, results });
  }

  return allResults;
}
