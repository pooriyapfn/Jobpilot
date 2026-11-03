// Tool: the resume-tailor workflow (this folder), used as a library by the apply agent.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config.ts";
import { fitLines } from "./fitAssessment.ts";
import { runResumeTailor, SkipError } from "./runner.ts";
import { markdownToDocx, stripCodeFence } from "./docxExport.ts";

export { callLLMJson, MODELS } from "./LLM.ts";

export type Tailored =
  | { skip: true; reasons: string[] }
  | { skip: false; resume: string; docxPath: string; fit: string; atsScore: number };

const read = (name: string) => readFile(join(config.resumeDir, name), "utf8");

// `force`: write the resume even when the fit gate says SKIP (you chose to apply anyway).
export const tailorResume = async (id: string, title: string, company: string, jd: string, force = false): Promise<Tailored> => {
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
      force,
    });
    const resume = stripCodeFence(r.resume);
    const dir = config.resumesDir;
    await mkdir(dir, { recursive: true });
    const docxPath = join(dir, `${id}.docx`);
    // Build the document first: if that fails, the previous resume files are still intact.
    const docx = await markdownToDocx(resume);
    await writeFile(join(dir, `${id}.md`), resume);
    await writeFile(docxPath, docx);
    return { skip: false, resume, docxPath, fit: r.fit.classification, atsScore: r.ats.score };
  } catch (e) {
    if (e instanceof SkipError) return { skip: true, reasons: fitLines(e.fit) };
    throw e;
  }
};
