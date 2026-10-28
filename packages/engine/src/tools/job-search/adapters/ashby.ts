// Ashby public job board API (no auth required)
// GET https://api.ashbyhq.com/posting-api/job-board/{company}
// Returns: { jobs: [{ id, title, location, publishedAt, isRemote, workplaceType, descriptionPlain, ... }] }
// Lists only open, listed postings — an id missing from the board means closed/unlisted.
// (The older POST /jobPosting.info endpoint now returns 401.)

import type { AtsJobData } from "../types.ts";

const FETCH_TIMEOUT_MS = 8_000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export async function fetchAshbyJob(url: string): Promise<AtsJobData> {
  const { hostname, pathname } = new URL(url);
  if (hostname !== "jobs.ashbyhq.com") {
    throw new Error(`Not an Ashby URL: ${url}`);
  }

  const segments = pathname.split("/").filter(Boolean);
  const company = segments[0]; // /{company}/{uuid}
  const id = segments[1];
  if (!company || !id) {
    throw new Error(`Invalid Ashby URL path: ${pathname}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company)}`,
      { signal: controller.signal, headers: { Accept: "application/json" } }
    );

    if (res.status === 404) {
      return { exists: false };
    }
    if (!res.ok) {
      throw new Error(`Ashby API ${res.status}`);
    }

    const data = (await res.json()) as { jobs?: Array<Record<string, unknown>> };
    const job = data.jobs?.find((j) => j["id"] === id);
    if (!job) {
      return { exists: false };
    }

    // Prefer workplaceType (Remote / Hybrid / OnSite); isRemote is also true for hybrid-with-remote-option
    let workplaceType: string | undefined;
    const wt = str(job["workplaceType"])?.toLowerCase();
    if (wt === "remote") workplaceType = "remote";
    else if (wt === "hybrid") workplaceType = "hybrid";
    else if (wt === "onsite" || wt === "on_site") workplaceType = "onsite";
    else if (job["isRemote"] === true) workplaceType = "remote";
    else if (job["isRemote"] === false) workplaceType = "onsite";
    // Some boards leave both flags null and only say "Remote, Global" in the location
    else if (/remote/i.test(str(job["location"]) ?? "")) workplaceType = "remote";

    const secondary = Array.isArray(job["secondaryLocations"])
      ? (job["secondaryLocations"] as Array<Record<string, unknown>>)
          .map((s) => str(s["location"]))
          .filter((s): s is string => !!s)
      : [];
    const primary = str(job["location"]);
    const location = [primary, ...secondary].filter(Boolean).join("; ") || undefined;

    return {
      exists: true,
      title: str(job["title"]),
      company: str(job["department"]),
      location,
      workplaceType,
      description: str(job["descriptionPlain"]),
      datePosted: str(job["publishedAt"]),
    };
  } finally {
    clearTimeout(timer);
  }
}
