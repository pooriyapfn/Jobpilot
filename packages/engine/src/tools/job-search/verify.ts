import chalk from "chalk";
import { appendFile, readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "node:url";
import { fetchJobFromATS } from "./adapters/index.ts";
import {
  classifyFreshness,
  classifyGeographicScope,
  classifyPageType,
  classifyWorkMode,
  scopeToLocationEligibility,
} from "./classifier.ts";
import {
  extractApplicantLocations,
  extractJobPosting,
  extractSalary,
  extractVisibleRegions,
  isRecruitingAgency,
} from "./extractor.ts";
import { isBlocked } from "./filters.ts";
import { candidate } from "./candidate.ts";
import { isCompanyExcluded, loadExcludedCompanies } from "./company-exclusions.ts";
import { ATS_DOMAINS, MIN_MONTHLY_SALARY_USD } from "./config.ts";
import type {
  AggregatorListing,
  AtsJobData,
  AvailabilityStatus,
  EvidenceSource,
  GeographicScope,
  RunStats,
  SearchJob,
  VerificationStats,
  VerifiedJob,
} from "./types.ts";
import { OUTPUT_DIR } from "./paths.ts";
import { watchSites } from "./sources/watched-sites.ts";

const BATCH_SIZE = 5;
const FETCH_TIMEOUT_MS = 10_000;

// ── Bucket classification (exported for testing) ─────────────────────────────

export type VerificationOutcome = "verified-fresh" | "needs-date" | "uncertain" | "rejected";

const ELIGIBLE_SCOPES = new Set<GeographicScope>(["home", "worldwide", "region"]);

/**
 * Pure function: classify a VerifiedJob into its output bucket.
 * Fail-closed: missing or unknown values always resolve to "rejected".
 */
export function classifyVerificationOutcome(job: VerifiedJob): VerificationOutcome {
  // Must be a single-job page
  if (job.pageType !== "ats-job" && job.pageType !== "direct-job") return "rejected";
  // Already flagged with a rejection reason
  if (job.rejectionReason) return "rejected";
  // Require confirmed-live — unverified availability is not safe to surface
  if (job.availabilityStatus !== "confirmed-live") return "rejected";
  // Require confirmed remote — unknown work mode is not eligible
  if (job.workMode !== "remote") return "rejected";
  // Explicitly geo-restricted
  if (job.geographicScope === "specific-country") return "rejected";
  // Unknown geography → send to LLM for evaluation
  if (!job.geographicScope || job.geographicScope === "unknown") return "uncertain";
  // Eligible scope: home / worldwide / open region
  if (!ELIGIBLE_SCOPES.has(job.geographicScope)) return "rejected";
  if (job.freshness === "verified-24h" || job.freshness === "verified-week") return "verified-fresh";
  if (job.freshness === "date-unknown") return "needs-date";
  // freshness === "old"
  return "rejected";
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === "string" ? val : undefined;
}

function extractCompany(posting: Record<string, unknown>): string | undefined {
  const org = posting["hiringOrganization"];
  if (org && typeof org === "object") {
    const name = (org as Record<string, unknown>)["name"];
    if (typeof name === "string") return name;
  }
  return undefined;
}

function extractJobLocations(posting: Record<string, unknown>): string[] {
  const loc = posting["jobLocation"];
  if (!loc) return [];

  const normalize = (l: unknown): string | undefined => {
    if (typeof l === "string") return l;
    if (l && typeof l === "object") {
      const addr = (l as Record<string, unknown>)["address"];
      if (addr && typeof addr === "object") {
        const parts = [
          (addr as Record<string, unknown>)["addressLocality"],
          (addr as Record<string, unknown>)["addressRegion"],
          (addr as Record<string, unknown>)["addressCountry"],
        ].filter((p) => typeof p === "string");
        return parts.length ? parts.join(", ") : undefined;
      }
    }
    return undefined;
  };

  if (Array.isArray(loc)) {
    return loc.map(normalize).filter((v): v is string => v !== undefined);
  }
  const single = normalize(loc);
  return single ? [single] : [];
}

async function fetchWithTimeout(
  url: string
): Promise<{ html: string; status: "ok" | "failed" | "timeout"; httpStatus?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobVerifier/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);
    if (!response.ok) return { html: "", status: "failed", httpStatus: response.status };
    const html = await response.text();
    return { html, status: "ok" };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("abort"));
    return { html: "", status: isTimeout ? "timeout" : "failed" };
  }
}

