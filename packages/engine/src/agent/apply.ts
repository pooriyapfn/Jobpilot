// On click: open the job in your Chrome, fill it, wait for YOU to submit, then learn from what you sent.
import { readFile } from "node:fs/promises";
import { getApp, saveApp, setStatus } from "../db.ts";
import { openApplyPage } from "../browser/apply-page.ts";
import { fillForm, readValues } from "../browser/form.ts";
import { userChrome } from "../browser/session.ts";
import { waitForSubmit } from "../browser/submit.ts";
import type { Answers, Application, FormField } from "../types.ts";
import { answerFields, needsAnswer } from "./answer.ts";
import { remember } from "./memory.ts";

// New fields (form changed / logged-in view / blocked at prepare) and required blanks get answered now.
const completeAnswers = async (app: Application, fields: FormField[]): Promise<Answers> => {
  const todo = needsAnswer(fields, app.answers);
  if (!todo.length) return app.answers;
  const resume = app.resumePath ? await readFile(app.resumePath.replace(/\.docx$/, ".md"), "utf8").catch(() => "") : "";
  const fresh = await answerFields(todo, { title: app.title, company: app.company, jd: app.jd, resume, sourceUrl: app.url });
  return { ...app.answers, ...fresh };
};

// Anything you typed or changed in the browser becomes memory for next time.
const learn = (fields: FormField[], answers: Answers, sent: Record<string, string>) => {
  for (const f of fields) {
    const value = sent[f.id]?.trim();
    if (f.type !== "file" && value && value !== answers[f.id]?.value) remember(f.label, value);
  }
};

export const applyJob = async (id: string): Promise<void> => {
  const app = getApp(id);
  if (!app) throw new Error(`Unknown job ${id}`);
  setStatus(id, "filling");

  const page = await (await userChrome()).newPage();
  await page.bringToFront();
  const { frame, fields, access } = await openApplyPage(page, app.applyUrl);
  if (access === "closed") return setStatus(id, "closed", "Posting is gone");
  const answers = await completeAnswers(app, fields);
  const pending = await fillForm(frame, fields, answers, app.resumePath).catch(() => fields.map((f) => f.id));
  saveApp({ ...app, fields, answers, status: "filling", note: pending.length ? `${pending.length} field(s) need you` : undefined });

  const { submitted, sent } = await waitForSubmit(page, frame, () => readValues(frame, fields));
  if (submitted && sent) learn(fields, answers, sent);
  setStatus(id, submitted ? "submitted" : "skipped", "");
};
