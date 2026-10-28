import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { KnowledgeDocument, KnowledgeFile } from "@jobpilot/contracts";
import { config } from "../config.ts";
import { HttpError } from "./http.ts";

const MAX_BYTES = 1024 * 1024;
const isDoc = (name: string) => /\.(md|txt)$/i.test(name);

export const listKnowledge = (): KnowledgeFile[] => {
  const out: KnowledgeFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), path);
      else if (e.isFile() && isDoc(e.name) && !/\.example\.md$/i.test(e.name)) {
        const st = statSync(join(dir, e.name));
        out.push({ path, size: st.size, modifiedAt: st.mtime.toISOString() });
      }
    }
  };
  if (existsSync(config.knowledgeDir)) walk(config.knowledgeDir, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
};

// Maps a client-supplied relative path to a file inside knowledge/. Rejects traversal, dotfiles and symlink escapes.
const resolveSafe = (rel: string | null): string => {
  if (!rel) throw new HttpError(400, "missing ?path=");
  const parts = rel.split("/");
  if (rel.includes("\0") || rel.startsWith("/") || parts.some((p) => !p || p.startsWith("."))) throw new HttpError(400, "invalid path");
  if (!isDoc(rel)) throw new HttpError(400, "only .md and .txt files");
  mkdirSync(config.knowledgeDir, { recursive: true });
  const root = realpathSync(config.knowledgeDir);
  const abs = join(config.knowledgeDir, ...parts);
  let probe = abs; // deepest existing ancestor must really live inside knowledge/
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(root + sep)) throw new HttpError(400, "path outside knowledge/");
  return abs;
};

export const readKnowledge = (rel: string | null): KnowledgeDocument => {
  const abs = resolveSafe(rel);
  if (!existsSync(abs)) throw new HttpError(404, "no such file");
  return { path: rel!, content: readFileSync(abs, "utf8") };
};

export const writeKnowledge = (rel: string | null, content: string): void => {
  const abs = resolveSafe(rel);
  if (Buffer.byteLength(content) > MAX_BYTES) throw new HttpError(413, "file too large (max 1 MB)");
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, abs); // atomic: readers never see half a file
};
