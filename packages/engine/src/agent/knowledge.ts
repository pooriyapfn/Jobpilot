// What the answer agent knows about you: knowledge/*.md (your words) + your CVs in knowledge/resume/.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";

const readOr = (path: string) => readFile(path, "utf8").catch(() => "");

export type Knowledge = { notes: string; mainCV: string; experienceBank: string };

export const loadKnowledge = async (): Promise<Knowledge> => {
  const dir = config.knowledgeDir;
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md") && !f.endsWith(".example.md")).sort();
  const notes = await Promise.all(files.map(async (f) => `<!-- ${f} -->\n${await readOr(join(dir, f))}`));
  const [mainCV, experienceBank] = await Promise.all([
    readOr(join(config.resumeDir, "main_resume.md")),
    readOr(join(config.resumeDir, "base_resume.md")),
  ]);
  return { notes: notes.join("\n\n"), mainCV, experienceBank };
};