type Evidence = VerifiedJob["verificationEvidence"];

function closedJob(job: SearchJob, verifiedAt: string, evidence: Evidence): VerifiedJob {
  return {
    ...job,
    pageType: "ats-job",
    freshness: "date-unknown",
    locationEligibility: "restricted",
    geoRejected: false,
    rejectionReason: "closed",
    verifiedAt,
    fetchStatus: "ok",
    jsonLdFound: false,
    dateSource: "none",
    workMode: "unknown",
    availabilityStatus: "confirmed-closed",
    verificationEvidence: evidence,
  };
}

// First link to an ATS job posting (host in ATS_DOMAINS, path /company/id…) — e.g. an aggregator's "Apply" button.
const ATS_LINK = new RegExp(
  `https://(?:${ATS_DOMAINS.map((d) => d.replace(/\./g, "\\.")).join("|")})/[\\w.-]+/[^\\s"'<>\\\\]+`,
  "i"
);
export const findAtsJobUrl = (html: string): string | undefined => html.match(ATS_LINK)?.[0];

export async function verifyJob(job: SearchJob): Promise<VerifiedJob> {
  const verifiedAt = new Date().toISOString();
  const evidence: Array<{ source: EvidenceSource; field: string; value: string }> = [];

  // Re-apply domain filter in case jobs.json was generated before a domain was blocked
  if (isBlocked(job)) {
    return {
      ...job,
      pageType: "aggregator-job",
      freshness: "date-unknown",
      locationEligibility: "uncertain",
      geoRejected: false,
      rejectionReason: "aggregator",
      verifiedAt,
      fetchStatus: "ok",
      jsonLdFound: false,
      dateSource: "none",
      workMode: "unknown",
      availabilityStatus: "unverified",
      verificationEvidence: [],
    };
  }

  // Determine page type early (URL-based)
  const urlPageType = classifyPageType(job.url, false);

  // For ATS jobs, try the structured API first
  let atsData: AtsJobData | null = null;
  let atsAvailability: AvailabilityStatus = "unverified";

  if (urlPageType === "ats-job") {
    try {
      atsData = await fetchJobFromATS(job.url);
      if (atsData) {
        if (!atsData.exists) {
          atsAvailability = "confirmed-closed";
          evidence.push({ source: "ats-api", field: "exists", value: "false" });
        } else {
          atsAvailability = "confirmed-live";
          evidence.push({ source: "ats-api", field: "exists", value: "true" });
          if (atsData.datePosted) {
            evidence.push({ source: "ats-api", field: "datePosted", value: atsData.datePosted });
          }
          if (atsData.workplaceType) {
            evidence.push({ source: "ats-api", field: "workplaceType", value: atsData.workplaceType });
          }
          if (atsData.location) {
            evidence.push({ source: "ats-api", field: "location", value: atsData.location });
          }
        }
      }
    } catch {
      // Network error — atsAvailability stays "unverified"
    }

    // If ATS confirmed closed, reject immediately
    if (atsAvailability === "confirmed-closed") return closedJob(job, verifiedAt, evidence);
  }

  // Fetch the HTML page
  const { html, status: fetchStatus, httpStatus } = await fetchWithTimeout(job.url);

  // 404 / 410 Gone: the posting was taken down (Wellfound answers 410)
  if (httpStatus === 404 || httpStatus === 410) {
    return closedJob(job, verifiedAt, [...evidence, { source: "visible-html", field: "httpStatus", value: String(httpStatus) }]);
  }

  // Aggregator page behind a bot wall (Himalayas, Wellfound): the aggregator's API data stands in for it
  if (job.listing && (fetchStatus !== "ok" || !html)) return fromListing(job, job.listing, verifiedAt, evidence);

  if (fetchStatus !== "ok" || !html) {
    return {
      ...job,
      pageType: urlPageType,
      freshness: "date-unknown",
      locationEligibility: "uncertain",
      geoRejected: false,
      rejectionReason: "fetch-failed",
      verifiedAt,
      fetchStatus,
      jsonLdFound: false,
      dateSource: "none",
      workMode: "unknown",
      availabilityStatus: "fetch-failed",
      verificationEvidence: evidence,
    };
  }

  // Aggregator/company page linking out to an ATS posting: that posting decides availability.
  if (urlPageType !== "ats-job") {
    const outbound = findAtsJobUrl(html);
    const outboundData = outbound ? await fetchJobFromATS(outbound).catch(() => null) : null;
    if (outbound && outboundData && !outboundData.exists) {
      return closedJob(job, verifiedAt, [...evidence, { source: "ats-api", field: "outbound-closed", value: outbound }]);
    }
  }

  // Availability: if we fetched HTML ok and ATS confirmed live, or non-ATS fetch ok
  const availabilityStatus: AvailabilityStatus =
    atsAvailability === "confirmed-live"
      ? "confirmed-live"
      : urlPageType === "ats-job"
        ? "unverified" // ATS but API returned null (unsupported) or threw
        : "confirmed-live"; // non-ATS page loaded ok

  // Extract visible regions
  const visibleRegions = extractVisibleRegions(html);

  // Extract JSON-LD
  const posting = extractJobPosting(html);
  const jsonLdFound = posting !== null;
  if (job.listing && !posting) return fromListing(job, job.listing, verifiedAt, evidence);
  const pageType = classifyPageType(job.url, jsonLdFound);

  // Extract structured data from JSON-LD
  let datePosted: string | undefined;
  let company: string | undefined;
  let jobLocation: string[] = [];
  let applicantLocations: string[] = [];
  let validThrough: string | undefined;
  let employmentType: string | undefined;
  let dateSource: VerifiedJob["dateSource"] = "none";
  let descriptionText = "";
  let jobLocationTypeRaw: string | undefined;

  if (posting) {
    datePosted = getString(posting, "datePosted");
    company = extractCompany(posting);
    jobLocation = extractJobLocations(posting);
    applicantLocations = extractApplicantLocations(posting);
    validThrough = getString(posting, "validThrough");
    employmentType = getString(posting, "employmentType");
    descriptionText = getString(posting, "description") ?? "";
    jobLocationTypeRaw = getString(posting, "jobLocationType");

    if (datePosted) {
      dateSource = "json-ld";
      evidence.push({ source: "json-ld", field: "datePosted", value: datePosted });
    }
    if (jobLocationTypeRaw) {
      evidence.push({ source: "json-ld", field: "jobLocationType", value: jobLocationTypeRaw });
    }
    if (jobLocation.length > 0) {
      evidence.push({ source: "json-ld", field: "jobLocation", value: jobLocation.join("; ") });
    }
    if (applicantLocations.length > 0) {
      evidence.push({ source: "json-ld", field: "applicantLocationRequirements", value: applicantLocations.join("; ") });
    }
  }

  // Merge ATS data: prefer ATS for fields not found in JSON-LD
  let lastUpdated: string | undefined;
  if (atsData?.exists) {
    if (!datePosted && atsData.datePosted) {
      datePosted = atsData.datePosted;
      dateSource = "ats-api";
    }
    if (!company && atsData.company) {
      company = atsData.company;
    }
    if (atsData.location && jobLocation.length === 0) {
      jobLocation = [atsData.location];
    }
    if (!validThrough && atsData.validThrough) {
      validThrough = atsData.validThrough;
    }
    if (atsData.lastUpdated) {
      lastUpdated = atsData.lastUpdated;
      evidence.push({ source: "ats-api", field: "lastUpdated", value: lastUpdated });
    }
    if (!descriptionText && atsData.description) {
      descriptionText = atsData.description;
      evidence.push({ source: "ats-api", field: "description", value: "fetched" });
    }
  }

  // Salary floor check (only when a salary is stated)
  const salary = posting ? extractSalary(posting) : undefined;
  let salaryTooLow = salary?.monthlyUsd !== undefined && salary.monthlyUsd < MIN_MONTHLY_SALARY_USD;
  if (salary) {
    evidence.push({
      source: "json-ld",
      field: "baseSalary",
      value: `${salary.min ?? ""}–${salary.max ?? ""} ${salary.currency}/${salary.unit}${salary.monthlyUsd ? ` ≈ $${salary.monthlyUsd}/mo` : ""}`,
    });
  }
  if (!salaryTooLow) {
    const MONTHLY_SALARY_RE = /\$(\d[\d,]*)\s*(?:to|-)\s*\$(\d[\d,]*)\s*\/\s*(?:month|mo)\b/i;
    const salaryMatch = html.match(MONTHLY_SALARY_RE);
    if (salaryMatch) {
      const maxSalary = parseInt((salaryMatch[2] ?? "").replace(/,/g, ""), 10);
      if (!isNaN(maxSalary) && maxSalary < MIN_MONTHLY_SALARY_USD) {
        salaryTooLow = true;
      }
    }
  }

  // Classify work mode
  const workModeResult = classifyWorkMode(
    jobLocationTypeRaw,
    atsData?.exists ? atsData.workplaceType : undefined,
    visibleRegions.displayedLocation,
    visibleRegions.bodyText,
    job.title
  );
  const workMode = workModeResult.mode;
  const remote =
    workMode === "remote"
      ? true
      : workMode === "hybrid" || workMode === "onsite"
        ? false
        : undefined;

  // Classify geographic scope. For remote jobs, applicantLocationRequirements says who may apply;
  // jobLocation is then usually just the office, so it must not restrict.
  const geoResult = classifyGeographicScope(
    applicantLocations.length && workMode === "remote" ? applicantLocations : [...applicantLocations, ...jobLocation],
    visibleRegions.displayedLocation,
    [descriptionText, visibleRegions.bodyText, ...job.extraSnippets].join(" "),
    job.title
  );
  const geographicScope = geoResult.scope;
  const locationEligibility = scopeToLocationEligibility(geographicScope);
  const geoRejected = locationEligibility === "restricted";

  // Freshness
  const freshness = classifyFreshness(datePosted);
  const ageHours = datePosted
    ? (Date.now() - new Date(datePosted).getTime()) / 3_600_000
    : undefined;

  // ── Fail-closed decision order ──────────────────────────────────────

  let rejectionReason: string | undefined;

  // 1. Availability: confirmed-closed and fetch-failed already returned early above.

  // 2. Work mode
  if (workMode === "hybrid" || workMode === "onsite") {
    rejectionReason = "not-remote";
  }
  // 3. Page type
  else if (pageType !== "ats-job" && pageType !== "direct-job") {
    rejectionReason = "non-job-page";
  }
  // 4. Freshness
  else if (freshness === "old") {
    rejectionReason = "old";
  }
  // 5. Salary
  else if (salaryTooLow) {
    rejectionReason = "salary-too-low";
  }
  // 6. Geographic scope
  else if (geographicScope === "specific-country") {
    rejectionReason = "geo-restricted";
  }
  // eligible or uncertain — no rejection

  return {
    ...job,
    // Search results always carry a title; a link added by hand doesn't, so read it from the page.
    title: job.title || (posting && getString(posting, "title")) || atsData?.title || visibleRegions.headerText.split(" | ")[0] || visibleRegions.pageTitle,
    description: descriptionText || job.description,
    company,
    datePosted,
    validThrough,
    employmentType,
    jobLocation,
    applicantLocations: applicantLocations.length ? applicantLocations : undefined,
    openRegion: geoResult.region,
    salary,
    agency: isRecruitingAgency(company, descriptionText) || undefined,
    remote,
    ageHours,
    freshness,
    locationEligibility,
    pageType,
    geoRejected,
    rejectionReason,
    verifiedAt,
    fetchStatus: "ok",
    jsonLdFound,
    dateSource,
    lastUpdated,
    workMode,
    availabilityStatus,
    visibleText: visibleRegions.bodyText,
    displayedLocation: visibleRegions.displayedLocation || undefined,
    geographicScope,
    verificationEvidence: evidence,
  };
}

