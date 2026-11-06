import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFreshness,
  classifyWorkMode,
  classifyGeographicScope,
  classifyPageType,
} from "../classifier.ts";
import { extractJobPosting, extractVisibleRegions } from "../extractor.ts";
import { classifyVerificationOutcome } from "../verify.ts";
import { isEligibleForOutput } from "../enrich.ts";
import type { ScoredJob, VerifiedJob } from "../types.ts";

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeVerifiedJob(overrides: Partial<VerifiedJob> = {}): VerifiedJob {
  return {
    title: "Software Engineer",
    url: "https://jobs.lever.co/acme/12345678-1234-1234-1234-123456789abc",
    description: "",
    extraSnippets: [],
    foundByQueries: [],
    sourceDomain: "jobs.lever.co",
    discoveredAt: new Date().toISOString(),
    pageType: "ats-job",
    freshness: "verified-24h",
    locationEligibility: "eligible",
    geoRejected: false,
    verifiedAt: new Date().toISOString(),
    fetchStatus: "ok",
    jsonLdFound: false,
    dateSource: "none",
    workMode: "remote",
    availabilityStatus: "confirmed-live",
    geographicScope: "worldwide",
    verificationEvidence: [],
    ...overrides,
  };
}

function makeScoredJob(overrides: Partial<ScoredJob> = {}): ScoredJob {
  return makeVerifiedJob(overrides) as ScoredJob;
}

// ── extractJobPosting ───────────────────────────────────────────────────────

