import { z } from "zod";
import { Status } from "./application.ts";
import { def } from "./registry.ts";

// The jobs repository: every job JobPilot knows about, with or without an application.
// A listing and its Application share an id (sha256 of the posting URL).
//
// Four independent facts, never merged into one status:
//   eligibility  — hard requirements (remote, your country). Set by checks or by you.
//   match        — how well your profile fits (the tailor's fit gate). Not eligibility.
//   preparation  — resume / answers, read from the application.
//   application  — applied or not, read from `appliedAt` and the application status.

export const Eligibility = def(
  "Eligibility",
  z.enum([
    "not-evaluated", // nobody has checked yet (e.g. a link whose page couldn't be read)
    "eligible",
    "not-eligible",
    "review", // evidence is mixed: look before you prepare
  ]),
);
export type Eligibility = z.infer<typeof Eligibility>;

// Where the eligibility value came from.
export const EligibilitySource = def("EligibilitySource", z.enum(["search", "check", "you"]));
export type EligibilitySource = z.infer<typeof EligibilitySource>;

// Work the engine is doing on a listing right now (in memory; gone after a restart).
export const JobActivity = def("JobActivity", z.enum(["assessing", "preparing", "regenerating", "filling"]));
export type JobActivity = z.infer<typeof JobActivity>;

// GET /api/listings — newest added first. The full description is left out (see JobListingDetail).
export const JobListing = def(
  "JobListing",
  z.object({
    id: z.string(),
    url: z.string(),
    title: z.string(),
    company: z.string(),

    eligibility: Eligibility,
    eligibilityReason: z.string().optional(), // evidence behind the value, in a sentence
    eligibilitySource: EligibilitySource.optional(),
    evaluatedAt: z.string().optional(), // ISO 8601

    datePosted: z.string().optional(), // ISO 8601; only when the posting says so, never guessed
    addedAt: z.string(), // ISO 8601, when it entered the repository
    updatedAt: z.string(), // ISO 8601, last change to the job or its application
    snippet: z.string(), // plain-text preview of the description
    location: z.string().optional(),
    userNote: z.string().optional(), // your own notes; searches and checks never touch them

    appliedAt: z.string().optional(), // you applied (marked by you, or a confirmed submission)
    applicationStatus: Status.optional(), // set once an application exists
    resumeReady: z.boolean(), // a tailored resume file exists on disk
    matchFit: z.string().optional(), // STRONG_FIT | POSSIBLE_FIT | SKIP, from the tailor's fit gate

    activity: JobActivity.optional(),
    activityStep: z.string().optional(), // what the engine is doing, as it reports it
    activityError: z.string().optional(), // the last background action failed with this
  }),
);
export type JobListing = z.infer<typeof JobListing>;

// GET /api/listings/:id — description is cleaned plain text: "## heading", "- bullet", blank line between paragraphs.
export const JobListingDetail = def(
  "JobListingDetail",
  JobListing.extend({
    description: z.string(),
    matchNotes: z.string().optional(), // why the fit gate said skip
  }),
);
export type JobListingDetail = z.infer<typeof JobListingDetail>;

// POST /api/listings — fetches the page, reads title/company/date, checks eligibility. Returns the JobListing.
export const AddListingRequest = def("AddListingRequest", z.object({ url: z.string() }));
export type AddListingRequest = z.infer<typeof AddListingRequest>;

// POST /api/listings/:id/eligibility — you decide; the application, if any, follows.
export const SetEligibilityRequest = def("SetEligibilityRequest", z.object({ eligibility: Eligibility }));
export type SetEligibilityRequest = z.infer<typeof SetEligibilityRequest>;

// POST /api/listings/:id/regenerate-resume[?force=1] — force writes the resume even if the fit check says skip.

// POST /api/listings/:id/note — replaces your note (max 10 000 characters); empty clears it.
export const SetNoteRequest = def("SetNoteRequest", z.object({ note: z.string() }));
export type SetNoteRequest = z.infer<typeof SetNoteRequest>;

// DELETE /api/listings/:id?scope=…
//   listing    — remove from the jobs list; keeps the application, its history and files (default)
//   everything — also delete the application and its resume files
export const RemoveScope = def("RemoveScope", z.enum(["listing", "everything"]));
export type RemoveScope = z.infer<typeof RemoveScope>;