/** Per query / source: verified jobs and surviving candidates. */
export function queryYield(verified: VerifiedJob[]): Record<string, { verified: number; candidates: number }> {
  const out: Record<string, { verified: number; candidates: number }> = {};
  for (const v of verified) {
    const candidate = classifyVerificationOutcome(v) !== "rejected";
    for (const q of v.foundByQueries ?? []) {
      const y = (out[q] ??= { verified: 0, candidates: 0 });
      y.verified++;
      if (candidate) y.candidates++;
    }
  }
  return out;
}

/** VerifiedJob from an aggregator API's data, for pages we can't read ourselves. */
export function fromListing(job: SearchJob, l: AggregatorListing, verifiedAt: string, evidence: Evidence): VerifiedJob {
  evidence.push({ source: "aggregator-api", field: "via", value: l.via });
  const locations = l.applicantLocations;
  const own = candidate().names.map((n) => n.toLowerCase());
  const geo =
    locations === undefined
      ? classifyGeographicScope([], "", `${l.description ?? ""} ${job.description}`, job.title)
      : locations.length === 0
        ? { scope: "worldwide" as const, region: undefined }
        : locations.some((c) => own.includes(c.toLowerCase()))
          ? { scope: "home" as const, region: undefined }
          : classifyGeographicScope(locations, "", "", job.title);
  if (locations) evidence.push({ source: "aggregator-api", field: "applicantLocations", value: locations.join("; ").slice(0, 200) || "worldwide" });
  const workMode = l.remote ? "remote" : "unknown";
  const freshness = classifyFreshness(l.datePosted);
  const rejectionReason =
    freshness === "old" ? "old" : geo.scope === "specific-country" ? "geo-restricted" : undefined;
  return {
    ...job,
    description: l.description || job.description,
    company: l.company,
    datePosted: l.datePosted,
    applicantLocations: locations?.length ? locations.slice(0, 50) : undefined,
    openRegion: geo.region,
    agency: isRecruitingAgency(l.company, l.description ?? "") || undefined,
    remote: l.remote,
    ageHours: l.datePosted ? (Date.now() - Date.parse(l.datePosted)) / 3_600_000 : undefined,
    freshness,
    locationEligibility: scopeToLocationEligibility(geo.scope),
    pageType: "direct-job",
    geoRejected: geo.scope === "specific-country",
    rejectionReason,
    verifiedAt,
    fetchStatus: "ok",
    jsonLdFound: false,
    dateSource: "none",
    workMode,
    availabilityStatus: "confirmed-live", // listed by the aggregator's API right now
    geographicScope: geo.scope,
    verificationEvidence: evidence,
  };
}

