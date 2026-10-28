import { braveSearch } from "./brave.ts";
import type { SearchJob } from "./types.ts";

const PAGES = 3;
const REQUEST_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function searchAllPages(
  query: string,
  onRequest: () => void
): Promise<{ results: Omit<SearchJob, "foundByQueries">[]; requests: number }> {
  const results: Omit<SearchJob, "foundByQueries">[] = [];
  let requests = 0;

  for (let page = 0; page < PAGES; page++) {
    const offset = page * 20;
    onRequest();
    const pageResults = await braveSearch({ query, offset });
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
  onRequest: () => void
): Promise<Array<{ query: string; results: Omit<SearchJob, "foundByQueries">[] }>> {
  const allResults: Array<{ query: string; results: Omit<SearchJob, "foundByQueries">[] }> = [];

  for (const query of queries) {
    await sleep(REQUEST_DELAY_MS);
    const { results } = await searchAllPages(query, onRequest);
    allResults.push({ query, results });
  }

  return allResults;
}
