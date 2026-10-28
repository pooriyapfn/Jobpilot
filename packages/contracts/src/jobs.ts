import { z } from "zod";
import { def } from "./registry.ts";

// Long-running pipeline steps. Each runs as a child process; its output streams as JobEvents.
export const JobTask = def(
  "JobTask",
  z.enum([
    "search", // Brave + job boards → jobs.json
    "verify", // fetch pages, freshness, location
    "enrich", // LLM eligibility → eligible-jobs.json
    "prepare", // tailor resume + answer forms (headless)
    "fill", // open prepared jobs as filled tabs in your Chrome
    "chrome", // start the job Chrome (remote debugging)
  ]),
);
export type JobTask = z.infer<typeof JobTask>;

export const JobStatus = def("JobStatus", z.enum(["running", "succeeded", "failed", "cancelled"]));
export type JobStatus = z.infer<typeof JobStatus>;

// POST /api/jobs — one running job per task; a second start gets 409.
export const StartJobRequest = def(
  "StartJobRequest",
  z.object({
    task: JobTask,
    limit: z.number().int().positive().optional(), // prepare / fill: how many jobs
  }),
);
export type StartJobRequest = z.infer<typeof StartJobRequest>;

// GET /api/jobs, GET /api/jobs/:id, POST /api/jobs/:id/cancel
export const JobInfo = def(
  "JobInfo",
  z.object({
    id: z.string(),
    task: JobTask,
    status: JobStatus,
    startedAt: z.string(), // ISO 8601
    endedAt: z.string().optional(),
    exitCode: z.number().int().optional(),
  }),
);
export type JobInfo = z.infer<typeof JobInfo>;

export const JobEventKind = def("JobEventKind", z.enum(["log", "status"]));
export type JobEventKind = z.infer<typeof JobEventKind>;

export const JobStream = def("JobStream", z.enum(["stdout", "stderr"]));
export type JobStream = z.infer<typeof JobStream>;

// GET /api/jobs/:id/events — Server-Sent Events (`id:` = seq, `event: job`, `data:` = JSON JobEvent).
// Replays the retained history, then follows live; the stream ends once the job finishes.
// Reconnect with the `Last-Event-ID` header to resume.
export const JobEvent = def(
  "JobEvent",
  z.object({
    seq: z.number().int(),
    ts: z.string(), // ISO 8601
    kind: JobEventKind,
    text: z.string(), // log line (kind "log"); empty for "status"
    stream: JobStream.optional(), // kind "log"
    status: JobStatus.optional(), // kind "status": the new status
  }),
);
export type JobEvent = z.infer<typeof JobEvent>;
