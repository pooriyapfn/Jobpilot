import type { Salary } from "./types.ts";

/**
 * Check if a JSON-LD node has @type "JobPosting".
 * Handles @type as string or array of strings.
 */
function isJobPosting(node: Record<string, unknown>): boolean {
  const t = node["@type"];
  if (typeof t === "string") return t === "JobPosting";
  if (Array.isArray(t)) return t.includes("JobPosting");
  return false;
}

/**
 * Search a parsed JSON-LD value for a JobPosting node.
 * Handles: plain object, @graph wrapper, top-level array.
 */
function findJobPosting(parsed: unknown): Record<string, unknown> | null {
  if (parsed === null || typeof parsed !== "object") return null;

  // Top-level array: [{ @type: "JobPosting" }, ...]
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item !== null && typeof item === "object") {
        const found = findJobPosting(item);
        if (found) return found;
      }
    }
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // @graph wrapper
  if ("@graph" in obj) {
    const graph = obj["@graph"];
    if (Array.isArray(graph)) {
      for (const node of graph) {
        if (node !== null && typeof node === "object" && isJobPosting(node as Record<string, unknown>)) {
          return node as Record<string, unknown>;
        }
      }
    }
    return null;
  }

  // Direct JobPosting object
  if (isJobPosting(obj)) {
    return obj;
  }

  return null;
}

/**
 * Extract JobPosting JSON-LD from HTML.
 * Supports multiple <script type="application/ld+json"> blocks,
 * top-level arrays, @graph wrappers, and @type as string or array.
 */
export function extractJobPosting(html: string): Record<string, unknown> | null {
  const pattern = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  const matches = html.matchAll(pattern);

  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const found = findJobPosting(parsed);
    if (found) return found;
  }

  return null;
}

export interface VisibleRegions {
  pageTitle: string;
  headerText: string;       // h1, h2 near top
  displayedLocation: string; // text near location icon/label
  bodyText: string;          // stripped body, up to 20000 chars
}

/**
 * Extract visible text regions from HTML for classification.
 */
export function extractVisibleRegions(html: string): VisibleRegions {
  // Page title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";

  // Header text: h1 and h2 tags (from the whole page, but typically near top)
  const headerMatches = html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi);
  const headers: string[] = [];
  for (const m of headerMatches) {
    const text = m[1]?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text) headers.push(text);
  }
  const headerText = headers.join(" | ");

  // Displayed location: look for text near location-related attributes or labels
  let displayedLocation = "";
  // Look for common location markers in HTML
  const locPatterns = [
    // data-testid or class containing "location"
    /<[^>]+(?:class|data-testid|data-automation|aria-label)="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi,
    // Elements with "location" in ID
    /<[^>]+id="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi,
    // Common ATS location patterns: spans/divs after "Location" label
    /(?:location|office|workplace)\s*(?::|<\/(?:strong|b|span|label)>)\s*([^<]{2,80})/gi,
  ];
  for (const pat of locPatterns) {
    const locMatches = html.matchAll(pat);
    for (const m of locMatches) {
      const text = m[1]?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (text && text.length > 1 && text.length < 200) {
        displayedLocation = text;
        break;
      }
    }
    if (displayedLocation) break;
  }

  // Body text: strip non-visible elements, then strip tags, limit to 20000 chars
  const bodyText = html
    .replace(/<(script|style|head|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);

  return { pageTitle, headerText, displayedLocation, bodyText };
}

// ── JobPosting fields ────────────────────────────────────────────────────────

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * applicantLocationRequirements: who may apply to a remote job. One or many of
 * "Turkey" | {"@type":"Country","name":"Europe / MENA"} | {"address":{"addressCountry":"DE"}}.
 */
export function extractApplicantLocations(posting: Record<string, unknown>): string[] {
  return asArray(posting["applicantLocationRequirements"])
    .map((l) => {
      if (typeof l === "string") return text(l);
      if (!l || typeof l !== "object") return undefined;
      const o = l as Record<string, unknown>;
      const addr = o["address"] as Record<string, unknown> | undefined;
      const country = addr?.["addressCountry"];
      return text(o["name"]) ?? text(country) ?? text((country as Record<string, unknown> | undefined)?.["name"]);
    })
    .filter((v): v is string => !!v);
}

// Rough USD rates — only for the salary floor, never shown as an exact figure.
const USD_RATE: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27, CHF: 1.13, CAD: 0.73, AUD: 0.65 };
const PER_MONTH: Record<string, number> = { HOUR: 160, DAY: 21, WEEK: 4.33, MONTH: 1, YEAR: 1 / 12 };

/** baseSalary → amounts + a monthly USD figure for the salary floor. */
export function extractSalary(posting: Record<string, unknown>): Salary | undefined {
  const base = posting["baseSalary"];
  if (!base || typeof base !== "object") return undefined;
  const b = base as Record<string, unknown>;
  const value = (typeof b["value"] === "object" && b["value"] ? b["value"] : b) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : NaN);
  const single = num(value["value"]);
  const min = Number.isFinite(num(value["minValue"])) ? num(value["minValue"]) : Number.isFinite(single) ? single : undefined;
  const max = Number.isFinite(num(value["maxValue"])) ? num(value["maxValue"]) : undefined;
  if (min === undefined && max === undefined) return undefined;
  const currency = (text(b["currency"]) ?? text(value["currency"]) ?? "USD").toUpperCase();
  const unit = (text(value["unitText"]) ?? text(b["unitText"]) ?? "YEAR").toUpperCase();
  const rate = USD_RATE[currency];
  const perMonth = PER_MONTH[unit];
  const top = max ?? min!;
  const monthlyUsd = rate && perMonth && top > 0 ? Math.round(top * perMonth * rate) : undefined;
  return { min, max, currency, unit, monthlyUsd };
}

// No leading \b: names like "ArgusRecruit" / "TechStaffing"
const AGENCY_NAME_RE = /(recruit|staffing|headhunt|executive search|talent (?:partners|solutions|search))/i;
const AGENCY_TEXT_RE = /\bon behalf of (?:our|a|an)\b[^.]{0,60}?\b(?:client|company)\b|\bour client(?: is|,)|\bconfidential client\b/i;

/** Posted by a recruiting agency: the agency's name, or "on behalf of our client" wording. */
export function isRecruitingAgency(company: string | undefined, description: string): boolean {
  return (!!company && AGENCY_NAME_RE.test(company)) || AGENCY_TEXT_RE.test(description);
}
