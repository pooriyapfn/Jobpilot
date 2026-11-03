// The jobs repository: every job you've been shown, and what is known about it.
// Search results land here from eligible-jobs.json / uncertain.json; links you add by hand land here too.
// Eligibility, your note and "applied" are separate columns: changing one never rewrites another.
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Eligibility, EligibilitySource, JobActivity, JobListing, JobListingDetail, RemoveScope } from "@jobpilot/contracts";
import { config } from "./config.ts";
import { db, deleteApp, getApp, listApps, setStatus } from "./db.ts";
import { cleanText, previewText } from "./text.ts";
import { checkEligibility } from "./tools/job-search/eligibility.ts";
import { jobId } from "./tools/job-search/jobs.ts";
import type { EligibilityResult, VerifiedJob } from "./tools/job-search/types.ts";
import { verifyJob } from "./tools/job-search/verify.ts";

type Row = {
  id: string;
  url: string;
  title: string;
  company: string;
  description: string;
  date_posted: string | null;
  added_at: string;
  updated_at: string;
  eligibility: Eligibility;
  eligibility_reason: string | null;
  eligibility_source: EligibilitySource | null;
  evaluated_at: string | null;
  applied_at: string | null;
  location: string | null;
  user_note: string | null;
  deleted_at: string | null;
};

type Verdict = { eligibility: Eligibility; reason: string; source: EligibilitySource; at: string };

const now = () => new Date().toISOString();
const iso = (s?: string | null) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

