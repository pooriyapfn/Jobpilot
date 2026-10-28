// Tool: the resume-tailor workflow (this folder), used as a library by the apply agent.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config.ts";
import { runResumeTailor, SkipError } from "./runner.ts";
import { markdownToDocx, stripCodeFence } from "./docxExport.ts";

export { callLLMJson, MODELS } from "./LLM.ts";

export type Tailored =
  | { skip: true; reasons: string[] }
  | { skip: false; resume: string; docxPath: string; fit: string; atsScore: number };

const read = (name: string) => readFile(join(config.resumeDir, name), "utf8");

export const tailorResume = async (id: string, title: string, company: string, jd: string): Promise<Tailored> => {
  const [mainResume, baseResume, rules] = await Promise.all([
    read("main_resume.md"),
    read("base_resume.md"),
    read("rules.md"),
  ]);
  try {
    const r = await runResumeTailor({
      jobDescription: `# ${title} at ${company}\n\n${jd}`,
      baseResume: mainResume,
      rawExperiences: baseResume,
      rules,
    });
    const resume = stripCodeFence(r.resume);
    const dir = config.resumesDir;
    await mkdir(dir, { recursive: true });
    const docxPath = join(dir, `${id}.docx`);
    await writeFile(join(dir, `${id}.md`), resume);
    await writeFile(docxPath, await markdownToDocx(resume));
    return { skip: false, resume, docxPath, fit: r.fit.classification, atsScore: r.ats.score };
  } catch (e) {
    if (e instanceof SkipError) return { skip: true, reasons: [...e.fit.gaps, ...e.fit.reasons] };
    throw e;
  }
};