describe("extractJobPosting", () => {
  it("parses a standard JSON-LD JobPosting", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"JobPosting","title":"Engineer","datePosted":"2026-09-01"}</script>
    </head><body></body></html>`;
    const result = extractJobPosting(html);
    assert.ok(result);
    assert.equal(result["title"], "Engineer");
    assert.equal(result["datePosted"], "2026-09-01");
  });

  it("handles top-level JSON array (jsonld-array)", () => {
    const html = `<html><head>
      <script type="application/ld+json">[
        {"@type":"Organization","name":"Acme"},
        {"@type":"JobPosting","title":"Dev","datePosted":"2026-09-05"}
      ]</script>
    </head><body></body></html>`;
    const result = extractJobPosting(html);
    assert.ok(result);
    assert.equal(result["title"], "Dev");
  });

  it("handles @type as array (e.g. ['JobPosting'])", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":["JobPosting"],"title":"ML Eng"}</script>
    </head><body></body></html>`;
    const result = extractJobPosting(html);
    assert.ok(result);
    assert.equal(result["title"], "ML Eng");
  });

  it("handles @graph wrapper", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":"JobPosting","title":"SRE"}]}</script>
    </head><body></body></html>`;
    const result = extractJobPosting(html);
    assert.ok(result);
    assert.equal(result["title"], "SRE");
  });

  it("finds JobPosting from multiple JSON-LD scripts (multiple-jsonld)", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Organization","name":"Foo"}</script>
      <script type="application/ld+json">{"@type":"JobPosting","title":"Backend Eng"}</script>
    </head><body></body></html>`;
    const result = extractJobPosting(html);
    assert.ok(result);
    assert.equal(result["title"], "Backend Eng");
  });

  it("returns null when no JobPosting found", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Organization","name":"Bar"}</script>
    </head><body></body></html>`;
    assert.equal(extractJobPosting(html), null);
  });
});

// ── extractVisibleRegions ───────────────────────────────────────────────────

describe("extractVisibleRegions", () => {
  it("extracts page title and headers", () => {
    const html = `<html><head><title>Senior Engineer at Acme</title></head>
    <body><h1>Senior Engineer</h1><h2>Remote - Worldwide</h2><p>Some text here</p></body></html>`;
    const regions = extractVisibleRegions(html);
    assert.equal(regions.pageTitle, "Senior Engineer at Acme");
    assert.ok(regions.headerText.includes("Senior Engineer"));
    assert.ok(regions.headerText.includes("Remote - Worldwide"));
  });

  it("strips script/style/comments from bodyText", () => {
    const html = `<html><head><style>.x{color:red}</style></head>
    <body><script>alert(1)</script><!-- comment --><p>Hello world</p></body></html>`;
    const regions = extractVisibleRegions(html);
    assert.ok(regions.bodyText.includes("Hello world"));
    assert.ok(!regions.bodyText.includes("alert"));
    assert.ok(!regions.bodyText.includes("color:red"));
    assert.ok(!regions.bodyText.includes("comment"));
  });

  it("limits bodyText to 20000 chars", () => {
    const longContent = "x".repeat(30_000);
    const html = `<html><body><p>${longContent}</p></body></html>`;
    const regions = extractVisibleRegions(html);
    assert.ok(regions.bodyText.length <= 20_000);
  });
});

// ── classifyWorkMode ────────────────────────────────────────────────────────

describe("classifyWorkMode", () => {
  it("london-hybrid: detects hybrid from body text", () => {
    const result = classifyWorkMode(
      undefined,
      undefined,
      "London Office / Hybrid",
      "We offer a hybrid working environment with 3 days per week in the office.",
      "Software Engineer"
    );
    assert.equal(result.mode, "hybrid");
  });

  it("hybrid-globally: hybrid wins even with 'global team'", () => {
    const result = classifyWorkMode(
      undefined,
      undefined,
      "",
      "This is a hybrid role. We are a global team working across timezones.",
      "Hybrid - global team"
    );
    assert.equal(result.mode, "hybrid");
  });

  it("detects remote from TELECOMMUTE", () => {
    const result = classifyWorkMode("TELECOMMUTE", undefined, "", "", "Engineer");
    assert.equal(result.mode, "remote");
  });

  it("ATS workplaceType takes priority", () => {
    // ATS says hybrid even though JSON-LD says TELECOMMUTE
    const result = classifyWorkMode("TELECOMMUTE", "hybrid", "", "", "Engineer");
    assert.equal(result.mode, "hybrid");
  });

  it("detects remote from 'fully remote' in body", () => {
    const result = classifyWorkMode(
      undefined,
      undefined,
      "",
      "This is a fully remote position with flexible hours.",
      "Senior Engineer"
    );
    assert.equal(result.mode, "remote");
  });

  it("returns unknown when no signals", () => {
    const result = classifyWorkMode(undefined, undefined, "", "Build great software", "Engineer");
    assert.equal(result.mode, "unknown");
  });
});

// ── classifyGeographicScope ─────────────────────────────────────────────────

describe("classifyGeographicScope", () => {
  const saved = process.env.CANDIDATE_COUNTRY;
  before(() => { process.env.CANDIDATE_COUNTRY = "Turkey"; });
  after(() => { saved === undefined ? delete process.env.CANDIDATE_COUNTRY : (process.env.CANDIDATE_COUNTRY = saved); });

  it("accepts the Türkiye spelling for a Turkey candidate", () => {
    assert.equal(classifyGeographicScope(["Ankara, Türkiye"], "", "", "Engineer").scope, "home");
  });

  it("without a candidate country nothing is 'home'", () => {
    delete process.env.CANDIDATE_COUNTRY;
    assert.equal(classifyGeographicScope(["Istanbul, Turkey"], "", "", "Engineer").scope, "unknown");
    process.env.CANDIDATE_COUNTRY = "Turkey";
  });

  it("the candidate's own country is not a restricted country", () => {
    process.env.CANDIDATE_COUNTRY = "India";
    const r = classifyGeographicScope(["Remote - India"], "", "", "Engineer");
    process.env.CANDIDATE_COUNTRY = "Turkey";
    assert.equal(r.scope, "home");
    assert.equal(classifyGeographicScope(["Remote - India"], "", "", "Engineer").scope, "specific-country");
  });

  it("argentina-remote: detects country-specific remote", () => {
    const result = classifyGeographicScope(
      ["Argentina Remote"],
      "Argentina Remote",
      "We are looking for engineers in Argentina.",
      "Software Engineer"
    );
    assert.equal(result.scope, "specific-country");
  });

  it("remote-us: detects 'Remote, United States'", () => {
    const result = classifyGeographicScope(
      ["Remote, United States"],
      "Remote, United States",
      "",
      "Software Engineer"
    );
    assert.equal(result.scope, "specific-country");
  });

  it("remote-no-scope: bare 'Remote' is unknown", () => {
    const result = classifyGeographicScope(
      [],
      "",
      "This is a remote position.",
      "Remote Software Engineer"
    );
    assert.equal(result.scope, "unknown");
  });

  it("remote-worldwide: detects worldwide scope", () => {
    const result = classifyGeographicScope(
      ["Remote worldwide"],
      "Remote worldwide",
      "",
      "Senior Engineer"
    );
    assert.equal(result.scope, "worldwide");
  });

  it("opentrain: detects explicit worldwide eligibility in body text", () => {
    const bodyText = [
      "This fully remote contractor assignment runs 4 to 8 weeks.",
      "100% Remote Worldwide Eligibility.",
      "Open worldwide.",
    ].join(" ");
    const result = classifyGeographicScope([], "", bodyText, "Senior Coding-Agent Benchmark Engineer");

    assert.equal(result.scope, "worldwide");

    const job = makeScoredJob({
      geographicScope: result.scope,
      workMode: "remote",
      availabilityStatus: "confirmed-live",
      freshness: "verified-week",
    });
    assert.equal(classifyVerificationOutcome(job), "verified-fresh");
    assert.equal(isEligibleForOutput(job).ok, true);
  });

  it("remote-emea: detects EMEA scope", () => {
    const result = classifyGeographicScope(
      ["Remote EMEA"],
      "Remote EMEA",
      "",
      "Engineer"
    );
    assert.equal(result.scope, "region");
    assert.equal(result.region, "EMEA");
  });

  it("detects the candidate's own country in location", () => {
    const result = classifyGeographicScope(
      ["Istanbul, Turkey"],
      "",
      "",
      "Engineer"
    );
    assert.equal(result.scope, "home");
  });

  it("detects authorization requirement", () => {
    const result = classifyGeographicScope(
      [],
      "",
      "Must have work authorization in the United States.",
      "Engineer"
    );
    assert.equal(result.scope, "specific-country");
  });

  it("structural restriction: all locations restricted", () => {
    const result = classifyGeographicScope(
      ["United States", "Canada"],
      "",
      "",
      "Engineer"
    );
    assert.equal(result.scope, "specific-country");
  });

  it("Greece in displayed location is restricted", () => {
    const result = classifyGeographicScope(
      [],
      "Athens, Greece",
      "",
      "Engineer"
    );
    assert.equal(result.scope, "specific-country");
    assert.ok(result.restrictedCountry?.includes("Greece"));
  });

  it("global-title-override: 'Global' in title does NOT override restricted location", () => {
    // Regression: previously returned 'worldwide' because title was checked for open-scope
    const result = classifyGeographicScope(
      ["United States"],
      "",
      "",
      "Global Software Engineer"
    );
    assert.equal(result.scope, "specific-country");
  });

  it("restrictions run before open-scope: 'must be based in Austria' beats worldwide displayedLocation", () => {
    const result = classifyGeographicScope(
      [],
      "Remote worldwide",
      "Candidates must be based in Austria.",
      "Engineer"
    );
    assert.equal(result.scope, "specific-country");
  });
});

// ── classifyFreshness ───────────────────────────────────────────────────────

describe("classifyFreshness", () => {
  it("old-job: datePosted 60 days ago is old", () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3_600_000).toISOString();
    assert.equal(classifyFreshness(sixtyDaysAgo), "old");
  });

  it("recent job within 24h", () => {
    const recent = new Date(Date.now() - 12 * 3_600_000).toISOString();
    assert.equal(classifyFreshness(recent), "verified-24h");
  });

  it("job within 1 week", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    assert.equal(classifyFreshness(threeDaysAgo), "verified-week");
  });

  it("undefined date returns date-unknown", () => {
    assert.equal(classifyFreshness(undefined), "date-unknown");
  });

  it("invalid date returns date-unknown", () => {
    assert.equal(classifyFreshness("not-a-date"), "date-unknown");
  });
});

// ── classifyPageType ────────────────────────────────────────────────────────

describe("classifyPageType", () => {
  it("ats-job URL classification is by pattern, not HTTP status", () => {
    const result = classifyPageType(
      "https://jobs.lever.co/acme/12345678-1234-1234-1234-123456789abc",
      false
    );
    assert.equal(result, "ats-job");
  });

  it("career index page", () => {
    assert.equal(classifyPageType("https://example.com/careers", false), "career-index");
  });

  it("direct job with JSON-LD", () => {
    assert.equal(classifyPageType("https://example.com/job/123", true), "direct-job");
  });
});

// ── classifyVerificationOutcome ─────────────────────────────────────────────

describe("classifyVerificationOutcome", () => {
  it("ideal job → verified-fresh", () => {
    assert.equal(classifyVerificationOutcome(makeVerifiedJob()), "verified-fresh");
  });

  it("confirmed-closed (404) → rejected", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({
        availabilityStatus: "confirmed-closed",
        rejectionReason: "closed",
      })),
      "rejected"
    );
  });

  it("fetch-timeout → rejected", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({
        availabilityStatus: "fetch-failed",
        fetchStatus: "timeout",
        freshness: "date-unknown",
        rejectionReason: "fetch-failed",
      })),
      "rejected"
    );
  });

  it("unverified availability → rejected (fail-closed)", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ availabilityStatus: "unverified" })),
      "rejected"
    );
  });

  it("unknown work mode → rejected (fail-closed)", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ workMode: "unknown" })),
      "rejected"
    );
  });

  it("hybrid work mode → rejected", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ workMode: "hybrid" })),
      "rejected"
    );
  });

  it("onsite work mode → rejected", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ workMode: "onsite" })),
      "rejected"
    );
  });

  it("geo-restricted (Argentina) → rejected", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({
        geographicScope: "specific-country",
        rejectionReason: "geo-restricted",
      })),
      "rejected"
    );
  });

  it("stale job (freshness=old) → rejected", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ freshness: "old", rejectionReason: "old" })),
      "rejected"
    );
  });

  it("non-job page (career-index) → rejected", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ pageType: "career-index" })),
      "rejected"
    );
  });

  it("worldwide + date-unknown → needs-date", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ freshness: "date-unknown" })),
      "needs-date"
    );
  });

  it("unknown geographic scope → uncertain (→ LLM)", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ geographicScope: "unknown" })),
      "uncertain"
    );
  });

  it("home scope → verified-fresh", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ geographicScope: "home" })),
      "verified-fresh"
    );
  });

  it("open region scope → verified-fresh", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ geographicScope: "region", openRegion: "EMEA" })),
      "verified-fresh"
    );
  });
});

// ── isEligibleForOutput ─────────────────────────────────────────────────────

describe("isEligibleForOutput", () => {
  it("fully valid job passes", () => {
    const { ok } = isEligibleForOutput(makeScoredJob());
    assert.equal(ok, true);
  });

  it("unverified availability fails", () => {
    const { ok, violations } = isEligibleForOutput(
      makeScoredJob({ availabilityStatus: "unverified" })
    );
    assert.equal(ok, false);
    assert.ok(violations.some((v) => v.includes("availabilityStatus")));
  });

  it("unknown work mode fails", () => {
    const { ok, violations } = isEligibleForOutput(makeScoredJob({ workMode: "unknown" }));
    assert.equal(ok, false);
    assert.ok(violations.some((v) => v.includes("workMode")));
  });

  it("hybrid work mode fails", () => {
    const { ok } = isEligibleForOutput(makeScoredJob({ workMode: "hybrid" }));
    assert.equal(ok, false);
  });

  it("specific-country scope fails", () => {
    const { ok } = isEligibleForOutput(
      makeScoredJob({ geographicScope: "specific-country" })
    );
    assert.equal(ok, false);
  });

  it("unknown scope fails", () => {
    const { ok } = isEligibleForOutput(makeScoredJob({ geographicScope: "unknown" }));
    assert.equal(ok, false);
  });

  it("missing scope fails", () => {
    const { ok } = isEligibleForOutput(makeScoredJob({ geographicScope: undefined }));
    assert.equal(ok, false);
  });

  it("old freshness fails", () => {
    const { ok } = isEligibleForOutput(makeScoredJob({ freshness: "old" }));
    assert.equal(ok, false);
  });

  it("job with rejectionReason fails", () => {
    const { ok } = isEligibleForOutput(makeScoredJob({ rejectionReason: "geo-restricted" }));
    assert.equal(ok, false);
  });

  it("invalid LLM result cannot produce an eligible job if scope is unknown", () => {
    // uncertain LLM result doesn't modify job fields — original scope=unknown still fails
    const job = makeScoredJob({
      geographicScope: "unknown",
      llmEligibility: { status: "uncertain", evidence: "Parse error: garbage", confidence: 0 },
    });
    const { ok } = isEligibleForOutput(job);
    assert.equal(ok, false);
  });

  it("high-confidence eligible LLM result confirms an unknown geographic scope", () => {
    const job = makeScoredJob({
      geographicScope: "unknown",
      llmEligibility: { status: "eligible", evidence: "Explicitly open worldwide", confidence: 0.9 },
    });
    const { ok } = isEligibleForOutput(job);
    assert.equal(ok, true);
  });

  it("low-confidence eligible LLM result cannot confirm an unknown scope", () => {
    const job = makeScoredJob({
      geographicScope: "unknown",
      llmEligibility: { status: "eligible", evidence: "Possibly worldwide", confidence: 0.8 },
    });
    const { ok } = isEligibleForOutput(job);
    assert.equal(ok, false);
  });
});

// ── Legacy fail-closed decision tests ───────────────────────────────────────

describe("fail-closed decision logic", () => {
  it("hybrid detection overrides remote signals", () => {
    const result = classifyWorkMode(
      undefined,
      undefined,
      "",
      "We are a fully remote global team. This hybrid role requires 2 days in office.",
      "Senior Engineer"
    );
    assert.equal(result.mode, "hybrid");
  });

  it("onsite ATS workplaceType wins", () => {
    const result = classifyWorkMode(undefined, "on_site", "", "fully remote description", "Remote Engineer");
    assert.equal(result.mode, "onsite");
  });
});

// ── Extra sources ────────────────────────────────────────────────────────────

import { companyFromHeadline } from "../sources/funding-news.ts";
import { isRelevantTitle, slugCandidates, toSourceJobs } from "../sources/boards.ts";

describe("companyFromHeadline", () => {
  it("extracts the company from funding headlines", () => {
    assert.equal(companyFromHeadline("Acme Robotics raises $20M Series A led by Sequoia"), "Acme Robotics");
    assert.equal(companyFromHeadline("Startup Causa Prima secures seed round"), "Causa Prima");
  });
  it("rejects descriptors and non-headlines", () => {
    assert.equal(companyFromHeadline("Israeli startup raises $5M"), null);
    assert.equal(companyFromHeadline("How to raise a Series A"), null);
  });
});

describe("slugCandidates", () => {
  it("builds slugs from name and website, skipping short ones", () => {
    const s = slugCandidates("Hugging Face", "https://huggingface.co");
    assert.ok(s.includes("huggingface") && s.includes("hugging-face"));
    assert.deepEqual(slugCandidates("Ox"), []);
  });
});

describe("toSourceJobs", () => {
  const base = { url: "https://jobs.ashbyhq.com/acme/1", postedAt: new Date().toISOString() };
  it("keeps remote engineering jobs and drops onsite, non-engineering and country-bound ones", () => {
    const out = toSourceJobs(
      [
        { ...base, title: "Senior AI Engineer", location: "Remote, Global", remote: true },
        { ...base, title: "Senior AI Engineer", location: "New York", remote: false },
        { ...base, title: "Account Executive", location: "Remote", remote: true },
        { ...base, title: "Software Engineer", location: "Remote - United States", remote: true },
        { ...base, title: "Software Engineer", location: "Toronto; Ottawa", remote: true },
      ],
      "Acme",
      "test"
    );
    assert.equal(out.length, 1);
    assert.match(out[0]!.title, /Senior AI Engineer/);
  });
  it("drops jobs older than the freshness window", () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const out = toSourceJobs(
      [{ ...base, postedAt: old, title: "Software Engineer", location: "Remote", remote: true }],
      "Acme",
      "test"
    );
    assert.equal(out.length, 0);
  });
  it("matches role titles", () => {
    assert.ok(isRelevantTitle("Founding Engineer"));
    assert.ok(!isRelevantTitle("Engineering Manager"));
  });
});

// ── Candidate regions, JSON-LD fields, new sources ───────────────────────────

import { candidate } from "../candidate.ts";
import { extractApplicantLocations, extractSalary, isRecruitingAgency } from "../extractor.ts";
import { braveFreshness, searchWindowDays } from "../search.ts";
import { boardFromUrl } from "../sources/company-boards.ts";
import { pickApplyUrl, postedAtToIso, toBoardJob } from "../sources/google-jobs.ts";
import { indexUrlFor, jobLinks } from "../sources/watched-sites.ts";

// Real posting (argusrecruit.com/jobs/AR-SSE01), trimmed
const ARGUS_JSONLD = {
  "@type": "JobPosting",
  title: "Senior Software Engineer",
  description: "<p>ArgusRecruit is recruiting on behalf of an international AI-first company on a confidential basis.</p>",
  datePosted: "2026-10-27T08:56:47Z",
  hiringOrganization: { "@type": "Organization", name: "ArgusRecruit" },
  jobLocationType: "TELECOMMUTE",
  applicantLocationRequirements: { "@type": "Country", name: "Europe / MENA" },
  baseSalary: {
    "@type": "MonetaryAmount",
    currency: "USD",
    value: { "@type": "QuantitativeValue", minValue: 85000, maxValue: 120000, unitText: "YEAR" },
  },
};

describe("candidate regions", () => {
  const saved = { c: process.env.CANDIDATE_COUNTRY, r: process.env.CANDIDATE_REGIONS };
  after(() => {
    saved.c === undefined ? delete process.env.CANDIDATE_COUNTRY : (process.env.CANDIDATE_COUNTRY = saved.c);
    saved.r === undefined ? delete process.env.CANDIDATE_REGIONS : (process.env.CANDIDATE_REGIONS = saved.r);
  });

  it("derives regions from the country", () => {
    delete process.env.CANDIDATE_REGIONS;
    process.env.CANDIDATE_COUNTRY = "Turkey";
    assert.deepEqual(candidate().regions, ["EMEA", "MENA"]);
    process.env.CANDIDATE_COUNTRY = "Brazil";
    assert.deepEqual(candidate().regions, ["LATAM", "Americas"]);
    delete process.env.CANDIDATE_COUNTRY;
    assert.deepEqual(candidate().regions, []);
  });

  it("CANDIDATE_REGIONS overrides the derived list", () => {
    process.env.CANDIDATE_COUNTRY = "Turkey";
    process.env.CANDIDATE_REGIONS = "emea, Europe";
    assert.deepEqual(candidate().regions, ["EMEA", "Europe"]);
    delete process.env.CANDIDATE_REGIONS;
  });

  it("a region the candidate is in is open; other regions are restricted", () => {
    process.env.CANDIDATE_COUNTRY = "Turkey";
    const mena = classifyGeographicScope(["Europe / MENA"], "", "", "Engineer");
    assert.equal(mena.scope, "region");
    assert.equal(mena.region, "MENA");
    assert.equal(classifyGeographicScope(["Remote - LATAM"], "", "", "Engineer").scope, "specific-country");
    assert.equal(classifyGeographicScope(["Europe"], "", "", "Engineer").scope, "unknown");

    process.env.CANDIDATE_COUNTRY = "Brazil";
    assert.equal(classifyGeographicScope(["Remote - LATAM"], "", "", "Engineer").scope, "region");
    assert.equal(classifyGeographicScope(["Remote EMEA"], "", "", "Engineer").scope, "specific-country");

    process.env.CANDIDATE_COUNTRY = "Germany";
    assert.equal(classifyGeographicScope(["Europe"], "", "", "Engineer").scope, "region");
  });

  it("without a country, regional jobs are left for the AI check", () => {
    delete process.env.CANDIDATE_COUNTRY;
    assert.equal(classifyGeographicScope(["Remote EMEA"], "", "", "Engineer").scope, "unknown");
    assert.equal(classifyGeographicScope(["Remote - LATAM"], "", "", "Engineer").scope, "unknown");
  });
});

describe("JobPosting fields", () => {
  it("reads applicantLocationRequirements in its shapes", () => {
    assert.deepEqual(extractApplicantLocations(ARGUS_JSONLD), ["Europe / MENA"]);
    assert.deepEqual(
      extractApplicantLocations({
        applicantLocationRequirements: ["Turkey", { "@type": "Country", address: { addressCountry: "DE" } }],
      }),
      ["Turkey", "DE"]
    );
    assert.deepEqual(extractApplicantLocations({}), []);
  });

  it("converts salaries to monthly USD", () => {
    assert.deepEqual(extractSalary(ARGUS_JSONLD), {
      min: 85000, max: 120000, currency: "USD", unit: "YEAR", monthlyUsd: 10000,
    });
    assert.equal(extractSalary({ baseSalary: { currency: "USD", value: { value: 20, unitText: "HOUR" } } })?.monthlyUsd, 3200);
    assert.equal(extractSalary({ baseSalary: { currency: "TRY", value: { maxValue: 90000, unitText: "MONTH" } } })?.monthlyUsd, undefined);
    assert.equal(extractSalary({}), undefined);
  });

  it("flags recruiting agencies", () => {
    assert.ok(isRecruitingAgency("ArgusRecruit", ""));
    assert.ok(isRecruitingAgency("Acme", "We are hiring on behalf of our client, a fintech."));
    assert.ok(!isRecruitingAgency("Acme", "Join our team"));
  });

  it("the Argus posting is an eligible remote job for a candidate in Turkey", () => {
    const saved = process.env.CANDIDATE_COUNTRY;
    process.env.CANDIDATE_COUNTRY = "Turkey";
    const geo = classifyGeographicScope(extractApplicantLocations(ARGUS_JSONLD), "", "", "Senior Software Engineer");
    saved === undefined ? delete process.env.CANDIDATE_COUNTRY : (process.env.CANDIDATE_COUNTRY = saved);
    assert.equal(geo.scope, "region");
    assert.equal(
      classifyWorkMode("TELECOMMUTE", undefined, "", "", "Senior Software Engineer").mode,
      "remote"
    );
  });
});

describe("search window", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  it("looks back to the last run plus a day, 1–7 days", () => {
    assert.equal(searchWindowDays(undefined, now), 7);
    assert.equal(searchWindowDays("2026-11-03T06:00:00Z", now), 2);
    assert.equal(searchWindowDays("2026-11-03T11:30:00Z", now), 2);
    assert.equal(searchWindowDays("2026-10-01T00:00:00Z", now), 7);
  });
  it("maps to Brave freshness", () => {
    assert.equal(braveFreshness(1), "pd");
    assert.equal(braveFreshness(7), "pw");
    assert.equal(braveFreshness(3, new Date(now)), "2026-10-31to2026-11-03");
  });
});

describe("company registry", () => {
  it("reads the ATS board from a job URL", () => {
    assert.deepEqual(boardFromUrl("https://jobs.ashbyhq.com/Acme/1234"), { ats: "ashby", slug: "Acme" });
    assert.deepEqual(boardFromUrl("https://job-boards.greenhouse.io/acme/jobs/1"), { ats: "greenhouse", slug: "acme" });
    assert.equal(boardFromUrl("https://apply.workable.com/j/ABC"), null);
    assert.equal(boardFromUrl("https://jobs.lever.co/jobgether/123"), null);
    assert.equal(boardFromUrl("https://example.com/jobs/1"), null);
  });
  it("keeps startup titles", () => {
    assert.ok(isRelevantTitle("Member of Technical Staff"));
    assert.ok(isRelevantTitle("Forward Deployed Engineer"));
    assert.ok(isRelevantTitle("Solutions Engineer"));
    assert.ok(!isRelevantTitle("Solutions Architect"));
  });
});

describe("google jobs", () => {
  it("parses posted_at", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    assert.equal(postedAtToIso("3 days ago", now), "2026-10-31T12:00:00.000Z");
    assert.equal(postedAtToIso("21 hours ago", now), "2026-11-02T15:00:00.000Z");
    assert.equal(postedAtToIso(undefined, now), undefined);
  });
  it("prefers the employer's own apply link over aggregators", () => {
    const job = {
      title: "Senior Software Engineer",
      company_name: "ArgusRecruit",
      location: "Anywhere",
      apply_options: [
        { title: "LinkedIn", link: "https://www.linkedin.com/jobs/view/1" },
        { title: "ArgusRecruit", link: "https://argusrecruit.com/jobs/AR-SSE01/" },
      ],
    };
    assert.equal(pickApplyUrl(job), "https://argusrecruit.com/jobs/AR-SSE01/");
    assert.equal(toBoardJob(job)?.remote, true);
    assert.equal(toBoardJob({ ...job, apply_options: [job.apply_options[0]!] }), null);
  });
});

describe("watched sites", () => {
  it("finds the job index of a page", () => {
    assert.equal(indexUrlFor("https://argusrecruit.com/jobs/AR-SSE01/"), "https://argusrecruit.com/jobs/");
    assert.equal(indexUrlFor("https://acme.com/senior-engineer"), null);
  });
  it("lists job links under the index with their card heading", () => {
    const html = `
      <a href="/jobs/">All jobs</a>
      <a class="job-card" href="/jobs/AR-SSE01/"><div><h3>Senior Software Engineer</h3><span>Remote</span></div></a>
      <a href="/jobs/AR-FDE01/">Forward Deployed Engineer</a>
      <a href="/about/">About</a>
      <a href="https://other.com/jobs/x">Elsewhere</a>`;
    assert.deepEqual(jobLinks(html, "https://argusrecruit.com/jobs/"), [
      { url: "https://argusrecruit.com/jobs/AR-SSE01/", title: "Senior Software Engineer" },
      { url: "https://argusrecruit.com/jobs/AR-FDE01/", title: "Forward Deployed Engineer" },
    ]);
  });
});

// ── Aggregators: RemoteOK, Himalayas, Wellfound ─────────────────────────────

import { himalayasListings, parseWellfoundTitle, remoteOkListings, wellfoundListings } from "../sources/aggregators.ts";
import { matchPosting, normalizeTitle, titleSimilarity } from "../sources/company-boards.ts";
import { isBlocked } from "../filters.ts";
import { fromListing } from "../verify.ts";

describe("employer posting match", () => {
  it("normalizes titles", () => {
    assert.equal(normalizeTitle("Senior Software Engineer (Remote, EU)"), "senior software engineer");
    assert.equal(normalizeTitle("Full-Stack Engineer – Remote"), "full stack engineer");
  });
  it("matches the same role, not a neighbour", () => {
    const board = [
      { title: "Senior Software Engineer, Platform", url: "https://jobs.ashbyhq.com/acme/1", location: "Remote", remote: true },
      { title: "Senior Software Engineer", url: "https://jobs.ashbyhq.com/acme/2", location: "Remote", remote: true },
      { title: "Engineering Manager", url: "https://jobs.ashbyhq.com/acme/3", location: "Remote", remote: true },
    ];
    assert.equal(matchPosting(board, "Senior Software Engineer (Remote)")?.url, "https://jobs.ashbyhq.com/acme/2");
    assert.equal(matchPosting(board, "Data Analyst"), undefined);
    assert.ok(titleSimilarity("Senior Software Engineer, Platform", "Senior Software Engineer") < 0.8);
  });
});

describe("aggregator listings", () => {
  const recent = new Date(Date.now() - 3_600_000).toISOString();

  it("RemoteOK: relevant, recent, not country-restricted; ATS link in the description wins", () => {
    const api = [
      { legal: "API Terms of Service" },
      { position: "AI ML Engineer", company: "Docusketch", date: recent, location: "", url: "https://remoteOK.com/remote-jobs/x-1", description: "Apply at https://jobs.lever.co/docusketch/abc-123" },
      { position: "Account Executive", company: "Capmo", date: recent, location: "", url: "https://remoteok.com/remote-jobs/x-2" },
      { position: "Backend Engineer", company: "Acme", date: recent, location: "United States", url: "https://remoteok.com/remote-jobs/x-3" },
      { position: "Backend Engineer", company: "Old", date: "2020-01-01T00:00:00Z", location: "", url: "https://remoteok.com/remote-jobs/x-4" },
    ];
    const out = remoteOkListings(api);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.url, "https://remoteok.com/remote-jobs/x-1");
    assert.equal(out[0]!.atsLink, "https://jobs.lever.co/docusketch/abc-123");
    assert.equal(out[0]!.listing.applicantLocations, undefined);
  });

  it("Himalayas: keeps who-may-apply lists and strips tracking", () => {
    const out = himalayasListings([
      { title: "Senior Ruby on Rails Developer", companyName: "OnTheGoSystems", pubDate: Date.now() / 1000 - 3600, locationRestrictions: ["Turkey", "Germany"], guid: "https://himalayas.app/companies/otgs/jobs/rails" },
      { title: "Software Engineer", companyName: "Alien Intellect", pubDate: Date.now() / 1000 - 3600, locationRestrictions: [], applicationLink: "https://himalayas.app/companies/ai/jobs/se?utm_source=api" },
      { title: "Customer Support Specialist", companyName: "X", pubDate: Date.now() / 1000, locationRestrictions: [], guid: "https://himalayas.app/x" },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0]!.listing.applicantLocations, ["Turkey", "Germany"]);
    assert.equal(out[1]!.url, "https://himalayas.app/companies/ai/jobs/se");
    assert.deepEqual(out[1]!.listing.applicantLocations, []);
  });

  it("Wellfound: parses Brave result titles", () => {
    assert.deepEqual(parseWellfoundTitle("Senior AI Engineer at Niuro • Remote • Remote (Work from Home) | Wellfound"), {
      title: "Senior AI Engineer", company: "Niuro", places: ["Remote", "Remote (Work from Home)"], remote: true,
    });
    assert.equal(parseWellfoundTitle("Product Engineer at Docflow labs • Los Angeles | Wellfound")?.remote, false);
    assert.equal(parseWellfoundTitle("Frontend Engineer at Confidential Company • California | Wellfound"), null);
    assert.equal(parseWellfoundTitle("Find Startup Jobs Near You and Remote Jobs | Wellfound"), null);
    const out = wellfoundListings([
      { url: "https://wellfound.com/jobs/4824735-senior-ai-engineer", title: "Senior AI Engineer at Niuro • Remote • Remote (Work from Home) | Wellfound" },
      { url: "https://wellfound.com/company/niuro", title: "Niuro | Wellfound" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.listing.via, "wellfound");
  });
});

describe("listing fallback in verify", () => {
  const saved = process.env.CANDIDATE_COUNTRY;
  before(() => { process.env.CANDIDATE_COUNTRY = "Turkey"; });
  after(() => { saved === undefined ? delete process.env.CANDIDATE_COUNTRY : (process.env.CANDIDATE_COUNTRY = saved); });
  const job = {
    title: "Senior Ruby on Rails Developer — OnTheGoSystems",
    url: "https://himalayas.app/companies/otgs/jobs/rails",
    description: "",
    extraSnippets: [],
    foundByQueries: ["source:himalayas"],
    sourceDomain: "himalayas.app",
    discoveredAt: new Date().toISOString(),
  };

  it("aggregator domains pass only when the job carries a listing", () => {
    assert.ok(isBlocked(job));
    assert.ok(!isBlocked({ ...job, listing: { via: "himalayas" } }));
  });

  it("a listing open to the candidate's country is a fresh remote candidate", () => {
    const listing = { via: "himalayas" as const, company: "OnTheGoSystems", datePosted: new Date().toISOString(), applicantLocations: ["Germany", "Turkey"], remote: true };
    const v = fromListing({ ...job, listing }, listing, new Date().toISOString(), []);
    assert.equal(v.geographicScope, "home");
    assert.equal(classifyVerificationOutcome(v), "verified-fresh");
  });

  it("worldwide listing ([]), restricted listing, and undated Wellfound listing", () => {
    const now = new Date().toISOString();
    const ww = { via: "himalayas" as const, datePosted: now, applicantLocations: [], remote: true };
    assert.equal(fromListing({ ...job, listing: ww }, ww, now, []).geographicScope, "worldwide");
    const us = { via: "himalayas" as const, datePosted: now, applicantLocations: ["United States"], remote: true };
    assert.equal(classifyVerificationOutcome(fromListing({ ...job, listing: us }, us, now, [])), "rejected");
    const wf = { via: "wellfound" as const, remote: true, description: "Remote (Work from Home)" };
    assert.equal(classifyVerificationOutcome(fromListing({ ...job, listing: wf }, wf, now, [])), "uncertain");
  });
});

describe("classifyGeographicScope: region named in the title", () => {
  const saved = process.env.CANDIDATE_COUNTRY;
  before(() => { process.env.CANDIDATE_COUNTRY = "Turkey"; });
  after(() => { saved === undefined ? delete process.env.CANDIDATE_COUNTRY : (process.env.CANDIDATE_COUNTRY = saved); });
  it("title 'EMEA y Norteamérica' with no location → region open to a Turkey candidate", () => {
    const r = classifyGeographicScope([], "", "Debes residir en EMEA o Norteamérica.", "Senior Security Engineer EMEA y Norteamérica (100% remoto)");
    assert.equal(r.scope, "region");
    assert.equal(r.region, "EMEA");
  });
  it("body 'Residir en EMEA o Norteamérica' with no location or title hint → region", () => {
    const r = classifyGeographicScope([], "", "📍 Residir en EMEA o Norteamérica.", "Senior Security Engineer");
    assert.equal(r.scope, "region");
  });
  it("a bare 'across EMEA' in the body is not a residence requirement", () => {
    const r = classifyGeographicScope([], "", "Our team is spread across EMEA.", "Engineer");
    assert.equal(r.scope, "unknown");
  });
});
