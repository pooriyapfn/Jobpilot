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
    assert.equal(result.scope, "emea");
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

  it("emea scope → verified-fresh", () => {
    assert.equal(
      classifyVerificationOutcome(makeVerifiedJob({ geographicScope: "emea" })),
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
