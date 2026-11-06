import { createReadStream } from "node:fs";
import {
  AddListingRequest,
  API_VERSION,
  SaveAnswersRequest,
  SaveKnowledgeRequest,
  RemoveScope,
  SetApplyLinkRequest,
  SetEligibilityRequest,
  SetNoteRequest,
  SetStatusRequest,
  StartJobRequest,
  type Application,
  type ApplicationSummary,
  type EligibleJob,
  type EngineInfo,
  type JobActivity,
  type JobListing,
  type JobListingDetail,
  type OkResponse,
} from "@jobpilot/contracts";
import { applyJob } from "../agent/apply.ts";
import { prepareListing, regenerateResume, scanApplyLink } from "../agent/listing-actions.ts";
import { remember } from "../agent/memory.ts";
import { config } from "../config.ts";
import { getApp, listApps, saveApp, setStatus } from "../db.ts";
import {
  addListing, assessListing, Busy, Conflict, eligibleListings, getListing, isBusy, listListings, markApplied, removeListing, runActivity,
  setApplyLink, setEligibility, setNote, type Step,
} from "../listings.ts";
import { HttpError, type Route } from "./http.ts";
import type { JobRunner } from "./jobs.ts";
import { listKnowledge, readKnowledge, writeKnowledge } from "./knowledge.ts";
import { page } from "./page.ts";
import { cleanText } from "../text.ts";

const ok = (ok = true): OkResponse => ({ ok });

// You edited answers in the app: save them and remember them.
// Sending a value the agent wasn't sure about, unchanged, confirms it ("yes, that's right").
const saveAnswers = (id: string, edits: Record<string, string>) => {
  const app = getApp(id);
  if (!app) return false;
  for (const f of app.fields) {
    const value = edits[f.id];
    const current = app.answers[f.id];
    if (value === undefined) continue;
    if (value === current?.value && (current.confident || !value)) continue;
    app.answers[f.id] = { value, confident: true };
    remember(f.label, value);
  }
  saveApp(app);
  return true;
};

const chromeReachable = () =>
  fetch(`${config.cdpUrl}/json/version`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false);

const eligibleJobs = (): EligibleJob[] =>
  eligibleListings().map(({ id, url, title, company, applicationStatus }) => ({ id, url, title, company, applicationStatus }));

const listing = (id: string): JobListingDetail => getListing(id) ?? (() => { throw new HttpError(404, "no such job"); })();

// Kick off background work on a listing; a second request while it runs gets 409.
const MAX_NOTE = 10_000;

const startActivity = (id: string, kind: JobActivity, work: (step: Step) => Promise<void>): OkResponse => {
  listing(id);
  try {
    runActivity(id, kind, work);
  } catch (e) {
    if (e instanceof Busy) throw new HttpError(409, e.message);
    throw e;
  }
  return ok();
};

