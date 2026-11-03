// Career pages on non-ATS sites (recruiting agencies, small companies) that post jobs with JSON-LD.
// Verify registers a site when one of its pages turns out to be a real remote job; each search run
// then reads the site's job index and returns only links it hasn't returned before.

import { mkdir, readFile, writeFile } from "fs/promises";
import { WATCHED_SITE_SEEDS } from "../config.ts";
import { isExcluded } from "../filters.ts";
import { OUTPUT_DIR } from "../paths.ts";
import { isRelevantTitle, mapLimit, type SourceJob } from "./boards.ts";

interface Site {
  addedAt: string;
  /** Last time verify found a live job on it */
  lastJobAt?: string;
  /** Job links already handed to verify */
  seen: string[];
}

const PATH = `${OUTPUT_DIR}watched-sites.json`;
const TTL_DAYS = 90; // drop a site after this long without a live job
const MAX_SEEN = 500;
const MAX_LINKS_PER_SITE = 40;

async function load(): Promise<Record<string, Site>> {
  try {
    return JSON.parse(await readFile(PATH, "utf8")) as Record<string, Site>;
  } catch {
    return {};
  }
}

async function save(sites: Record<string, Site>): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(PATH, JSON.stringify(sites, null, 2), "utf8");
}

/** https://acme.com/jobs/AR-1/ → https://acme.com/jobs/  (null when the job sits at the site root) */
export function indexUrlFor(jobUrl: string): string | null {
  try {
    const u = new URL(jobUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return `${u.origin}/${parts.slice(0, -1).join("/")}/`;
  } catch {
    return null;
  }
}

/** Register the sites behind these confirmed job pages. Returns how many were new. */
export async function watchSites(jobUrls: string[]): Promise<number> {
  const sites = await load();
  const now = new Date().toISOString();
  let added = 0;
  for (const url of jobUrls) {
    const index = indexUrlFor(url);
    if (!index || isExcluded(url)) continue;
    const site = sites[index];
    if (site) {
      site.lastJobAt = now;
    } else {
      sites[index] = { addedAt: now, lastJobAt: now, seen: [url] };
      added++;
    }
  }
  await save(sites);
  return added;
}

const clean = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Job links under the index path, with a title from the card's heading (or its text). */
export function jobLinks(html: string, indexUrl: string): Array<{ url: string; title: string }> {
  const index = new URL(indexUrl);
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(m[1]!, index);
    } catch {
      continue;
    }
    if (url.host !== index.host || !url.pathname.startsWith(index.pathname)) continue;
    if (url.pathname.replace(/\/$/, "") === index.pathname.replace(/\/$/, "")) continue;
    const heading = m[2]!.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1];
    const title = clean(heading ?? m[2]!).slice(0, 140);
    const key = `${url.origin}${url.pathname}`;
    if (!out.has(key) || (!out.get(key) && title)) out.set(key, title);
  }
  return Array.from(out, ([url, title]) => ({ url, title })).slice(0, MAX_LINKS_PER_SITE);
}

export async function fetchWatchedSites(): Promise<{ jobs: SourceJob[]; note: string }> {
  const sites = await load();
  const now = new Date().toISOString();
  for (const seed of WATCHED_SITE_SEEDS) sites[seed] ??= { addedAt: now, seen: [] };
  for (const [index, s] of Object.entries(sites)) {
    const last = Date.parse(s.lastJobAt ?? s.addedAt);
    if (!WATCHED_SITE_SEEDS.includes(index) && Date.now() - last > TTL_DAYS * 86_400_000) delete sites[index];
  }

  const perSite = await mapLimit(Object.entries(sites), 4, async ([index, site]) => {
    try {
      const res = await fetch(index, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; JobVerifier/1.0)", Accept: "text/html" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return [];
      const links = jobLinks(await res.text(), index).filter((l) => !site.seen.includes(l.url));
      site.seen = [...site.seen, ...links.map((l) => l.url)].slice(-MAX_SEEN);
      const host = new URL(index).hostname;
      // Untitled links go through — verify reads the title from the page
      return links
        .filter((l) => !l.title || isRelevantTitle(l.title))
        .map((l): SourceJob => ({
          title: l.title,
          url: l.url,
          description: "",
          extraSnippets: [`source:watched-site`, `site:${index}`],
          sourceDomain: host,
          discoveredAt: now,
        }));
    } catch {
      return [];
    }
  });

  await save(sites);
  const jobs = perSite.flat();
  return { jobs, note: `${Object.keys(sites).length} sites, ${jobs.length} new links` };
}
