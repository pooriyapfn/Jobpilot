// Freshly funded startups: Brave News headlines like "Acme raises $20M Series A led by ..."
// → company names → resolved to ATS boards by company-boards.ts.

import { FUNDING_FEEDS, FUNDING_NEWS_QUERIES } from "../config.ts";
import type { CompanyRef } from "./company-boards.ts";

interface BraveNewsResult {
  title?: string;
  url?: string;
  description?: string;
}

// "Acme raises", "Acme AI secures", "Acme, maker of X, lands" → "Acme"
const HEADLINE_RE =
  /^(?:exclusive:?\s*)?([A-Z][\w.&'’-]*(?:\s+[A-Z][\w.&'’-]*){0,2})(?:,[^,]{3,60},)?\s+(?:raises?|raised|secures?|lands?|closes?|bags?|nabs?|snags?|announces?|emerges|scores?)\b/i;

// Descriptors, not names: "Israeli startup", "Vienna-based Reebuild", "How to"
const GENERIC_WORD_RE = /\b(startup|start-up|based|company|firm|maker|platform|how|why|what|who|this|the|report|ai-powered|former|ex)\b|-based$/i;

export function companyFromHeadline(title: string): string | null {
  const m = HEADLINE_RE.exec(title.trim());
  let name = m?.[1]?.trim();
  if (!name) return null;
  // "Startup Causa Prima" → "Causa Prima"
  name = name.replace(/^(startup|start-up)\s+/i, "");
  if (!name || GENERIC_WORD_RE.test(name) || name.split(/\s+/).length > 3) return null;
  return name;
}

async function braveNews(query: string): Promise<BraveNewsResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error("BRAVE_API_KEY is not set");
  const params = new URLSearchParams({ q: query, count: "50", freshness: "pm", search_lang: "en" });
  const res = await fetch(`https://api.search.brave.com/res/v1/news/search?${params}`, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Brave news ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { results?: BraveNewsResult[] };
  return data.results ?? [];
}

/** RSS/Atom titles from startup-funding feeds. Regex parse — avoids an XML dependency. */
async function feedTitles(feedUrl: string): Promise<string[]> {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (job-searcher)", Accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const xml = await res.text();
  return Array.from(xml.matchAll(/<item\b[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)).map((m) =>
    m[1]!
      .replace(/&#8217;|&#x27;|&rsquo;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&#\d+;/g, "")
      .trim()
  );
}

export async function fetchFundedCompanies(): Promise<CompanyRef[]> {
  const names = new Set<string>();
  for (const q of FUNDING_NEWS_QUERIES) {
    try {
      for (const r of await braveNews(q)) {
        const name = r.title ? companyFromHeadline(r.title) : null;
        if (name) names.add(name);
      }
    } catch (err) {
      console.warn(`  funding-news "${q}" failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  for (const feed of FUNDING_FEEDS) {
    try {
      for (const title of await feedTitles(feed)) {
        const name = companyFromHeadline(title);
        if (name) names.add(name);
      }
    } catch (err) {
      console.warn(`  funding feed ${feed} failed: ${(err as Error).message}`);
    }
  }
  return Array.from(names).map((name) => ({ name, source: "funding-news" }));
}
