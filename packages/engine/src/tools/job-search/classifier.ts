import { candidate, escapeRe } from "./candidate.ts";
import { ATS_DOMAINS } from "./config.ts";
import { REGIONS, findRegion } from "./regions.ts";
import type {
  Freshness,
  GeographicScope,
  LocationEligibility,
  PageType,
  WorkMode,
} from "./types.ts";

// ── Page type classification ────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSingleJobAtsUrl(hostname: string, segments: string[]): boolean {
  switch (hostname) {
    case "jobs.ashbyhq.com":
    case "jobs.lever.co":
      return segments.length === 2 && UUID_RE.test(segments[1] ?? "");

    case "job-boards.greenhouse.io":
    case "boards.greenhouse.io":
      return segments.length >= 3 && segments[1] === "jobs" && !!segments[2];

    case "jobs.smartrecruiters.com":
      return segments.length === 2 && !!segments[1];

    case "apply.workable.com":
      return segments.length === 3 && segments[1] === "j" && !!segments[2];

    default:
      return false;
  }
}

export function classifyPageType(url: string, jsonLdFound: boolean): PageType {
  try {
    const { hostname, pathname } = new URL(url);
    const segments = pathname.split("/").filter(Boolean);

    if (ATS_DOMAINS.includes(hostname)) {
      return isSingleJobAtsUrl(hostname, segments) ? "ats-job" : "career-index";
    }

    if (jsonLdFound) return "direct-job";

    if (segments.length <= 1 && /^(careers?|jobs?)$/i.test(segments[0] ?? "")) {
      return "career-index";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

// ── Freshness classification ────────────────────────────────────────────────

export function classifyFreshness(datePosted?: string): Freshness {
  if (!datePosted) return "date-unknown";
  const ageHours = (Date.now() - new Date(datePosted).getTime()) / 3_600_000;
  if (isNaN(ageHours)) return "date-unknown";
  if (ageHours <= 24) return "verified-24h";
  if (ageHours <= 168) return "verified-week";
  return "old";
}

// ── Work mode classification ────────────────────────────────────────────────

const HYBRID_PATTERNS = [
  /\bhybrid\b/i,
  /\boffice\s*\/\s*hybrid\b/i,
  /\bdays?\s+(?:per|a)\s+week\s+(?:in|at)\s+(?:the\s+)?office\b/i,
  /\bminimum\s+of\s+\d+\s+days?\s+(?:in|at)\s+(?:the\s+)?office\b/i,
  /\bin.?office\b/i,
  /\boffice.based\b/i,
  /\b\d+\s+days?\s+(?:per\s+)?week\s+(?:working\s+)?from\s+home\b/i,
  /\bregular\s+office\s+attendance\b/i,
  /\bwork\s+from\s+(?:our\s+)?office\b/i,
];

const ONSITE_PATTERNS = [
  /\bon.?site\b/i,
  /\bprimarily\s+on.?site\b/i,
  /\b100%\s+on.?site\b/i,
];

const REMOTE_PATTERNS = [
  /\bfully\s+remote\b/i,
  /\b100%\s+remote\b/i,
  /\bremote.first\b/i,
  /\bwork\s+from\s+(?:anywhere|home)\b/i,
  /\bTELECOMMUTE\b/,
];

/**
 * Classify work mode from all available signals.
 *
 * Priority: ATS structured > JSON-LD jobLocationType > displayed location > body text
 * Hybrid/onsite match always wins over remote (conservative).
 */
export function classifyWorkMode(
  jobLocationType: string | undefined,
  atsWorkplaceType: string | undefined,
  displayedLocation: string,
  bodyText: string,
  title: string
): { mode: WorkMode; evidence: string[] } {
  const evidence: string[] = [];

  // 1. ATS structured workplace type (highest priority)
  if (atsWorkplaceType) {
    const wt = atsWorkplaceType.toLowerCase();
    if (/hybrid/i.test(wt)) {
      evidence.push(`ats-api workplaceType="${atsWorkplaceType}"`);
      return { mode: "hybrid", evidence };
    }
    if (/on.?site|in.?office|onsite/i.test(wt)) {
      evidence.push(`ats-api workplaceType="${atsWorkplaceType}"`);
      return { mode: "onsite", evidence };
    }
    if (/remote/i.test(wt)) {
      evidence.push(`ats-api workplaceType="${atsWorkplaceType}"`);
      return { mode: "remote", evidence };
    }
  }

  // 2. JSON-LD jobLocationType
  if (jobLocationType === "TELECOMMUTE") {
    evidence.push('json-ld jobLocationType="TELECOMMUTE"');
    return { mode: "remote", evidence };
  }

  // 3. Check displayed location + body text + title for hybrid/onsite/remote
  const textSources = [
    { text: displayedLocation, label: "displayedLocation" },
    { text: title, label: "title" },
    { text: bodyText, label: "bodyText" },
  ];

  let hasHybrid = false;
  let hasOnsite = false;
  let hasRemote = false;

  for (const { text, label } of textSources) {
    if (!text) continue;
    for (const pat of HYBRID_PATTERNS) {
      if (pat.test(text)) {
        evidence.push(`${label} matched hybrid: ${pat.source}`);
        hasHybrid = true;
        break;
      }
    }
    for (const pat of ONSITE_PATTERNS) {
      if (pat.test(text)) {
        evidence.push(`${label} matched onsite: ${pat.source}`);
        hasOnsite = true;
        break;
      }
    }
    for (const pat of REMOTE_PATTERNS) {
      if (pat.test(text)) {
        evidence.push(`${label} matched remote: ${pat.source}`);
        hasRemote = true;
        break;
      }
    }
  }

  // Decision: hybrid/onsite wins over remote (conservative)
  if (hasHybrid) return { mode: "hybrid", evidence };
  if (hasOnsite && !hasRemote) return { mode: "onsite", evidence };
  if (hasRemote && !hasOnsite) return { mode: "remote", evidence };
  if (hasOnsite && hasRemote) {
    // Conflict
    evidence.push("conflict: both onsite and remote signals");
    return { mode: "unknown", evidence };
  }

  return { mode: "unknown", evidence };
}

// ── Geographic scope classification ─────────────────────────────────────────

const RESTRICTED_COUNTRIES = [
  "United States", "USA", "US",
  "United Kingdom", "UK",
  "Canada", "India", "France", "Germany",
  "Austria", "Brazil", "Australia", "Ireland",
  "Netherlands", "Poland", "Spain", "Portugal",
  "Switzerland", "Sweden", "Norway", "Denmark",
  "Belgium", "Italy", "Mexico", "Argentina",
  "Colombia", "Chile", "Singapore", "Japan",
  "Israel", "New Zealand", "South Africa", "China",
  "Greece",
];

const WORLDWIDE_PATTERNS = [/\bworldwide\b/i, /\banywhere\b/i, /\bglobal\b/i];
// Safe to evaluate against full body text after all restriction checks. These
// require job-level eligibility wording; a generic "global team" is excluded.
const STRONG_BODY_WORLDWIDE_PATTERNS = [
  /\bopen\s+worldwide\b/i,
  /\b(?:100%\s+|fully\s+)?remote\s*(?:[·,\/\-]\s*)?worldwide\b/i,
  /\bworldwide\s+(?:remote|eligibility)\b/i,
  /\bavailable\s+worldwide\b/i,
  /\bwork(?:ing)?\s+from\s+anywhere\b/i,
];

const AUTHORIZATION_PHRASES = [
  /\bwork\s+authorization\b/i,
  /\bauthorized to work in\b/i,
  /\bsecurity\s+clearance\b/i,
  /\b(active|current)\s+(secret|top secret|TS\/SCI)\s+clearance\b/i,
  /\bno\s+visa\s+sponsor/i,
];

// Restricted-country regexes. The candidate's own country is never "restricted".
function countryRegexes() {
  const own = candidate().names.map((n) => n.toLowerCase());
  const alt = RESTRICTED_COUNTRIES.filter((c) => !own.includes(c.toLowerCase()))
    .sort((a, b) => b.length - a.length) // longer names first
    .map(escapeRe)
    .join("|");
  return {
    countryRe: new RegExp(`\\b(${alt})\\b`, "i"),
    // "Remote (Country)", "Remote - Country", "Remote, Country"
    remoteCountry: new RegExp(`\\bremote\\s*[,(\\-]\\s*(${alt})\\s*\\)?\\b`, "i"),
    // "Country Remote"
    countryRemote: new RegExp(`\\b(${alt})\\s+remote\\b`, "i"),
  };
}

const RESTRICTION_PHRASES = [
  /\bUS[A]? only\b/i,
  /\bUnited States only\b/i,
  /must reside in the (US|United States|U\.S\.)/i,
  /\bUS (East|West) Coast\b/i,
  /\bCanada only\b/i,
  /\bIndia only\b/i,
  /\bUK only\b/i,
  /\bFrance only\b/i,
  /\bGermany only\b/i,
  /\bLATAM only\b/i,
  /open (only )?to (residents|candidates|applicants) (of|in|from) the (US|United States|UK)/i,
  /\banywhere in the US\b/i,
  /\bremote.*US[A]?\s*only\b/i,
  /\bnot\s+eligible\s+to\s+work\s+(outside|in)\b/i,
  /\bmust\s+be\s+based\s+in\b/i,
  /\bcandidates?\s+must\s+(?:reside|be\s+(?:located|based))\s+in\b/i,
  /\bmust\s+(?:reside|live)\s+in\b/i,
  /\bapplicants?\s+must\s+(?:reside|be\s+based|live)\s+in\b/i,
  // "[Country] only"
  /\bAustralia\s+only\b/i,
  /\bAustria\s+only\b/i,
  /\bBrazil\s+only\b/i,
  /\bIreland\s+only\b/i,
  /\bPoland\s+only\b/i,
  /\bSpain\s+only\b/i,
  /\bNetherlands\s+only\b/i,
  /\bGreece\s+only\b/i,
];

const AMBIGUOUS_PATTERNS = [/\bEurope\b/i, /\bEuropean Union\b/i, /\bEU\b/];

/** First candidate region named in `text`. Regions not in REGIONS (custom CANDIDATE_REGIONS) match by name. */
export function openRegionIn(text: string): string | undefined {
  for (const name of candidate().regions) {
    const pattern = findRegion(name)?.pattern ?? new RegExp(`\\b${escapeRe(name)}\\b`, "i");
    if (pattern.test(text)) return name;
  }
  return undefined;
}

export function classifyGeographicScope(
  jobLocation: string[],
  displayedLocation: string,
  bodyText: string,
  title: string
): { scope: GeographicScope; restrictedCountry?: string; region?: string; evidence: string[] } {
  const evidence: string[] = [];
  const { countryRe, remoteCountry, countryRemote } = countryRegexes();
  const locStr = jobLocation.join(" ");

  // Location strings including title — used for restriction checks (title can contain
  // location info like "Remote - US" or "Remote, United States")
  const locationStrings = [locStr, displayedLocation, title].join(" ");

  // Open-scope detection excludes title to prevent "Global Software Engineer" titles
  // from overriding country-specific job locations
  const openScopeStrings = [locStr, displayedLocation].join(" ");

  // Full text for restriction phrase checks
  const fullText = [locStr, displayedLocation, title, bodyText].join(" ");

  // ── Restriction checks first (fail-closed) ──────────────────────────────

  // 1. Authorization/clearance phrases → always reject
  for (const pat of AUTHORIZATION_PHRASES) {
    if (pat.test(fullText)) {
      evidence.push(`authorization phrase: ${pat.source}`);
      return { scope: "specific-country", restrictedCountry: "authorization-required", evidence };
    }
  }

  // 2. Explicit restriction phrases in full text
  for (const pat of RESTRICTION_PHRASES) {
    if (pat.test(fullText)) {
      evidence.push(`restriction phrase: ${pat.source}`);
      return { scope: "specific-country", evidence };
    }
  }

  // 3. "Remote (Country)", "Remote - Country", "Remote, Country" in location+title
  const remoteCountryMatch = remoteCountry.exec(locationStrings);
  if (remoteCountryMatch) {
    const country = remoteCountryMatch[1]!;
    evidence.push(`remote+country pattern: "${remoteCountryMatch[0]}"`);
    return { scope: "specific-country", restrictedCountry: country, evidence };
  }

  // 4. "Country Remote" in location+title
  const countryRemoteMatch = countryRemote.exec(locationStrings);
  if (countryRemoteMatch) {
    const country = countryRemoteMatch[1]!;
    evidence.push(`country+remote pattern: "${countryRemoteMatch[0]}"`);
    return { scope: "specific-country", restrictedCountry: country, evidence };
  }

  // 5. Structural: every jobLocation entry matches a restricted country
  if (jobLocation.length > 0) {
    const allRestricted = jobLocation.every((loc) => countryRe.test(loc));
    if (allRestricted) {
      const matched = jobLocation.map((loc) => {
        const m = countryRe.exec(loc);
        return m ? m[1] : loc;
      });
      evidence.push(`all locations restricted: ${matched.join(", ")}`);
      return { scope: "specific-country", restrictedCountry: matched[0], evidence };
    }
  }

  // 6. Displayed location contains a restricted country
  if (displayedLocation && countryRe.test(displayedLocation)) {
    const m = countryRe.exec(displayedLocation);
    if (m) {
      evidence.push(`displayed location has restricted country: ${m[1]}`);
      return { scope: "specific-country", restrictedCountry: m[1], evidence };
    }
  }

  // ── Open-scope signals (only after all restrictions pass) ────────────────
  // Checked against openScopeStrings (no title) to avoid false positives like
  // "Global Software Engineer" overriding a US-only job location.

  // 7. Candidate's own country in location strings (title included — it's meaningful there)
  const home = candidate().names.find((n) => new RegExp(`\\b${escapeRe(n)}\\b`, "i").test(locationStrings));
  if (home) {
    evidence.push(`home country in location: ${home}`);
    return { scope: "home", evidence };
  }

  // Strong job-level worldwide statements may live in the description rather
  // than the location element (for example, "100% Remote / Open worldwide").
  for (const pat of STRONG_BODY_WORLDWIDE_PATTERNS) {
    if (pat.test(bodyText)) {
      evidence.push(`strong worldwide body signal: ${pat.source}`);
      return { scope: "worldwide", evidence };
    }
  }

  // 8. Worldwide/anywhere/global in location strings (no title)
  for (const pat of WORLDWIDE_PATTERNS) {
    if (pat.test(openScopeStrings)) {
      evidence.push(`worldwide signal: ${pat.source}`);
      return { scope: "worldwide", evidence };
    }
  }

  // 9. A hiring region open to the candidate (CANDIDATE_REGIONS / derived from country), e.g. "Europe / MENA"
  const open = openRegionIn(openScopeStrings);
  if (open) {
    evidence.push(`open region in location: ${open}`);
    return { scope: "region", region: open, evidence };
  }

  // 10. Europe/EU the candidate isn't clearly inside → uncertain (LLM judges)
  if (AMBIGUOUS_PATTERNS.some((p) => p.test(openScopeStrings))) {
    evidence.push("ambiguous EU/Europe signal");
    return { scope: "unknown", evidence };
  }

  // 11. Only regions the candidate is outside of ("Remote — LATAM" for a candidate in Turkey). Needs a known country.
  const closed = candidate().country ? REGIONS.find((r) => r.pattern.test(openScopeStrings)) : undefined;
  if (closed) {
    evidence.push(`region outside candidate's: ${closed.name}`);
    return { scope: "specific-country", restrictedCountry: closed.name, evidence };
  }

  // No deterministic signal → unknown
  return { scope: "unknown", evidence };
}

// ── Legacy location eligibility (still used for backward-compat field) ──────

/**
 * Map GeographicScope to LocationEligibility for backward compatibility.
 */
export function scopeToLocationEligibility(scope: GeographicScope): LocationEligibility {
  switch (scope) {
    case "home":
      return "home-ok";
    case "worldwide":
    case "region":
      return "eligible";
    case "specific-country":
      return "restricted";
    case "unknown":
      return "uncertain";
  }
}

/**
 * @deprecated Use classifyGeographicScope + scopeToLocationEligibility instead.
 * Kept for any external consumers.
 */
export function classifyLocationEligibility(
  jobLocation: string[],
  descriptionText: string
): LocationEligibility {
  const result = classifyGeographicScope(jobLocation, "", descriptionText, "");
  return scopeToLocationEligibility(result.scope);
}
