import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import type { Application, Status } from "./types.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec("PRAGMA busy_timeout = 5000"); // the server and pipeline child processes share this file
db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory (
    key TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    kind TEXT NOT NULL,          -- 'fact' (profile) | 'answer' (learned)
    updated_at TEXT NOT NULL
  );
`);

// The jobs repository. v1 (state/state_source/note, one mixed status) is rebuilt in place into
// independent eligibility / applied / note columns; nothing is lost.
const migrateListings = () => {
  const cols = (db.prepare("PRAGMA table_info(listings)").all() as { name: string }[]).map((c) => c.name);
  const create = (name: string) =>
    db.exec(`
      CREATE TABLE ${name} (
        id TEXT PRIMARY KEY,         -- same id as the Application it may become
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        date_posted TEXT,            -- only when the source says so
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        eligibility TEXT NOT NULL DEFAULT 'not-evaluated',
        eligibility_reason TEXT,
        eligibility_source TEXT,     -- 'search' | 'check' | 'you'
        evaluated_at TEXT,
        applied_at TEXT,
        location TEXT,
        user_note TEXT,              -- yours alone: searches and checks never write it
        deleted_at TEXT              -- tombstone: stops later searches from re-adding it
      )`);
  if (!cols.length) return create("listings");
  if (!cols.includes("state")) return; // already v2
  const stamp = new Date().toISOString();
  db.exec("BEGIN");
  try {
    create("listings_v2");
    db.prepare(`
      INSERT INTO listings_v2 (id, url, title, company, description, date_posted, added_at, updated_at, eligibility,
        eligibility_reason, eligibility_source, evaluated_at, applied_at, location, user_note, deleted_at)
      SELECT l.id, l.url, l.title, l.company, l.description, l.date_posted, l.added_at, ?,
        CASE l.state WHEN 'eligible' THEN 'eligible' WHEN 'not-eligible' THEN 'not-eligible' WHEN 'review' THEN 'review' ELSE 'not-evaluated' END,
        l.note,
        CASE WHEN l.state IN ('eligible','not-eligible','review') THEN CASE l.state_source WHEN 'user' THEN 'you' ELSE 'search' END END,
        CASE WHEN l.state IN ('eligible','not-eligible','review') THEN l.added_at END,
        CASE WHEN l.state = 'applied' THEN COALESCE((SELECT a.updated_at FROM applications a WHERE a.id = l.id AND a.status = 'submitted'), l.added_at) END,
        l.location, NULL, l.deleted_at
      FROM listings l`).run(stamp);
    db.exec("DROP TABLE listings; ALTER TABLE listings_v2 RENAME TO listings; COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};
migrateListings();

const now = () => new Date().toISOString();

export const saveApp = (app: Application): void => {
  app.updatedAt = now();
  db.prepare(
    `INSERT INTO applications (id, status, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(app.id, app.status, JSON.stringify(app), app.updatedAt);
};

export const getApp = (id: string): Application | undefined => {
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(id) as { data: string } | undefined;
  return row && JSON.parse(row.data);
};

export const listApps = (): Application[] =>
  (db.prepare("SELECT data FROM applications ORDER BY updated_at DESC").all() as { data: string }[])
    .map((r) => JSON.parse(r.data));

export const hasApp = (id: string): boolean =>
  !!db.prepare("SELECT 1 FROM applications WHERE id = ?").get(id);

export const setStatus = (id: string, status: Status, note?: string): void => {
  const app = getApp(id);
  if (!app) return;
  saveApp({ ...app, status, note: note ?? app.note });
  // A confirmed submission is also when you applied.
  if (status === "submitted") db.prepare("UPDATE listings SET applied_at = COALESCE(applied_at, ?) WHERE id = ?").run(now(), id);
};

export const deleteApp = (id: string): void => {
  db.prepare("DELETE FROM applications WHERE id = ?").run(id);
};
