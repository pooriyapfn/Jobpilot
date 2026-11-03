// Who the job search is for. Set in .env.local (CANDIDATE_COUNTRY, CANDIDATE_CITY, CANDIDATE_COUNTRY_ALIASES,
// CANDIDATE_REGIONS). Read on every call, so tests and the app can change it at runtime.

import { findRegion, regionsForCountry } from "./regions.ts";

const KNOWN_ALIASES: Record<string, string[]> = {
  turkey: ["Türkiye", "Turkiye"],
};

export type Candidate = {
  country?: string;
  city?: string;
  /** Country name plus aliases, e.g. ["Turkey", "Türkiye", "Turkiye"] */
  names: string[];
  /** Hiring regions open to the candidate, e.g. ["EMEA", "MENA"]. CANDIDATE_REGIONS, else derived from country. */
  regions: string[];
};

export const candidate = (): Candidate => {
  const country = process.env.CANDIDATE_COUNTRY?.trim() || undefined;
  const city = process.env.CANDIDATE_CITY?.trim() || undefined;
  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const extra = list(process.env.CANDIDATE_COUNTRY_ALIASES);
  const names = country ? [country, ...(KNOWN_ALIASES[country.toLowerCase()] ?? []), ...extra] : [];
  const explicit = list(process.env.CANDIDATE_REGIONS).map((r) => findRegion(r)?.name ?? r);
  const regions = explicit.length ? explicit : regionsForCountry(names);
  return { country, city, names, regions };
};

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
