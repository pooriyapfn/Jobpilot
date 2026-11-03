// Job aggregators: RemoteOK (public API), Himalayas (public search API), Wellfound (Brave search results —
// Wellfound has no public API and sits behind a bot check, so we never fetch it ourselves).
//
// Each listing is matched to the same job on the company's own Greenhouse/Lever/Ashby/Workable board:
// that page holds the full application form, so prepare/fill can work on it directly. Unmatched listings
// keep the aggregator URL plus the API data (`listing`); prepare follows its "Apply" link, or hands it
// to your Chrome when the site needs a login or blocks the background browser.

import { candidate } from "../candidate.ts";
import { isExcluded } from "../filters.ts";
import type { AggregatorListing } from "../types.ts";
import { classifyGeographicScope } from "../classifier.ts";
import { isRelevantTitle, sourceMaxAgeDays, toSourceJobs, type BoardJob, type SourceJob } from "./boards.ts";
import { findEmployerPostings } from "./company-boards.ts";

const UA = { "User-Agent": "Mozilla/5.0 (job-searcher)", Accept: "application/json" };

export interface Listing {
  title: string;
  company: string;
  /** The aggregator's page for the job */
  url: string;
  listing: AggregatorListing;
  /** Employer ATS link found in the description, if any */
  atsLink?: string;
}

