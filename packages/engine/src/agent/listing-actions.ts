// What the app's buttons do to one job: prepare an application for it, or redo its tailored resume.
import { getApp, saveApp } from "../db.ts";
import { launchHeadless } from "../browser/session.ts";
import { getListing, type Step } from "../listings.ts";
import { tailorResume } from "../tools/tailor/tailor.ts";
import { prepareJob } from "./prepare.ts";

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
