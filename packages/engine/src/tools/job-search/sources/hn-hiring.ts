// Hacker News "Ask HN: Who is hiring?" — monthly thread, mostly VC-backed startups.
// Algolia HN API, no auth. Top-level comment = one company's posting.

import { ROLE_TITLE_EXCLUDE, ROLE_TITLE_INCLUDE } from "../config.ts";
import type { SourceJob } from "./boards.ts";

interface HnItem {
  id: number;
  text?: string | null;
  children?: HnItem[];
  created_at?: string;
}

const decode = (html: string) =>
  html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>[^<]*<\/a>/g, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const URL_RE = /https?:\/\/[^\s<>")]+/g;
const REMOTE_RE = /\bremote\b/i;
const US_ONLY_RE = /remote\s*\(?\s*(us|usa|u\.s\.)\b|us[- ]only|must be (located )?in the (us|u\.s\.)/i;
const HN_HOST_RE = /(^|\.)(ycombinator\.com|news\.ycombinator\.com)$/;

export async function fetchHnHiring(): Promise<SourceJob[]> {
  // Latest thread posted by the whoishiring bot
  const search = await fetch(
    "https://hn.algolia.com/api/v1/search_by_date?query=%22Ask%20HN%3A%20Who%20is%20hiring%22&tags=story,author_whoishiring&hitsPerPage=5",
    { signal: AbortSignal.timeout(20_000) }
  );
  const hits = ((await search.json()) as { hits: Array<{ objectID: string; title: string }> }).hits;
  const thread = hits.find((h) => /who is hiring/i.test(h.title) && !/freelancer|wants to be hired/i.test(h.title));
  if (!thread) return [];

  const res = await fetch(`https://hn.algolia.com/api/v1/items/${thread.objectID}`, {
    signal: AbortSignal.timeout(60_000),
  });
  const root = (await res.json()) as HnItem;

  const now = new Date().toISOString();
  const jobs: SourceJob[] = [];

  for (const c of root.children ?? []) {
    if (!c.text) continue;
    const text = decode(c.text);
    if (!REMOTE_RE.test(text) || US_ONLY_RE.test(text)) continue;

    // Header line convention: "Company | Role | Location | REMOTE | ..."
    const header = text.slice(0, 220);
    const roleFields = header.split("|").slice(1, 4).join(" ");
    if (!ROLE_TITLE_INCLUDE.test(roleFields) || ROLE_TITLE_EXCLUDE.test(roleFields)) continue;

    const urls = (text.match(URL_RE) ?? [])
      .map((u) => u.replace(/[.,;)]+$/, ""))
      .filter((u) => {
        try {
          const { hostname, pathname } = new URL(u);
          // Homepages can't be job pages — verify would just reject them as career-index
          return !HN_HOST_RE.test(hostname) && pathname.replace(/\//g, "") !== "";
        } catch {
          return false;
        }
      });
    const url = urls[0];
    if (!url) continue;

    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch {
      continue;
    }
    jobs.push({
      title: header.split("|").slice(0, 2).join(" | ").trim() || header,
      url,
      description: text.slice(0, 500),
      extraSnippets: [`source:hn-hiring`, `hn:https://news.ycombinator.com/item?id=${c.id}`],
      sourceDomain: domain,
      discoveredAt: now,
    });
  }
  return jobs;
}
