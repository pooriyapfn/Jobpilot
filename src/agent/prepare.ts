// Batch: for every ready job → find form → tailor resume → answer fields → save for review.
// Usage: npm run prepare-jobs [-- --limit 10]
import type { Browser } from "playwright";
import { hasApp, saveApp } from "../db.ts";
import { hasForm, openApplyPage } from "../browser/apply-page.ts";
import { launchHeadless } from "../browser/session.ts";
import { loadReadyJobs, type ReadyJob } from "../tools/job-search/jobs.ts";
import { tailorResume } from "../tools/tailor/tailor.ts";
import type { Application } from "../types.ts";
import { answerFields } from "./answer.ts";

const emptyApp = (job: ReadyJob, jd = job.description) => ({
  id: job.id, url: job.url, applyUrl: job.url, title: job.title, company: job.company, jd,
  fields: [], answers: {}, updatedAt: "",
});

const scanPage = async (browser: Browser, url: string) => {
  const page = await browser.newPage();
  try {
    const form = await openApplyPage(page, url);
    return { ...form, text: await page.locator("body").innerText().catch(() => ""), error: "" };
  } catch (e) {
    // Blocked/slow page: still tailor the resume from job-searcher's JD; you apply by hand.
    return { applyUrl: url, fields: [], text: "", access: "blocked" as const, error: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
  } finally {
    await page.close();
  }
};

const BLOCKED_NOTE = {
  blocked: "Site blocks the background browser — Apply opens it in your Chrome",
  login: "Needs login — Apply opens it in your Chrome",
};

const prepareJob = async (browser: Browser, job: ReadyJob): Promise<Application> => {
  const form = await scanPage(browser, job.url);
  const jd = job.description.length > 500 ? job.description : form.text;
  const base = emptyApp(job, jd);
  if (form.access === "closed") return { ...base, status: "closed", note: form.applyUrl };

  const tailored = await tailorResume(job.id, job.title, job.company, jd);
  if (tailored.skip) return { ...base, status: "skip-fit", note: tailored.reasons.join("; ") };

  const common = { ...base, applyUrl: form.applyUrl, fit: tailored.fit, atsScore: tailored.atsScore, resumePath: tailored.docxPath };
  if (form.access === "blocked" || form.access === "login") {
    return { ...common, status: "blocked", note: form.error || BLOCKED_NOTE[form.access] };
  }
  if (!hasForm(form.fields.length)) return { ...common, status: "manual", note: "No form found — apply by hand" };

  const answers = await answerFields(form.fields, { title: job.title, company: job.company, jd, resume: tailored.resume, sourceUrl: job.url });
  return { ...common, status: "prepared", fields: form.fields, answers };
};

const main = async () => {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;

  const jobs = loadReadyJobs().filter((j) => !hasApp(j.id)).slice(0, limit);
  console.log(`Preparing ${jobs.length} new job(s)…`);

  const browser = await launchHeadless();
  try {
    for (const [i, job] of jobs.entries()) {
      const label = `[${i + 1}/${jobs.length}] ${job.title} @ ${job.company}`;
      try {
        const app = await prepareJob(browser, job);
        saveApp(app);
        console.log(`${label} → ${app.status}${app.fields.length ? ` (${app.fields.length} fields)` : ""}`);
      } catch (e) {
        const note = e instanceof Error ? e.message : String(e);
        saveApp({ ...emptyApp(job), status: "error", note });
        console.log(`${label} → error: ${note}`);
      }
    }
  } finally {
    await browser.close();
  }
};

main();
