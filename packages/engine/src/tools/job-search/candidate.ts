// Who the job search is for. Set in .env.local (CANDIDATE_COUNTRY, CANDIDATE_CITY, CANDIDATE_COUNTRY_ALIASES).
// Read on every call, so tests and the app can change it at runtime.

const KNOWN_ALIASES: Record<string, string[]> = {
  turkey: ["Türkiye", "Turkiye"],
};

export type Candidate = {
  country?: string;
  city?: string;
  /** Country name plus aliases, e.g. ["Turkey", "Türkiye", "Turkiye"] */
  names: string[];
};

export const candidate = (): Candidate => {
  const country = process.env.CANDIDATE_COUNTRY?.trim() || undefined;
  const city = process.env.CANDIDATE_CITY?.trim() || undefined;
  const extra = (process.env.CANDIDATE_COUNTRY_ALIASES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const names = country ? [country, ...(KNOWN_ALIASES[country.toLowerCase()] ?? []), ...extra] : [];
  return { country, city, names };
};

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
