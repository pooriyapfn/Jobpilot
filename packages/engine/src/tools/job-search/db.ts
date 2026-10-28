import { createHash } from "crypto";
import { DatabaseSync } from "node:sqlite";
import type { ScoredJob } from "./types.ts";

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS jobs (
  id                   TEXT PRIMARY KEY,
  canonical_url        TEXT NOT NULL UNIQUE,
  title                TEXT,
  company              TEXT,
  page_type            TEXT,
  freshness            TEXT,
  date_posted          TEXT,
  remote               INTEGER,
  location_eligibility TEXT,
  llm_status           TEXT,
  llm_evidence         TEXT,
  llm_confidence       REAL,
  fit_score            INTEGER,
  fit_highlights       TEXT,
  fit_gaps             TEXT,
  fit_summary          TEXT,
  fit_classification   TEXT,
  fit_reasons          TEXT,
  resume_md_path       TEXT,
  resume_docx_path     TEXT,
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  notified             INTEGER DEFAULT 0,
  raw_json             TEXT
);
`;

export function initDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(CREATE_TABLE);
  const migrations = [
    "ALTER TABLE jobs ADD COLUMN fit_classification TEXT",
    "ALTER TABLE jobs ADD COLUMN fit_reasons TEXT",
    "ALTER TABLE jobs ADD COLUMN resume_md_path TEXT",
    "ALTER TABLE jobs ADD COLUMN resume_docx_path TEXT",
    "ALTER TABLE jobs ADD COLUMN work_mode TEXT",
    "ALTER TABLE jobs ADD COLUMN availability_status TEXT",
    "ALTER TABLE jobs ADD COLUMN displayed_location TEXT",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  return db;
}

export function makeId(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 16);
}

export function upsertJob(db: DatabaseSync, job: ScoredJob): string {
  const id = makeId(job.url);
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT first_seen_at, notified FROM jobs WHERE canonical_url = ?")
    .get(job.url) as { first_seen_at: string; notified: number } | undefined;

  const firstSeenAt = existing?.first_seen_at ?? now;
  const notified = existing?.notified ?? 0;

  db.prepare(`
    INSERT INTO jobs (
      id, canonical_url, title, company, page_type, freshness, date_posted, remote,
      location_eligibility, llm_status, llm_evidence, llm_confidence,
      fit_score, fit_highlights, fit_gaps, fit_summary,
      fit_classification, fit_reasons, resume_md_path, resume_docx_path,
      first_seen_at, last_seen_at, notified, raw_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(canonical_url) DO UPDATE SET
      title                = excluded.title,
      company              = excluded.company,
      page_type            = excluded.page_type,
      freshness            = excluded.freshness,
      date_posted          = excluded.date_posted,
      remote               = excluded.remote,
      location_eligibility = excluded.location_eligibility,
      llm_status           = excluded.llm_status,
      llm_evidence         = excluded.llm_evidence,
      llm_confidence       = excluded.llm_confidence,
      fit_score            = excluded.fit_score,
      fit_highlights       = excluded.fit_highlights,
      fit_gaps             = excluded.fit_gaps,
      fit_summary          = excluded.fit_summary,
      fit_classification   = COALESCE(excluded.fit_classification, fit_classification),
      fit_reasons          = COALESCE(excluded.fit_reasons, fit_reasons),
      resume_md_path       = COALESCE(excluded.resume_md_path, resume_md_path),
      resume_docx_path     = COALESCE(excluded.resume_docx_path, resume_docx_path),
      last_seen_at         = excluded.last_seen_at,
      raw_json             = excluded.raw_json
  `).run(
    id,
    job.url,
    job.title ?? null,
    job.company ?? null,
    job.pageType ?? null,
    job.freshness ?? null,
    job.datePosted ?? null,
    job.remote === undefined ? null : job.remote ? 1 : 0,
    job.locationEligibility ?? null,
    job.llmEligibility?.status ?? null,
    job.llmEligibility?.evidence ?? null,
    job.llmEligibility?.confidence ?? null,
    null, // fit_score (legacy)
    null, // fit_highlights (legacy)
    job.fitGaps ? JSON.stringify(job.fitGaps) : null,
    null, // fit_summary (legacy)
    job.fitClassification ?? null,
    job.fitReasons ? JSON.stringify(job.fitReasons) : null,
    job.resumeMdPath ?? null,
    job.resumeDocxPath ?? null,
    firstSeenAt,
    now,
    notified,
    JSON.stringify(job)
  );

  return id;
}

export function getNewJobs(db: DatabaseSync): ScoredJob[] {
  const rows = db
    .prepare(
      `SELECT raw_json FROM jobs
       WHERE fit_classification IN ('STRONG_FIT', 'POSSIBLE_FIT') AND notified = 0
       ORDER BY CASE fit_classification WHEN 'STRONG_FIT' THEN 0 ELSE 1 END, last_seen_at DESC`
    )
    .all() as Array<{ raw_json: string }>;
  return rows.map((r) => JSON.parse(r.raw_json) as ScoredJob);
}

export function markNotified(db: DatabaseSync, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE jobs SET notified = 1 WHERE id IN (${placeholders})`).run(...ids);
}
