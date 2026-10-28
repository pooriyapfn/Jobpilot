// Workable public API (no auth required)
// GET https://apply.workable.com/api/v2/accounts/{company}/jobs/{shortcode}
// Returns: { title, remote, workplace, location, published, description, ... }

import type { AtsJobData } from "../types.ts";

const FETCH_TIMEOUT_MS = 8_000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export async function fetchWorkableJob(url: string): Promise<AtsJobData> {
  const { hostname, pathname } = new URL(url);
  if (hostname !== "apply.workable.com") {
    throw new Error(`Not a Workable URL: ${url}`);
  }

  const segments = pathname.split("/").filter(Boolean); // /{company}/j/{shortcode}
  const company = segments[0];
  const shortcode = segments[2];
  if (!company || segments[1] !== "j" || !shortcode) {
    throw new Error(`Invalid Workable URL path: ${pathname}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(company)}/jobs/${encodeURIComponent(shortcode)}`,
      { signal: controller.signal, headers: { Accept: "application/json" } }
    );

    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new Error(`Workable API ${res.status}`);

    const data = (await res.json()) as Record<string, unknown>;
    if (data["state"] && data["state"] !== "published") return { exists: false };

    const loc = (data["location"] ?? {}) as Record<string, unknown>;
    const location = [str(loc["city"]), str(loc["region"]), str(loc["country"])]
      .filter(Boolean)
      .join(", ") || undefined;

    // workplace: "remote" | "hybrid" | "on_site"
    const workplace = str(data["workplace"]);
    const workplaceType = workplace ?? (data["remote"] === true ? "remote" : undefined);

    const html = [str(data["description"]), str(data["requirements"]), str(data["benefits"])]
      .filter(Boolean)
      .join("\n");
    const description = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;

    return {
      exists: true,
      title: str(data["title"]),
      company,
      location,
      workplaceType,
      description,
      datePosted: str(data["published"]),
    };
  } finally {
    clearTimeout(timer);
  }
}
