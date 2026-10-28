interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
    more_results_available?: boolean;
  };
}

export interface BraveResult {
  title: string;
  url: string;
  description: string;
  extraSnippets: string[];
  moreResultsAvailable: boolean;
}

export async function braveSearch({
  query,
  offset = 0,
}: {
  query: string;
  offset?: number;
}): Promise<BraveResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_API_KEY is not set");
  }

  const params = new URLSearchParams({
    q: query,
    count: "20",
    offset: String(offset),
    freshness: "pw",
    search_lang: "en",
    extra_snippets: "true",
  });

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brave API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as BraveSearchResponse;
  const results = data.web?.results ?? [];
  const moreResultsAvailable = data.web?.more_results_available ?? false;

  return results.map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description ?? "",
    extraSnippets: r.extra_snippets ?? [],
    moreResultsAvailable,
  }));
}