const ATS_LINK_RE =
  /https:\/\/(?:jobs\.ashbyhq\.com|jobs\.lever\.co|boards\.greenhouse\.io|job-boards\.greenhouse\.io|apply\.workable\.com)\/[^\s"'<>)]+/i;

const isRecent = (iso: string | undefined) =>
  !iso || Date.now() - Date.parse(iso) <= sourceMaxAgeDays() * 86_400_000;

/** Listings → SourceJobs: the employer's own posting when found, else the aggregator page + its data. */
export interface Resolved {
  jobs: SourceJob[];
  /** Listings found on the employer's own board */
  matched: number;
  /** …of which the employer's posting itself rules out (onsite, older than the window, other country) */
  dropped: number;
}

export async function resolveListings(listings: Listing[], via: string): Promise<Resolved> {
  // An ATS link in the description is the exact posting; only the rest need a board lookup
  const lookup = listings.filter((l) => !l.atsLink || isExcluded(l.atsLink));
  const found = await findEmployerPostings(lookup, via);
  const matches = new Map(lookup.map((l, i) => [l, found[i]]));
  const now = new Date().toISOString();
  let matched = 0, dropped = 0;
  const jobs = listings.flatMap((l): SourceJob[] => {
    const tags = [`source:${via}`, `company:${l.company}`, `via:${l.url}`];
    if (l.atsLink && !isExcluded(l.atsLink)) {
      matched++;
      return [{ title: `${l.title} — ${l.company}`, url: l.atsLink, description: "", extraSnippets: tags, sourceDomain: new URL(l.atsLink).hostname, discoveredAt: now }];
    }
    const posting: BoardJob | undefined = matches.get(l);
    if (posting) {
      matched++;
      // The employer's posting is the truth: aggregators often re-list onsite or old jobs as "remote"
      const kept = toSourceJobs([posting], l.company, via).map((j) => ({ ...j, extraSnippets: [...j.extraSnippets, `via:${l.url}`] }));
      if (!kept.length) dropped++;
      return kept;
    }
    return [{
      title: `${l.title} — ${l.company}`,
      url: l.url,
      description: (l.listing.description ?? "").slice(0, 300),
      extraSnippets: tags,
      sourceDomain: new URL(l.url).hostname,
      discoveredAt: now,
      listing: l.listing,
    }];
  });
  return { jobs, matched, dropped };
}

export const resolvedNote = (listings: number, r: Resolved) =>
  `${listings} relevant listings, ${r.matched} on the employer's own board` +
  (r.dropped ? ` (${r.dropped} dropped: the employer's posting is onsite, old or restricted)` : "");

// ── RemoteOK ─────────────────────────────────────────────────────────────────
// https://remoteok.com/api — terms: credit Remote OK and link back to the job's Remote OK page
// (kept as `via:` on every job, shown as its source).

interface RemoteOkJob {
  date?: string;
  company?: string;
  position?: string;
  location?: string;
  description?: string;
  url?: string;
}

export function remoteOkListings(api: unknown[]): Listing[] {
  return (api.slice(1) as RemoteOkJob[]) // [0] is the legal notice
    .filter((j) => j.position && j.company && j.url && isRelevantTitle(j.position) && isRecent(j.date))
    .flatMap((j): Listing[] => {
      const location = j.location?.trim() ?? "";
      // RemoteOK's location is free text: an office ("Palo Alto") or a scope ("Worldwide", "Europe")
      if (location && classifyGeographicScope([location], location, "", j.position!).scope === "specific-country") return [];
      const description = (j.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return [{
        title: j.position!,
        company: j.company!,
        url: j.url!.replace("remoteOK.com", "remoteok.com"),
        atsLink: j.description?.match(ATS_LINK_RE)?.[0],
        listing: {
          via: "remoteok",
          company: j.company,
          datePosted: j.date,
          applicantLocations: /^(worldwide|anywhere|remote)?$/i.test(location) ? undefined : [location],
          remote: true,
          description: [location && `Location: ${location}`, description.slice(0, 2000)].filter(Boolean).join("\n"),
        },
      }];
    });
}

export async function fetchRemoteOk(): Promise<{ jobs: SourceJob[]; note: string }> {
  const res = await fetch("https://remoteok.com/api", { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`RemoteOK ${res.status}`);
  const listings = remoteOkListings((await res.json()) as unknown[]);
  const r = await resolveListings(listings, "remoteok");
  return { jobs: r.jobs, note: resolvedNote(listings.length, r) };
}

// ── Himalayas ────────────────────────────────────────────────────────────────
// https://himalayas.app/jobs/api/search — `country` returns jobs open to that country; locationRestrictions
// lists who may apply ([] = worldwide).

export const HIMALAYAS_QUERIES = ["software engineer", "AI engineer", "full stack engineer", "founding engineer", "backend engineer"];
const HIMALAYAS_PAGES = 3; // 20 jobs per page, newest first

interface HimalayasJob {
  title?: string;
  companyName?: string;
  description?: string;
  excerpt?: string;
  pubDate?: number;
  locationRestrictions?: string[];
  applicationLink?: string;
  guid?: string;
}

export function himalayasListings(jobs: HimalayasJob[]): Listing[] {
  return jobs
    .filter((j) => j.title && j.companyName && (j.guid || j.applicationLink) && isRelevantTitle(j.title))
    .map((j) => {
      const datePosted = j.pubDate ? new Date(j.pubDate * 1000).toISOString() : undefined;
      const url = (j.guid ?? j.applicationLink!).replace(/\?.*$/, "");
      const text = (j.description ?? j.excerpt ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return {
        title: j.title!,
        company: j.companyName!,
        url,
        atsLink: j.description?.match(ATS_LINK_RE)?.[0],
        listing: {
          via: "himalayas" as const,
          company: j.companyName,
          datePosted,
          applicantLocations: j.locationRestrictions ?? [],
          remote: true, // Himalayas only lists remote jobs
          description: text.slice(0, 2000),
        },
      };
    })
    .filter((l) => isRecent(l.listing.datePosted));
}

export async function fetchHimalayas(): Promise<{ jobs: SourceJob[]; note: string }> {
  const { country } = candidate();
  const seen = new Set<string>();
  const all: Listing[] = [];
  for (const q of HIMALAYAS_QUERIES) {
    for (let page = 0; page < HIMALAYAS_PAGES; page++) {
      const params = new URLSearchParams({ q, sort: "recent", offset: String(page * 20), limit: "20" });
      // Jobs open to your country (includes worldwide); without a country: worldwide-only
      if (country) params.set("country", country);
      else params.set("worldwide", "true");
      const res = await fetch(`https://himalayas.app/jobs/api/search?${params}`, { headers: UA, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Himalayas ${res.status}`);
      const batch = ((await res.json()) as { jobs?: HimalayasJob[] }).jobs ?? [];
      const listings = himalayasListings(batch).filter((l) => !seen.has(l.url) && seen.add(l.url));
      all.push(...listings);
      // Newest first: stop paging once a page is entirely older than the window
      const newest = Math.max(...batch.map((j) => j.pubDate ?? 0)) * 1000;
      if (batch.length < 20 || !isRecent(new Date(newest).toISOString())) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const r = await resolveListings(all, "himalayas");
  return { jobs: r.jobs, note: resolvedNote(all.length, r) };
}

// ── Wellfound (via Brave results) ────────────────────────────────────────────

export const WELLFOUND_QUERIES = [
  `site:wellfound.com/jobs engineer remote`,
  `site:wellfound.com/jobs "AI engineer"`,
  `site:wellfound.com/jobs "founding engineer"`,
  `site:wellfound.com/jobs "software engineer" remote`,
];

/** "Senior AI Engineer at Niuro • Remote • Remote (Work from Home) | Wellfound" → title, company, places */
export function parseWellfoundTitle(text: string): { title: string; company: string; places: string[]; remote: boolean } | null {
  const [head, ...places] = text.replace(/\s*\|\s*Wellfo\w*\s*$/i, "").split(/\s+•\s+/);
  const at = head?.lastIndexOf(" at ") ?? -1;
  if (!head || at <= 0) return null;
  const company = head.slice(at + 4).trim();
  const title = head.slice(0, at).trim();
  if (!title || !company || /^confidential company$/i.test(company)) return null;
  return { title, company, places: places.map((p) => p.trim()).filter(Boolean), remote: places.some((p) => /remote/i.test(p)) || /remote/i.test(title) };
}

export function wellfoundListings(results: Array<{ url: string; title: string; description?: string }>): Listing[] {
  const out: Listing[] = [];
  for (const r of results) {
    if (!/^https:\/\/(www\.)?wellfound\.com\/jobs\/\d+/.test(r.url)) continue;
    const p = parseWellfoundTitle(r.title);
    if (!p || !isRelevantTitle(p.title)) continue;
    const offices = p.places.filter((x) => !/remote/i.test(x));
    out.push({
      title: p.title,
      company: p.company,
      url: r.url.replace(/\?.*$/, ""),
      listing: {
        via: "wellfound",
        company: p.company,
        remote: p.remote,
        // Office cities aren't an applicant restriction — leave eligibility to the description / AI check
        description: [offices.length ? `Offices: ${offices.join(", ")}` : "", p.remote ? "Remote (Work from Home)" : "", r.description ?? ""]
          .filter(Boolean)
          .join("\n"),
      },
    });
  }
  return out;
}
