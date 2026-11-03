// Hiring regions that job posts name ("Remote — EMEA", "Europe / MENA") and the countries in them.
// The candidate's open regions are derived from CANDIDATE_COUNTRY, or set with CANDIDATE_REGIONS.

export interface Region {
  name: string;
  pattern: RegExp;
  countries: string[];
}

const EUROPE = [
  "Albania", "Andorra", "Austria", "Belarus", "Belgium", "Bosnia and Herzegovina", "Bulgaria", "Croatia",
  "Czech Republic", "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary",
  "Iceland", "Ireland", "Italy", "Kosovo", "Latvia", "Liechtenstein", "Lithuania", "Luxembourg", "Malta",
  "Moldova", "Monaco", "Montenegro", "Netherlands", "North Macedonia", "Norway", "Poland", "Portugal",
  "Romania", "San Marino", "Serbia", "Slovakia", "Slovenia", "Spain", "Sweden", "Switzerland", "Ukraine",
  "United Kingdom", "UK", "Cyprus",
];
// Transcontinental: inside EMEA but not reliably "Europe" in a job post → that stays for the LLM to judge.
const EUROPE_EDGE = ["Turkey", "Türkiye", "Turkiye", "Georgia", "Armenia", "Azerbaijan", "Russia"];
const MENA = [
  "Algeria", "Bahrain", "Egypt", "Iran", "Iraq", "Israel", "Jordan", "Kuwait", "Lebanon", "Libya", "Morocco",
  "Oman", "Palestine", "Qatar", "Saudi Arabia", "Syria", "Tunisia", "Turkey", "Türkiye", "Turkiye",
  "United Arab Emirates", "UAE", "Yemen",
];
const AFRICA = [
  "Algeria", "Angola", "Benin", "Botswana", "Cameroon", "Egypt", "Ethiopia", "Ghana", "Ivory Coast", "Kenya",
  "Libya", "Morocco", "Mozambique", "Namibia", "Nigeria", "Rwanda", "Senegal", "South Africa", "Tanzania",
  "Tunisia", "Uganda", "Zambia", "Zimbabwe",
];
const LATAM = [
  "Argentina", "Bolivia", "Brazil", "Chile", "Colombia", "Costa Rica", "Cuba", "Dominican Republic", "Ecuador",
  "El Salvador", "Guatemala", "Honduras", "Mexico", "Nicaragua", "Panama", "Paraguay", "Peru", "Puerto Rico",
  "Uruguay", "Venezuela",
];
const NORTH_AMERICA = ["United States", "USA", "US", "Canada", "Mexico"];
const APAC = [
  "Australia", "Bangladesh", "Cambodia", "China", "Hong Kong", "India", "Indonesia", "Japan", "Malaysia",
  "Nepal", "New Zealand", "Pakistan", "Philippines", "Singapore", "South Korea", "Korea", "Sri Lanka",
  "Taiwan", "Thailand", "Vietnam",
];

export const REGIONS: Region[] = [
  { name: "EMEA", pattern: /\bEMEA\b/i, countries: [...EUROPE, ...EUROPE_EDGE, ...MENA, ...AFRICA] },
  { name: "MENA", pattern: /\bMENA\b|\bMiddle\s+East\b/i, countries: MENA },
  { name: "Europe", pattern: /\bEurope\b|\bEuropean\s+Union\b|\bEU\b/, countries: EUROPE },
  { name: "Africa", pattern: /\bAfrica\b/i, countries: AFRICA },
  { name: "LATAM", pattern: /\bLATAM\b|\bLatin\s+America\b|\bSouth\s+America\b/i, countries: LATAM },
  { name: "North America", pattern: /\bNorth\s+America\b/i, countries: NORTH_AMERICA },
  { name: "Americas", pattern: /\bAmericas\b/i, countries: [...NORTH_AMERICA, ...LATAM] },
  { name: "APAC", pattern: /\bAPAC\b|\bAsia[-\s]Pacific\b/i, countries: APAC },
];

/** Regions containing any of the candidate's country names. */
export function regionsForCountry(names: string[]): string[] {
  const own = names.map((n) => n.toLowerCase());
  return REGIONS.filter((r) => r.countries.some((c) => own.includes(c.toLowerCase()))).map((r) => r.name);
}

export const findRegion = (name: string): Region | undefined =>
  REGIONS.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
