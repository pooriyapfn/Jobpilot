// Answer agent: knowledge notes + learned memory + CVs + JD → an answer for every form field.
// Loop: answer all → check (option match, required blanks) → repair only the gaps.
import { z } from "zod";
import { agents } from "../../agents.config.ts";
import { callLLMJson } from "../tools/tailor/tailor.ts";
import type { Answers, FormField } from "../types.ts";
import { loadKnowledge, type Knowledge } from "./knowledge.ts";
import { formatMemory } from "./memory.ts";

export type JobContext = { title: string; company: string; jd: string; resume: string; sourceUrl: string };

const schema = z.object({
  answers: z.array(z.object({ id: z.string(), value: z.string(), confident: z.boolean() })),
});

const RULES = `
- Answer EVERY field. Sources, most trusted first: NOTES and LEARNED ANSWERS (the candidate's own words) → CVs → the job description.
- Reuse NOTES / LEARNED wording verbatim when a field asks the same thing in different words.
- Personal facts (contact, location, salary, visa, start date, relocation, demographics) come ONLY from NOTES / LEARNED / CV.
  Not there and the field is required → give the most reasonable answer consistent with NOTES (e.g. remote-only → pick the remote option) and set confident false.
  Not there and the field is optional → value "".
- Never invent experience, employers, numbers or dates. Free-text answers must be grounded in the CVs; follow the style notes.
- select/radio: value is exactly one of the options, copied character for character. checkbox: "yes" or "no".
- "How did you hear about us": use SOURCE as the notes describe.
- confident: true only when the answer is backed by NOTES / LEARNED / CV; false whenever you are guessing.
- File fields: value "".`;

const prompt = (fields: FormField[], job: JobContext, kb: Knowledge, extra = "") => `
You fill job application forms on behalf of the candidate.
${RULES}
${extra}

FIELDS:
${JSON.stringify(fields.map(({ id, label, type, required, options }) => ({ id, label, type, required, options })), null, 1)}

JOB: ${job.title} at ${job.company}
SOURCE: ${new URL(job.sourceUrl).hostname.replace(/^www\./, "")}

NOTES (written by the candidate):
${kb.notes || "(none)"}

LEARNED ANSWERS (the candidate's past answers):
${formatMemory()}

CV TAILORED FOR THIS JOB:
${job.resume || kb.mainCV}

EXPERIENCE BANK (full detail behind the CV):
${kb.experienceBank}

JOB DESCRIPTION:
${job.jd.slice(0, 12_000)}
`;

const ask = async (fields: FormField[], job: JobContext, kb: Knowledge, extra?: string): Promise<Answers> => {
  const { answers } = await callLLMJson(prompt(fields, job, kb, extra), schema, {
    name: "form_answers",
    model: agents.answer,
  });
  return Object.fromEntries(answers.map(({ id, value, confident }) => [id, { value, confident }]));
};

// Snap choice answers to a real option (case/spacing differences); unknown → blank so the check catches it.
const normalize = (fields: FormField[], answers: Answers): Answers => {
  for (const f of fields) {
    const a = answers[f.id];
    if (!a?.value || !f.options || f.type === "checkbox") continue;
    const want = a.value.trim().toLowerCase();
    const hit = f.options.find((o) => o.toLowerCase() === want) ?? f.options.find((o) => o.toLowerCase().includes(want) || want.includes(o.toLowerCase()));
    answers[f.id] = hit ? { ...a, value: hit } : { value: "", confident: false };
  }
  return answers;
};

const blankRequired = (fields: FormField[], answers: Answers) =>
  fields.filter((f) => f.required && f.type !== "file" && !answers[f.id]?.value);

export const answerFields = async (fields: FormField[], job: JobContext): Promise<Answers> => {
  const askable = fields.filter((f) => f.type !== "file");
  if (!askable.length) return {};
  const kb = await loadKnowledge();
  const answers = normalize(askable, await ask(askable, job, kb));

  const gaps = blankRequired(askable, answers);
  if (gaps.length) {
    const fix = await ask(gaps, job, kb, `
These REQUIRED fields came back empty. An empty required field blocks the whole application —
give the best reasonable answer for each (choice fields: pick the closest option) and set confident false.`);
    Object.assign(answers, normalize(gaps, fix));
  }
  return answers;
};

// Fields still blank (new since prepare, or skipped by an older run) — answered just before filling.
export const needsAnswer = (fields: FormField[], answers: Answers) =>
  fields.filter((f) => f.type !== "file" && !answers[f.id]?.value);
