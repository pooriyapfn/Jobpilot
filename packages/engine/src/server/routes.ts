import { createReadStream } from "node:fs";
import {
  API_VERSION,
  SaveAnswersRequest,
  SaveKnowledgeRequest,
  SetStatusRequest,
  StartJobRequest,
  type ApplicationSummary,
  type EligibleJob,
  type EngineInfo,
  type OkResponse,
} from "@jobpilot/contracts";
import { applyJob } from "../agent/apply.ts";
import { remember } from "../agent/memory.ts";
import { config } from "../config.ts";
import { getApp, listApps, saveApp, setStatus } from "../db.ts";
import { loadReadyJobs } from "../tools/job-search/jobs.ts";
import { HttpError, type Route } from "./http.ts";
import type { JobRunner } from "./jobs.ts";
import { listKnowledge, readKnowledge, writeKnowledge } from "./knowledge.ts";
import { page } from "./page.ts";

const ok = (ok = true): OkResponse => ({ ok });

// You edited answers in the app: save them and remember them.
const saveAnswers = (id: string, edits: Record<string, string>) => {
  const app = getApp(id);
  if (!app) return false;
  for (const f of app.fields) {
    const value = edits[f.id];
    if (value === undefined || value === app.answers[f.id]?.value) continue;
    app.answers[f.id] = { value, confident: true };
    remember(f.label, value);
  }
  saveApp(app);
  return true;
};

const chromeReachable = () =>
  fetch(`${config.cdpUrl}/json/version`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false);

const eligibleJobs = (): EligibleJob[] => {
  let ready: ReturnType<typeof loadReadyJobs>;
  try {
    ready = loadReadyJobs();
  } catch {
    return []; // no search run yet
  }
  const status = new Map(listApps().map((a) => [a.id, a.status]));
  return ready.map(({ id, url, title, company }) => ({ id, url, title, company, applicationStatus: status.get(id) }));
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
    method: "POST",
    pattern: "/api/apply/:id",
    handler: ({ params }) => {
      if (!getApp(params.id!)) throw new HttpError(404, "no such application");
      applyJob(params.id!).catch((e) => setStatus(params.id!, "error", String(e.message ?? e)));
      return ok();
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