const insert = db.prepare(`
  INSERT OR IGNORE INTO listings (id, url, title, company, description, date_posted, added_at, updated_at,
    eligibility, eligibility_reason, eligibility_source, evaluated_at, applied_at, location)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

// ── pipeline files → repository ──────────────────────────────────────────────

const SCOPE_LABEL: Record<string, string> = { home: "your own country", worldwide: "worldwide", emea: "EMEA" };
const scopeLabel = (j: VerifiedJob): string | undefined =>
  j.geographicScope === "region" ? j.openRegion ?? "your region" : j.geographicScope && SCOPE_LABEL[j.geographicScope];

type FeedJob = VerifiedJob & { llmEligibility?: EligibilityResult };

// JSON-LD descriptions are the posting itself; the page's visible text drags in menus and banners, so it's the fallback.
const describe = (j: FeedJob) => {
  const main = cleanText(j.description);
  const structured = j.jsonLdFound || j.verificationEvidence?.some((e) => e.field === "description");
  const body = main && (structured || main.length >= 400) ? main : cleanText(j.visibleText) || main;
  const extra = (j.extraSnippets ?? []).map(cleanText).filter(Boolean);
  return [body, ...(body ? [] : extra)].join("\n\n").trim();
};

const verdictFromSearch = (j: FeedJob, eligibility: Eligibility): Verdict => ({
  eligibility,
  source: "search",
  at: iso(j.verifiedAt) ?? now(),
  reason:
    j.llmEligibility?.evidence ||
    (eligibility === "eligible"
      ? `Remote${scopeLabel(j) ? `, open to ${scopeLabel(j)}` : ""}`
      : j.workMode !== "remote"
        ? `Work mode: ${j.workMode}`
        : "Whether it's open to your location isn't clear"),
});

const FEEDS: Array<{ file: string; eligibility: Eligibility }> = [
  { file: "eligible-jobs.json", eligibility: "eligible" },
  { file: "uncertain.json", eligibility: "review" },
];
const seenMtime = new Map<string, number>();

const readFeed = (file: string): FeedJob[] => {
  try {
    return JSON.parse(readFileSync(join(config.jobSearchDir, file), "utf8"));
  } catch {
    return []; // no search run yet
  }
};

/** Pulls new jobs from the latest pipeline run, and makes sure every application has a listing. Cheap when nothing changed. */
export const syncListings = (): void => {
  for (const { file, eligibility } of FEEDS) {
    let mtime = 0;
    try {
      mtime = statSync(join(config.jobSearchDir, file)).mtimeMs;
    } catch {
      continue;
    }
    if (seenMtime.get(file) === mtime) continue;
    seenMtime.set(file, mtime);
    for (const j of readFeed(file)) {
      const id = jobId(j.url);
      const v = verdictFromSearch(j, eligibility);
      const stamp = now();
      insert.run(
        id, j.url, cleanText(j.title) || j.url, j.company ?? "unknown", describe(j), iso(j.datePosted) ?? null,
        iso(j.discoveredAt) ?? stamp, stamp, v.eligibility, v.reason, v.source, v.at, null,
        j.displayedLocation || j.jobLocation?.join(", ") || null,
      );
      // A job the search first flagged "review" and later cleared is eligible, unless you already decided.
      if (eligibility === "eligible") {
        db.prepare(`UPDATE listings SET eligibility = 'eligible', eligibility_reason = ?, eligibility_source = 'search', evaluated_at = ?, updated_at = ?
                    WHERE id = ? AND eligibility = 'review' AND eligibility_source = 'search' AND deleted_at IS NULL`).run(v.reason, v.at, stamp, id);
      }
    }
  }
  for (const app of listApps()) {
    insert.run(
      app.id, app.url, app.title, app.company, cleanText(app.jd), null, app.updatedAt || now(), app.updatedAt || now(),
      "not-evaluated", null, null, null, app.status === "submitted" ? app.updatedAt || now() : null, null,
    );
  }
};

// ── background work (assess / prepare / regenerate / fill) ───────────────────

const busy = new Map<string, { kind: JobActivity; step?: string }>();
const failures = new Map<string, string>();

export class Busy extends Error {}

export type Step = (text: string) => void;

/** Runs `work` in the background, one at a time per job. The step it reports and any failure are kept for the app to show. */
export const runActivity = (id: string, kind: JobActivity, work: (step: Step) => Promise<void>): void => {
  if (busy.has(id)) throw new Busy(`Already ${busy.get(id)!.kind} this job`);
  const entry: { kind: JobActivity; step?: string } = { kind };
  busy.set(id, entry);
  failures.delete(id);
  work((text) => void (entry.step = text))
    .catch((e) => failures.set(id, e instanceof Error ? e.message : String(e)))
    .finally(() => busy.delete(id));
};

export const isBusy = (id: string) => busy.has(id);

// ── reads ────────────────────────────────────────────────────────────────────

const fileExists = (path?: string) => !!path && existsSync(path);

const toListing = (row: Row): JobListing => {
  const app = getApp(row.id);
  const work = busy.get(row.id);
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    company: row.company,
    eligibility: row.eligibility,
    eligibilityReason: row.eligibility_reason ?? undefined,
    eligibilitySource: row.eligibility_source ?? undefined,
    evaluatedAt: row.evaluated_at ?? undefined,
    datePosted: row.date_posted ?? undefined,
    addedAt: row.added_at,
    updatedAt: app && app.updatedAt > row.updated_at ? app.updatedAt : row.updated_at,
    snippet: previewText(row.description),
    location: row.location ?? undefined,
    userNote: row.user_note ?? undefined,
    appliedAt: row.applied_at ?? (app?.status === "submitted" ? app.updatedAt : undefined),
    applicationStatus: app?.status,
    resumeReady: fileExists(app?.resumePath),
    matchFit: app?.status === "skip-fit" ? "SKIP" : app?.fit,
    activity: work?.kind,
    activityStep: work?.step,
    activityError: failures.get(row.id),
  };
};

const rows = (): Row[] =>
  db.prepare("SELECT * FROM listings WHERE deleted_at IS NULL ORDER BY added_at DESC, id").all() as Row[];

const row = (id: string): Row | undefined =>
  db.prepare("SELECT * FROM listings WHERE id = ? AND deleted_at IS NULL").get(id) as Row | undefined;

export const listListings = (): JobListing[] => {
  syncListings();
  return rows().map(toListing);
};

export const getListing = (id: string): JobListingDetail | undefined => {
  syncListings();
  const r = row(id);
  if (!r) return undefined;
  const app = getApp(id);
  return {
    ...toListing(r),
    description: cleanText(r.description) || cleanText(app?.jd),
    matchNotes: app?.status === "skip-fit" ? app.note : undefined,
  };
};

/** Eligible jobs without an application yet: what "Prepare eligible jobs" works through, newest first. */
export const jobsToPrepare = () =>
  rows()
    .filter((r) => r.eligibility === "eligible" && r.applied_at === null && !getApp(r.id))
    .map((r) => ({ id: r.id, url: r.url, title: r.title, company: r.company, description: cleanText(r.description) }));

/** Every eligible listing, with its application status if it has one (the Prepare sheet's list). */
export const eligibleListings = (): JobListing[] => listListings().filter((l) => l.eligibility === "eligible" && !l.appliedAt);

// ── checking a posting ───────────────────────────────────────────────────────

const llmAvailable = () => !!process.env["OPENROUTER_API_KEY"];

/**
 * Hard requirements only: is it live, remote, and open to your location? How well your profile fits is a separate
 * judgement (the resume tailor's fit gate) and never changes this. Returns undefined when the page couldn't be read.
 */
export const judge = async (v: VerifiedJob): Promise<Verdict | undefined> => {
  const at = now();
  const verdict = (eligibility: Eligibility, reason: string): Verdict => ({ eligibility, reason, source: "check", at });
  if (v.fetchStatus !== "ok") return undefined;
  if (v.availabilityStatus === "confirmed-closed") return verdict("not-eligible", "The posting is closed");
  if (v.pageType !== "ats-job" && v.pageType !== "direct-job") return verdict("review", "This doesn't look like a single job posting");
  if (v.workMode === "hybrid" || v.workMode === "onsite") return verdict("not-eligible", `Not remote (${v.workMode})`);
  if (v.workMode !== "remote") return verdict("review", "Couldn't tell whether the job is remote");
  if (v.geographicScope === "specific-country") return verdict("not-eligible", "Restricted to a specific country");
  if (v.geographicScope && v.geographicScope !== "unknown") {
    return verdict("eligible", `Remote, open to ${scopeLabel(v) ?? v.geographicScope}`);
  }
  // Remote, but the location isn't stated: ask the model if there's a key, otherwise leave it to you.
  if (!llmAvailable()) return verdict("review", "Remote, but the location isn't stated. An AI check needs OPENROUTER_API_KEY.");
  const r = await checkEligibility(v).catch((): EligibilityResult => ({ status: "uncertain", evidence: "The AI check failed", confidence: 0 }));
  if (r.status === "eligible" && r.confidence >= 0.85) return verdict("eligible", r.evidence);
  if (r.status === "restricted" && r.confidence >= 0.85) return verdict("not-eligible", r.evidence);
  return verdict("review", r.evidence);
};

const probe = (url: URL) =>
  verifyJob({
    title: "", url: url.href, description: "", extraSnippets: [], foundByQueries: ["added by hand"],
    sourceDomain: url.hostname, discoveredAt: now(),
  });

const COULD_NOT_READ = "Couldn't read the page automatically. Open it to check, or try again later.";

const slug = (url: URL) =>
  decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? url.hostname).replace(/[-_]+/g, " ").trim() || url.hostname;

/** A link you pasted: read the page, take what it says, and rate it. */
export const addListing = async (rawUrl: string): Promise<{ listing: JobListing; existed: boolean }> => {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new TypeError("That doesn't look like a web link (http or https).");
  }
  url.hash = "";
  const id = jobId(url.href);

  const existing = row(id);
  if (existing) return { listing: toListing(existing), existed: true };

  const v = await probe(url);
  const verdict = await judge(v);
  const readable = v.fetchStatus === "ok";
  const title = cleanText(v.title) || slug(url);
  const company = v.company?.trim() || url.hostname.replace(/^(www|jobs|careers)\./, "");
  const stamp = now();

  // A link you removed earlier comes back when you add it again.
  db.prepare("DELETE FROM listings WHERE id = ? AND deleted_at IS NOT NULL").run(id);
  insert.run(
    id, url.href, title, company, readable ? describe(v) : "", iso(v.datePosted) ?? null, stamp, stamp,
    verdict?.eligibility ?? "not-evaluated", verdict?.reason ?? COULD_NOT_READ, verdict?.source ?? null, verdict?.at ?? null, null,
    v.displayedLocation || v.jobLocation?.join(", ") || null,
  );
  return { listing: toListing(row(id)!), existed: false };
};

/** Looks at the posting again and updates eligibility (and the description or date, if the page now has them). */
export const assessListing = async (id: string, step: Step): Promise<void> => {
  const r = row(id);
  if (!r) throw new Error("no such job");
  step("Reading the posting");
  const v = await probe(new URL(r.url));
  step("Checking eligibility");
  const verdict = await judge(v);
  if (!verdict) throw new Error(COULD_NOT_READ);
  const text = v.fetchStatus === "ok" ? describe(v) : "";
  db.prepare(`UPDATE listings SET eligibility = ?, eligibility_reason = ?, eligibility_source = ?, evaluated_at = ?, updated_at = ?,
    description = CASE WHEN ? != '' THEN ? ELSE description END, date_posted = COALESCE(?, date_posted) WHERE id = ?`)
    .run(verdict.eligibility, verdict.reason, verdict.source, verdict.at, now(), text, text, iso(v.datePosted) ?? null, id);
  syncApplicationToEligibility(id, verdict.eligibility);
};

// ── your decisions ───────────────────────────────────────────────────────────

// The application follows eligibility so a ruled-out job leaves the review queue (and rejoins when you reverse it).
const syncApplicationToEligibility = (id: string, eligibility: Eligibility) => {
  const app = getApp(id);
  if (!app) return;
  if (eligibility === "not-eligible" && ["prepared", "manual", "blocked", "error"].includes(app.status)) setStatus(id, "skipped");
  if (eligibility === "eligible" && app.status === "skipped") setStatus(id, app.fields.length ? "prepared" : "manual");
};

const BY_YOU: Record<Eligibility, string | null> = {
  "not-evaluated": null,
  eligible: "Marked eligible by you",
  "not-eligible": "Marked not eligible by you",
  review: "Marked for review by you",
};

export const setEligibility = (id: string, eligibility: Eligibility): boolean => {
  syncListings();
  if (!row(id)) return false;
  const reset = eligibility === "not-evaluated";
  db.prepare("UPDATE listings SET eligibility = ?, eligibility_reason = ?, eligibility_source = ?, evaluated_at = ?, updated_at = ? WHERE id = ?")
    .run(eligibility, BY_YOU[eligibility], reset ? null : "you", reset ? null : now(), now(), id);
  syncApplicationToEligibility(id, eligibility);
  return true;
};

/** You applied outside JobPilot (or confirm you did). Records when; the application, if any, becomes Submitted. */
export const markApplied = (id: string): boolean => {
  syncListings();
  if (!row(id)) return false;
  db.prepare("UPDATE listings SET applied_at = COALESCE(applied_at, ?), updated_at = ? WHERE id = ?").run(now(), now(), id);
  const app = getApp(id);
  if (app && app.status !== "submitted") setStatus(id, "submitted");
  return true;
};

export const setNote = (id: string, note: string): boolean => {
  syncListings();
  if (!row(id)) return false;
  db.prepare("UPDATE listings SET user_note = ?, updated_at = ? WHERE id = ?").run(note.trim() ? note : null, now(), id);
  return true;
};

const inside = (dir: string, file: string) => resolve(file).startsWith(resolve(dir) + sep);

/**
 * Takes the job off your list. The link stays remembered so a later search won't bring it back.
 * "listing" keeps the application, its history and files; "everything" also deletes the application and its resume files.
 */
export const removeListing = (id: string, scope: RemoveScope): boolean => {
  syncListings();
  if (!row(id)) return false;
  if (scope === "everything") {
    const resume = getApp(id)?.resumePath;
    deleteApp(id);
    for (const file of [resume, resume?.replace(/\.docx$/, ".md")]) {
      if (file && inside(config.resumesDir, file)) rmSync(file, { force: true });
    }
  }
  db.prepare("UPDATE listings SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
  return true;
};
