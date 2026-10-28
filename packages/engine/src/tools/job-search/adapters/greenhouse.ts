// Greenhouse public boards API (no auth required)
// GET https://boards-api.greenhouse.io/v1/boards/{company}/jobs/{id}
// Returns: { title, location.name, content (HTML), updated_at, metadata[], ... }
// Note: Greenhouse doesn't expose a createdAt/publishedAt, so updated_at is used as proxy.

import type { AtsJobData } from "../types.ts";

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchGreenhouseJob(url: string): Promise<AtsJobData> {
  const { hostname, pathname } = new URL(url);
  if (
    hostname !== "job-boards.greenhouse.io" &&
    hostname !== "boards.greenhouse.io"
  ) {
    throw new Error(`Not a Greenhouse URL: ${url}`);
  }

  // /{company}/jobs/{id}
  const segments = pathname.split("/").filter(Boolean);
  const company = segments[0];
  const jobsIdx = segments.indexOf("jobs");
  const id = jobsIdx !== -1 ? segments[jobsIdx + 1] : undefined;
  if (!company || !id) {
    throw new Error(`Invalid Greenhouse URL path: ${pathname}`);
  }

  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${id}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);

    if (res.status === 404) {
      return { exists: false };
    }
    if (!res.ok) {
      throw new Error(`Greenhouse API ${res.status}`);
    }

    const data = (await res.json()) as Record<string, unknown>;

    // Greenhouse exposes only updated_at, not a reliable original posting date.
    // Store as lastUpdated so freshness classifiers don't treat edits as new posts.
    const updatedAt = data["updated_at"];
    const lastUpdated =
      typeof updatedAt === "string" ? updatedAt : undefined;

    const title =
      typeof data["title"] === "string"
        ? (data["title"] as string)
        : undefined;

    const locationObj = data["location"] as Record<string, unknown> | undefined;
    const location =
      typeof locationObj?.["name"] === "string"
        ? (locationObj["name"] as string)
        : undefined;

    // Greenhouse stores workplace type in metadata array
    // e.g. [{ id: ..., name: "Employment Type", value: "Remote" }]
    let workplaceType: string | undefined;
    const metadata = data["metadata"] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(metadata)) {
      for (const meta of metadata) {
        const name = meta["name"];
        const value = meta["value"];
        if (typeof name === "string" && typeof value === "string") {
          const nameL = name.toLowerCase();
          if (
            nameL.includes("workplace") ||
            nameL.includes("work type") ||
            nameL.includes("remote")
          ) {
            workplaceType = value.toLowerCase();
            break;
          }
        }
      }
    }

    // Greenhouse content field is HTML description
    const content =
      typeof data["content"] === "string"
        ? (data["content"] as string)
        : undefined;

    return {
      exists: true,
      title,
      company,
      location,
      workplaceType,
      description: content,
      lastUpdated,
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
