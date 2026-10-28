import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import type { Application, Status } from "./types.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

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
  if (app) saveApp({ ...app, status, note: note ?? app.note });
};
