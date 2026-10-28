// Lever public REST API (no auth required)
// GET https://api.lever.co/v0/postings/{company}/{id}
// Returns: { createdAt, text, categories, workplaceType, descriptionPlain, ... }

import type { AtsJobData } from "../types.ts";

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchLeverJob(url: string): Promise<AtsJobData> {
  const { hostname, pathname } = new URL(url);
  if (hostname !== "jobs.lever.co") {
    throw new Error(`Not a Lever URL: ${url}`);
  }

  const segments = pathname.split("/").filter(Boolean);
  const company = segments[0];
  const id = segments[1];
  if (!company || !id) {
    throw new Error(`Invalid Lever URL path: ${pathname}`);
  }

  const apiUrl = `https://api.lever.co/v0/postings/${company}/${id}`;
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
      throw new Error(`Lever API ${res.status}`);
    }

    const data = (await res.json()) as Record<string, unknown>;

    const createdAt = data["createdAt"];
    const datePosted =
      typeof createdAt === "number"
        ? new Date(createdAt).toISOString()
        : undefined;

    const categories = data["categories"] as Record<string, unknown> | undefined;
    const location =
      typeof categories?.["location"] === "string"
        ? (categories["location"] as string)
        : undefined;

    // workplaceType: "remote", "onsite", "hybrid", or undefined
    const workplaceType =
      typeof data["workplaceType"] === "string"
        ? (data["workplaceType"] as string)
        : undefined;

    const title =
      typeof data["text"] === "string" ? (data["text"] as string) : undefined;

    const descriptionPlain =
      typeof data["descriptionPlain"] === "string"
        ? (data["descriptionPlain"] as string)
        : undefined;

    return {
      exists: true,
      title,
      company,
      location,
      workplaceType,
      description: descriptionPlain,
      datePosted,
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