async function processBatch(jobs: SearchJob[]): Promise<VerifiedJob[]> {
  const results = await Promise.allSettled(jobs.map((j) => verifyJob(j)));
  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      ...jobs[i]!,
      pageType: "unknown" as const,
      freshness: "date-unknown" as const,
      locationEligibility: "uncertain" as const,
      geoRejected: false,
      rejectionReason: "error",
      verifiedAt: new Date().toISOString(),
      fetchStatus: "failed" as const,
      jsonLdFound: false,
      dateSource: "none" as const,
      workMode: "unknown" as const,
      availabilityStatus: "fetch-failed" as const,
      verificationEvidence: [],
    };
  });
}

async function main() {
  const runAt = new Date().toISOString();
  console.log(chalk.bold.cyan("\n  Job Verifier — Page Fetch + JSON-LD + ATS APIs"));
  console.log(chalk.dim(`  ${runAt}\n`));

  let jobs: SearchJob[];
  try {
    const raw = await readFile(`${OUTPUT_DIR}jobs.json`, "utf8");
    jobs = JSON.parse(raw) as SearchJob[];
  } catch {
    console.error(
      chalk.red("  Error: output/jobs.json not found. Run `npm run search` first.")
    );
    process.exit(1);
  }

  console.log(
    chalk.dim(`  Verifying ${jobs.length} jobs in batches of ${BATCH_SIZE}...\n`)
  );

  const verified: VerifiedJob[] = [];

  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);
    const results = await processBatch(batch);
    verified.push(...results);
    const done = Math.min(i + BATCH_SIZE, jobs.length);
    process.stdout.write(`\r  Progress: ${done}/${jobs.length}`);
  }

  console.log("\n");

  // Fail-closed: reject jobs from companies the user has already excluded
  const excludedCompanies = await loadExcludedCompanies(`${OUTPUT_DIR}excluded-companies.json`);
  for (const v of verified) {
    if (!v.rejectionReason && isCompanyExcluded(v.company, excludedCompanies)) {
      v.rejectionReason = "excluded-company";
    }
  }

  // Split into buckets using fail-closed classifyVerificationOutcome
  const verifiedFresh = verified.filter((v) => classifyVerificationOutcome(v) === "verified-fresh");
  const needsDate = verified.filter((v) => classifyVerificationOutcome(v) === "needs-date");
  const uncertain = verified.filter((v) => classifyVerificationOutcome(v) === "uncertain");
  const rejected = verified.filter((v) => classifyVerificationOutcome(v) === "rejected");

  // Non-ATS sites with a real remote job get watched: later searches read their job index directly
  const newSites = await watchSites(
    [...verifiedFresh, ...needsDate, ...uncertain].filter((v) => v.pageType === "direct-job").map((v) => v.url)
  );

  // Compute stats
  const vstats: VerificationStats = {
    fetchOk: verified.filter((v) => v.fetchStatus === "ok").length,
    fetchFailed: verified.filter((v) => v.fetchStatus !== "ok").length,
    jsonLdFound: verified.filter((v) => v.jsonLdFound).length,
    atsApiHits: verified.filter((v) =>
      v.verificationEvidence.some(
        (e) => e.source === "ats-api" && e.field === "exists"
      )
    ).length,
    verified24h: verified.filter((v) => v.freshness === "verified-24h").length,
    verifiedWeek: verified.filter((v) => v.freshness === "verified-week").length,
    old: verified.filter((v) => v.freshness === "old").length,
    dateUnknown: verified.filter((v) => v.freshness === "date-unknown").length,
    restricted: verified.filter((v) => v.locationEligibility === "restricted").length,
    uncertain: uncertain.length,
    notRemote: verified.filter((v) => v.workMode === "hybrid" || v.workMode === "onsite").length,
    nonJobPage: verified.filter(
      (v) => v.pageType !== "ats-job" && v.pageType !== "direct-job"
    ).length,
    candidates: verifiedFresh.length + needsDate.length + uncertain.length,
  };

  // Update stats.json
  let existingStats: RunStats = {
    runAt,
    requests: 0,
    rawResults: 0,
    afterDomainFiltering: 0,
    uniqueResults: 0,
    queries: {},
  };
  try {
    const raw = await readFile(`${OUTPUT_DIR}stats.json`, "utf8");
    existingStats = JSON.parse(raw) as RunStats;
  } catch {
    // no existing stats
  }
  existingStats.verification = vstats;
  existingStats.yield = queryYield(verified);

  await Promise.all([
    writeFile(
      `${OUTPUT_DIR}verified-jobs.json`,
      JSON.stringify(verified, null, 2),
      "utf8"
    ),
    writeFile(
      `${OUTPUT_DIR}verified-fresh.json`,
      JSON.stringify(verifiedFresh, null, 2),
      "utf8"
    ),
    writeFile(
      `${OUTPUT_DIR}needs-date.json`,
      JSON.stringify(needsDate, null, 2),
      "utf8"
    ),
    writeFile(
      `${OUTPUT_DIR}uncertain.json`,
      JSON.stringify(uncertain, null, 2),
      "utf8"
    ),
    writeFile(
      `${OUTPUT_DIR}rejected.json`,
      JSON.stringify(rejected, null, 2),
      "utf8"
    ),
    writeFile(
      `${OUTPUT_DIR}stats.json`,
      JSON.stringify(existingStats, null, 2),
      "utf8"
    ),
    // One line per run: which queries/sources keep producing candidates (prune the ones that don't)
    appendFile(`${OUTPUT_DIR}yield-history.jsonl`, JSON.stringify({ runAt, yield: existingStats.yield }) + "\n", "utf8"),
  ]);

  const fetchRate =
    jobs.length > 0
      ? Math.round((vstats.fetchOk / jobs.length) * 100)
      : 0;
  const jsonLdRate =
    vstats.fetchOk > 0
      ? Math.round((vstats.jsonLdFound / vstats.fetchOk) * 100)
      : 0;

  console.log(chalk.bold.cyan("  Verification Summary"));
  console.log(
    `  Fetch success:       ${chalk.white(`${vstats.fetchOk}/${jobs.length}`)} ${chalk.dim(`(${fetchRate}%)`)}`
  );
  console.log(
    `  JSON-LD found:       ${chalk.white(`${vstats.jsonLdFound}/${vstats.fetchOk}`)} ${chalk.dim(`(${jsonLdRate}%)`)}`
  );
  console.log(`  ATS API hits:        ${chalk.white(vstats.atsApiHits)}`);
  console.log(chalk.dim("  ─────────────────────────────────"));
  console.log(`  Verified ≤24h:       ${chalk.bold.green(vstats.verified24h)}`);
  console.log(`  Verified ≤1 week:    ${chalk.green(vstats.verifiedWeek)}`);
  console.log(`  Old (>7 days):       ${chalk.yellow(vstats.old)}`);
  console.log(`  Date unknown:        ${chalk.dim(vstats.dateUnknown)}`);
  console.log(chalk.dim("  ─────────────────────────────────"));
  console.log(`  Not remote:          ${chalk.yellow(vstats.notRemote)}`);
  console.log(`  Non-job page:        ${chalk.yellow(vstats.nonJobPage)}`);
  console.log(`  Geo-restricted:      ${chalk.yellow(vstats.restricted)}`);
  console.log(`  Uncertain (→LLM):    ${chalk.cyan(vstats.uncertain)}`);
  console.log(chalk.dim("  ─────────────────────────────────"));
  console.log(
    `  Fresh candidates:    ${chalk.bold.green(verifiedFresh.length)} ${chalk.dim("(verified-fresh.json)")}`
  );
  console.log(
    `  Needs date verify:   ${chalk.green(needsDate.length)} ${chalk.dim("(needs-date.json)")}`
  );
  console.log(
    `  Uncertain:           ${chalk.cyan(uncertain.length)} ${chalk.dim("(uncertain.json)")}`
  );
  console.log(
    `  Rejected:            ${chalk.dim(rejected.length)} ${chalk.dim("(rejected.json)")}`
  );
  console.log(chalk.dim(`\n  output/verified-fresh.json — ${verifiedFresh.length} entries`));
  console.log(chalk.dim(`  output/needs-date.json     — ${needsDate.length} entries`));
  console.log(chalk.dim(`  output/uncertain.json      — ${uncertain.length} entries`));
  console.log(chalk.dim(`  output/rejected.json       — ${rejected.length} entries`));
  console.log(chalk.dim(`  output/stats.json          — updated\n`));
  if (newSites) console.log(chalk.dim(`  Watching ${newSites} new career site(s) — watched-sites.json\n`));
  const top = Object.entries(existingStats.yield).filter(([, y]) => y.candidates > 0).sort((a, b) => b[1].candidates - a[1].candidates);
  if (top.length) {
    console.log(chalk.bold.cyan("  Candidates by query / source"));
    for (const [q, y] of top.slice(0, 15)) console.log(`  ${chalk.green(String(y.candidates).padStart(3))}/${y.verified}  ${chalk.dim(q)}`);
    console.log();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(chalk.red("Fatal:"), err);
    process.exit(1);
  });
}
