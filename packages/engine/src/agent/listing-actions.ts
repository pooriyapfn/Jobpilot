// What the app's buttons do to one job: prepare an application for it, or redo its tailored resume.
import { readFile } from "node:fs/promises";
import { getApp, saveApp } from "../db.ts";
import { launchHeadless } from "../browser/session.ts";
import { getListing, type Step } from "../listings.ts";
import { tailorResume } from "../tools/tailor/tailor.ts";
import { answerFields } from "./answer.ts";
import { prepareJob, scanPage } from "./prepare.ts";

/** Tailor a resume and draft answers for one listing, in the background browser. Throws if it can't (nothing is saved then). */
export const prepareListing = async (id: string, step: Step): Promise<void> => {
  const listing = getListing(id);
  if (!listing) throw new Error("no such job");
  if (getApp(id)) throw new Error("This job already has an application. Generate its resume instead.");
  step("Starting the background browser");
  const browser = await launchHeadless();
  try {
    const app = await prepareJob(browser, { id, url: listing.url, title: listing.title, company: listing.company, description: listing.description }, step);
    step("Saving");
    saveApp(app);
  } finally {
    await browser.close();
  }
};

/**
 * A fresh tailored resume for an existing application (or its first one, if it never got a resume).
 * The current resume file stays untouched until the new one is complete; if anything fails, you keep the old one.
 */
export const regenerateResume = async (id: string, step: Step, force = false): Promise<void> => {
  const app = getApp(id);
  if (!app) throw new Error("This job has no application yet. Prepare it first.");
  const jd = app.jd || getListing(id)?.description || "";
  step("Writing the tailored resume");
  const tailored = await tailorResume(id, app.title, app.company, jd, force);
  if (tailored.skip) throw new Error(`The fit check says this job isn't a match: ${tailored.reasons.filter((r) => r.startsWith("✗")).join("; ") || "no reason given"}. Use Generate anyway to write one regardless.`);
  step("Saving");
  // A job once judged "not a fit" that now passes can be applied to by hand.
  const revived = app.status === "skip-fit";
  saveApp({
    ...app,
    jd,
    fit: tailored.fit,
    atsScore: tailored.atsScore,
    resumePath: tailored.docxPath,
    ...(revived ? { status: "manual" as const, note: "Resume generated. No form was scanned, so apply from the posting." } : {}),
  });
};

/**
 * Reads the application form at the listing's saved application link and drafts answers for it.
 * No application yet: same as Prepare, but the form is scanned at that link (the posting's own link is kept as `url`).
 * An application exists: its form, answers and apply link are replaced; answers you already wrote for fields that
 * are still on the form stay. Nothing changes if the page can't be read.
 */
export const scanApplyLink = async (id: string, step: Step): Promise<void> => {
  const listing = getListing(id);
  if (!listing) throw new Error("no such job");
  const link = listing.applyUrl;
  if (!link) throw new Error("Save the application link first.");
  const app = getApp(id);
  if (app?.status === "filling" || app?.status === "submitted") throw new Error("This application is already in progress or submitted.");

  step("Starting the background browser");
  const browser = await launchHeadless();
  try {
    if (!app) {
      const fresh = await prepareJob(browser, { id, url: listing.url, title: listing.title, company: listing.company, description: listing.description }, step, link);
      if (fresh.status === "closed") throw new Error("That page says the posting is closed.");
      step("Saving");
      return saveApp(fresh);
    }

    step("Opening the application page");
    const form = await scanPage(browser, link);
    if (form.access === "closed") throw new Error("That page says the posting is closed.");
    const base = { ...app, applyUrl: form.applyUrl };
    if (form.access === "blocked" || form.access === "login") {
      return saveApp({ ...base, status: "blocked", note: form.error || "Site blocks the background browser — Apply opens it in your Chrome" });
    }
    if (form.fields.length < 3) return saveApp({ ...base, status: "manual", note: "No form found on that page — apply by hand" });

    step("Drafting answers");
    const resume = app.resumePath ? await readFile(app.resumePath.replace(/\.docx$/, ".md"), "utf8").catch(() => "") : "";
    const drafted = await answerFields(form.fields, { title: app.title, company: app.company, jd: app.jd, resume, sourceUrl: app.url });
    const kept = Object.fromEntries(form.fields.filter((f) => app.answers[f.id]).map((f) => [f.id, app.answers[f.id]!]));
    step("Saving");
    saveApp({ ...base, status: "prepared", note: undefined, fields: form.fields, answers: { ...drafted, ...kept } });
  } finally {
    await browser.close();
  }
};
