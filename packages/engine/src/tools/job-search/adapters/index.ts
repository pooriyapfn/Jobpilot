import { fetchAshbyJob } from "./ashby.ts";
import { fetchGreenhouseJob } from "./greenhouse.ts";
import { fetchLeverJob } from "./lever.ts";
import { fetchWorkableJob } from "./workable.ts";
import type { AtsJobData } from "../types.ts";

/**
 * Fetch full job data from ATS API.
 *
 * - 404 → returns { exists: false }
 * - Success → returns { exists: true, ...fields }
 * - Network/timeout error → throws (caller marks as unverified)
 * - Unsupported ATS → returns null
 */
export async function fetchJobFromATS(
  url: string
): Promise<AtsJobData | null> {
  const { hostname } = new URL(url);

  if (hostname === "jobs.lever.co") {
    return fetchLeverJob(url);
  }
  if (hostname === "jobs.ashbyhq.com") {
    return fetchAshbyJob(url);
  }
  if (
    hostname === "job-boards.greenhouse.io" ||
    hostname === "boards.greenhouse.io"
  ) {
    return fetchGreenhouseJob(url);
  }

  if (hostname === "apply.workable.com") {
    return fetchWorkableJob(url);
  }

  // Unsupported ATS (SmartRecruiters — no public API we use yet)
  return null;
}

/**
 * Legacy wrapper — returns datePosted only. Preserved for any external consumers.
 */
export async function fetchJobDateFromATS(
  url: string
): Promise<{ datePosted: string; source: "ats-api" } | null> {
  try {
    const result = await fetchJobFromATS(url);
    if (!result || !result.exists || !result.datePosted) return null;
    return { datePosted: result.datePosted, source: "ats-api" };
  } catch {
    return null;
  }
}
