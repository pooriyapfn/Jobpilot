export interface SearchJob {
  title: string;
  url: string;
  description: string;
  extraSnippets: string[];
  foundByQueries: string[];
  sourceDomain: string;
  discoveredAt: string;
  /**
   * Structured data from an aggregator API (RemoteOK, Himalayas, Wellfound search result). Set when the job
   * couldn't be matched to the employer's own posting: verify falls back to it if the page blocks fetches,
   * and the aggregator domain isn't treated as excluded.
   */
  listing?: AggregatorListing;
}

export interface AggregatorListing {
  via: "remoteok" | "himalayas" | "wellfound";
  company?: string;
  datePosted?: string;
  /** Who may apply. [] = worldwide; undefined = not stated */
  applicantLocations?: string[];
  remote?: boolean;
  description?: string;
}

export type PageType =
  | "ats-job"        // known ATS domain, single-job URL pattern
  | "direct-job"     // company site, single job (has JSON-LD JobPosting)
  | "career-index"   // /careers root or /jobs listing page
  | "aggregator-job" // aggregator domain (should be pre-filtered)
  | "non-job"        // course, hire page, cert, etc.
  | "unknown";

export type Freshness =
  | "verified-24h"
  | "verified-week"
  | "old"          // datePosted known but > 7 days
  | "date-unknown"; // datePosted absent or unparseable

export type LocationEligibility =
  | "home-ok"    // candidate's own country explicitly mentioned (CANDIDATE_COUNTRY)
  | "eligible"   // Strong positive: worldwide / anywhere / global / a region open to the candidate
  | "uncertain"  // No location signals — goes to LLM
  | "restricted"; // US/Canada/UK/India/specific country only

export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";

export type AvailabilityStatus =
  | "confirmed-live"
  | "confirmed-closed"
  | "unverified"
  | "fetch-failed";

export type EvidenceSource =
  | "ats-api"
  | "json-ld"
  | "visible-html"
  | "search-snippet"
  | "aggregator-api"
  | "llm";

export type GeographicScope =
  | "home"       // candidate's own country (CANDIDATE_COUNTRY)
  | "worldwide"
  | "region"     // a hiring region open to the candidate (EMEA, MENA, …) — see VerifiedJob.openRegion
  | "specific-country"
  | "unknown";

export interface AtsJobData {
  exists: boolean;           // false = 404 confirmed-closed
  title?: string;
  company?: string;
  location?: string;
  workplaceType?: string;    // e.g. "remote", "hybrid", "on_site"
  description?: string;
  datePosted?: string;
  lastUpdated?: string;      // Greenhouse updated_at — not a reliable posting date
  validThrough?: string;
}

export interface Salary {
  min?: number;
  max?: number;
  currency: string;
  unit: string;              // HOUR | DAY | WEEK | MONTH | YEAR
  monthlyUsd?: number;       // max (or min) per month in USD; unset when the currency has no known rate
}

export interface VerifiedJob extends SearchJob {
  company?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string;
  jobLocation?: string[];
  applicantLocations?: string[]; // JSON-LD applicantLocationRequirements — who may apply (beats office jobLocation)
  openRegion?: string;           // set when geographicScope === "region", e.g. "MENA"
  salary?: Salary;
  agency?: boolean;              // posted by a recruiting agency — company is the agency, not the employer
  remote?: boolean;            // backward compat — derived from workMode
  ageHours?: number;
  freshness: Freshness;
  locationEligibility: LocationEligibility;
  pageType: PageType;
  geoRejected: boolean;        // = locationEligibility === "restricted"
  rejectionReason?: string;
  verifiedAt: string;
  fetchStatus: "ok" | "failed" | "timeout";
  jsonLdFound: boolean;
  dateSource?: "json-ld" | "ats-api" | "none";
  lastUpdated?: string;        // ATS last-updated timestamp (unreliable for freshness)
  workMode: WorkMode;
  availabilityStatus: AvailabilityStatus;
  visibleText?: string;         // stripped body text up to 20000 chars
  displayedLocation?: string;   // location string from page header/metadata
  geographicScope?: GeographicScope;
  verificationEvidence: Array<{
    source: EvidenceSource;
    field: string;
    value: string;
  }>;
}

export interface EligibilityResult {
  status: "eligible" | "restricted" | "uncertain";
  evidence: string;
  confidence: number; // 0–1
}

export type FitClassificationStatus = "STRONG_FIT" | "POSSIBLE_FIT" | "SKIP";

export interface FitClassification {
  classification: FitClassificationStatus;
  reasons: string[];
  gaps: string[];
}

export interface ScoredJob extends VerifiedJob {
  llmEligibility?: EligibilityResult;
  effectiveLocationEligibility?: "eligible" | "restricted" | "uncertain";
  eligibilitySource?: "deterministic" | "llm";
  fitClassification?: FitClassificationStatus;
  fitReasons?: string[];
  fitGaps?: string[];
  resumeMdPath?: string;
  resumeDocxPath?: string;
  dbId?: string;
}

export interface QueryStats {
  raw: number;
  accepted: number;
  unique: number;
}

export interface VerificationStats {
  fetchOk: number;
  fetchFailed: number;
  jsonLdFound: number;
  atsApiHits: number;
  verified24h: number;
  verifiedWeek: number;
  old: number;
  dateUnknown: number;
  restricted: number;
  uncertain: number;
  notRemote: number;
  nonJobPage: number;
  candidates: number;
}

export interface RunStats {
  runAt: string;
  requests: number;
  rawResults: number;
  afterDomainFiltering: number;
  uniqueResults: number;
  queries: Record<string, QueryStats>;
  verification?: VerificationStats;
  /** Per query / source: jobs verified and how many survived as candidates (fresh, needs-date, uncertain) */
  yield?: Record<string, { verified: number; candidates: number }>;
}