export const buildRoutes = (runner: JobRunner, opts: { devPage: boolean }): Route[] => [
  // dev dashboard (only when the server has no token)
  ...(opts.devPage
    ? [{ method: "GET", pattern: "/", auth: false as const, handler: ({ res }) => void res.writeHead(200, { "content-type": "text/html" }).end(page) } satisfies Route]
    : []),

  {
    method: "GET",
    pattern: "/api/info",
    handler: async (): Promise<EngineInfo> => ({
      apiVersion: API_VERSION,
      version: process.env.JOBPILOT_VERSION ?? "dev",
      home: config.home,
      hasOpenrouterKey: !!process.env.OPENROUTER_API_KEY,
      hasBraveKey: !!process.env.BRAVE_API_KEY,
      candidateCountry: process.env.CANDIDATE_COUNTRY || undefined,
      chromeReachable: await chromeReachable(),
    }),
  },

  // applications
  { method: "GET", pattern: "/api/apps", handler: (): ApplicationSummary[] => listApps().map(({ jd: _jd, ...app }) => app) },
  { method: "GET", pattern: "/api/eligible-jobs", handler: eligibleJobs },
  {
    method: "GET",
    pattern: "/api/apps/:id",
    handler: ({ params }): Application => {
      const app = getApp(params.id!);
      if (!app) throw new HttpError(404, "no such application");
      return { ...app, jd: cleanText(app.jd) }; // saved descriptions may still be raw HTML
    },
  },
  {
    method: "POST",
    pattern: "/api/apply/:id",
    handler: ({ params }) => {
      if (!getApp(params.id!)) throw new HttpError(404, "no such application");
      return startActivity(params.id!, "filling", (step) =>
        applyJob(params.id!, step).catch((e) => {
          setStatus(params.id!, "error", String(e.message ?? e));
          throw e;
        }),
      );
    },
  },
  {
    method: "POST",
    pattern: "/api/answers/:id",
    handler: async ({ params, body }) => ok(saveAnswers(params.id!, SaveAnswersRequest.parse(await body()).answers)),
  },
  {
    method: "POST",
    pattern: "/api/status/:id",
    handler: async ({ params, body }) => {
      setStatus(params.id!, SetStatusRequest.parse(await body()).status);
      return ok();
    },
  },
  {
    method: "GET",
    pattern: "/resume/:id",
    handler: ({ params, res }) => {
      const path = getApp(params.id!)?.resumePath;
      if (!path) throw new HttpError(404, "no resume");
      res.writeHead(200, { "content-disposition": `attachment; filename="resume-${params.id}.docx"` });
      createReadStream(path).pipe(res);
    },
  },

  // jobs repository
  { method: "GET", pattern: "/api/listings", handler: (): JobListing[] => listListings() },
  {
    method: "POST",
    pattern: "/api/listings",
    handler: async ({ body }): Promise<JobListing> => {
      try {
        return (await addListing(AddListingRequest.parse(await body()).url)).listing;
      } catch (e) {
        if (e instanceof TypeError) throw new HttpError(400, e.message);
        throw e;
      }
    },
  },
  { method: "GET", pattern: "/api/listings/:id", handler: ({ params }) => listing(params.id!) },
  {
    method: "POST",
    pattern: "/api/listings/:id/eligibility",
    handler: async ({ params, body }) => {
      const { eligibility } = SetEligibilityRequest.parse(await body());
      if (isBusy(params.id!)) throw new HttpError(409, "Wait for the running action to finish first");
      if (!setEligibility(params.id!, eligibility)) throw new HttpError(404, "no such job");
      return ok();
    },
  },
  {
    method: "POST",
    pattern: "/api/listings/:id/applied",
    handler: ({ params }) => {
      if (isBusy(params.id!)) throw new HttpError(409, "Wait for the running action to finish first");
      if (!markApplied(params.id!)) throw new HttpError(404, "no such job");
      return ok();
    },
  },
  {
    method: "POST",
    pattern: "/api/listings/:id/note",
    handler: async ({ params, body }) => {
      const { note } = SetNoteRequest.parse(await body());
      if (note.length > MAX_NOTE) throw new HttpError(413, `Notes are limited to ${MAX_NOTE} characters`);
      if (!setNote(params.id!, note)) throw new HttpError(404, "no such job");
      return ok();
    },
  },
  {
    method: "DELETE",
    pattern: "/api/listings/:id",
    handler: ({ params, url }) => {
      const scope = RemoveScope.parse(url.searchParams.get("scope") ?? "listing");
      if (isBusy(params.id!)) throw new HttpError(409, "Wait for the running action to finish first");
      if (!removeListing(params.id!, scope)) throw new HttpError(404, "no such job");
      return ok();
    },
  },
  {
    method: "POST",
    pattern: "/api/listings/:id/assess",
    handler: ({ params }) => startActivity(params.id!, "assessing", (step) => assessListing(params.id!, step)),
  },
  {
    method: "POST",
    pattern: "/api/listings/:id/prepare",
    handler: ({ params }) => startActivity(params.id!, "preparing", (step) => prepareListing(params.id!, step)),
  },
  {
    method: "POST",
    pattern: "/api/listings/:id/apply-link",
    handler: async ({ params, body }) => {
      const { url } = SetApplyLinkRequest.parse(await body());
      if (isBusy(params.id!)) throw new HttpError(409, "Wait for the running action to finish first");
      let saved: string | null | undefined;
      try {
        saved = setApplyLink(params.id!, url);
      } catch (e) {
        if (e instanceof TypeError) throw new HttpError(400, e.message);
        if (e instanceof Conflict) throw new HttpError(409, e.message);
        throw e;
      }
      if (saved === undefined) throw new HttpError(404, "no such job");
      if (saved === null) return ok(); // cleared
      return startActivity(params.id!, "scanning", (step) => scanApplyLink(params.id!, step));
    },
  },
  {
    method: "POST",
    pattern: "/api/listings/:id/regenerate-resume",
    handler: ({ params, url }) => {
      if (!getApp(params.id!)) throw new HttpError(409, "This job has no application yet. Prepare it first.");
      const force = url.searchParams.get("force") === "1"; // write it even if the fit check says skip
      return startActivity(params.id!, "regenerating", (step) => regenerateResume(params.id!, step, force));
    },
  },

  // pipeline jobs
  { method: "GET", pattern: "/api/jobs", handler: () => runner.list() },
  { method: "POST", pattern: "/api/jobs", handler: async ({ body }) => runner.start(StartJobRequest.parse(await body())) },
  { method: "GET", pattern: "/api/jobs/:id", handler: ({ params }) => runner.get(params.id!).info },
  { method: "POST", pattern: "/api/jobs/:id/cancel", handler: ({ params }) => runner.cancel(params.id!) },
  {
    method: "GET",
    pattern: "/api/jobs/:id/events",
    handler: ({ params, req, res }) => {
      runner.get(params.id!); // 404 before headers go out
      const after = Number(req.headers["last-event-id"]) || 0;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
      const stop = runner.subscribe(
        params.id!,
        after,
        (e) => res.write(`id: ${e.seq}\nevent: job\ndata: ${JSON.stringify(e)}\n\n`),
        () => res.end(),
      );
      res.on("close", () => (clearInterval(beat), stop()));
    },
  },

  // knowledge
  { method: "GET", pattern: "/api/knowledge", handler: listKnowledge },
  { method: "GET", pattern: "/api/knowledge/file", handler: ({ url }) => readKnowledge(url.searchParams.get("path")) },
  {
    method: "PUT",
    pattern: "/api/knowledge/file",
    handler: async ({ url, body }) => {
      writeKnowledge(url.searchParams.get("path"), SaveKnowledgeRequest.parse(await body()).content);
      return ok();
    },
  },
];
