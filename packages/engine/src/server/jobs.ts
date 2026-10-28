import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { JobEvent, JobInfo, JobStatus, JobStream, JobTask, StartJobRequest } from "@jobpilot/contracts";
import { config } from "../config.ts";
import { HttpError } from "./http.ts";

export type TaskSpec = { command: string; args: string[]; cwd?: string };
export type TaskTable = Record<JobTask, (opts: { limit?: number }) => TaskSpec>;

// Each task is one of the existing scripts, run in its own process with the engine's node flags and env.
const script = (rel: string, ...args: string[]): TaskSpec => ({
  command: process.execPath,
  args: [...process.execArgv, fileURLToPath(new URL(`../${rel}`, import.meta.url)), ...args],
  cwd: config.root,
});
const withLimit = (limit?: number) => (limit ? ["--limit", String(limit)] : []);

export const defaultTasks = (): TaskTable => ({
  search: () => script("tools/job-search/index.ts"),
  verify: () => script("tools/job-search/verify.ts"),
  enrich: () => script("tools/job-search/enrich.ts"),
  prepare: ({ limit }) => script("agent/prepare.ts", ...withLimit(limit)),
  fill: ({ limit }) => script("agent/fill.ts", ...withLimit(limit)),
  chrome: () => script("browser/session.ts"),
});

type Job = {
  info: JobInfo;
  events: JobEvent[];
  listeners: Set<(e: JobEvent) => void>;
  child?: ChildProcess;
  seq: number;
  cancelled: boolean;
};

const MAX_EVENTS = 5000; // per job; older lines are dropped
const MAX_JOBS = 50;

export class JobRunner {
  private jobs = new Map<string, Job>();

  private tasks: TaskTable;

  constructor(tasks: TaskTable) {
    this.tasks = tasks;
  }

  list = (): JobInfo[] => [...this.jobs.values()].map((j) => j.info).reverse();

  get = (id: string): Job => {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, `no job ${id}`);
    return job;
  };

  start({ task, limit }: StartJobRequest): JobInfo {
    const running = [...this.jobs.values()].find((j) => j.info.task === task && j.info.status === "running");
    if (running) throw new HttpError(409, `${task} is already running (job ${running.info.id})`);

    const job: Job = {
      info: { id: randomUUID(), task, status: "running", startedAt: new Date().toISOString() },
      events: [],
      listeners: new Set(),
      seq: 0,
      cancelled: false,
    };
    this.jobs.set(job.info.id, job);
    this.trim();
    this.emit(job, { kind: "status", text: "", status: "running" });

    const spec = this.tasks[task]({ limit });
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    job.child = child;
    this.pipeLines(job, child, "stdout");
    this.pipeLines(job, child, "stderr");
    child.on("error", (e) => {
      this.emit(job, { kind: "log", stream: "stderr", text: `failed to start: ${e.message}` });
      this.finish(job, "failed", undefined);
    });
    child.on("close", (code) => this.finish(job, job.cancelled ? "cancelled" : code === 0 ? "succeeded" : "failed", code ?? undefined));
    return job.info;
  }

  cancel(id: string): JobInfo {
    const job = this.get(id);
    if (job.info.status === "running" && job.child) {
      job.cancelled = true;
      job.child.kill("SIGINT"); // scripts (fill) clean up on SIGINT
      setTimeout(() => job.info.status === "running" && job.child?.kill("SIGKILL"), 5_000).unref();
    }
    return job.info;
  }

  // Replays events after `afterSeq`, then follows live until the job ends. Returns an unsubscribe fn.
  subscribe(id: string, afterSeq: number, onEvent: (e: JobEvent) => void, onEnd: () => void): () => void {
    const job = this.get(id);
    for (const e of job.events) if (e.seq > afterSeq) onEvent(e);
    if (job.info.status !== "running") {
      onEnd();
      return () => {};
    }
    const listener = (e: JobEvent) => {
      onEvent(e);
      if (e.kind === "status" && e.status !== "running") onEnd();
    };
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  shutdown() {
    for (const j of this.jobs.values()) if (j.info.status === "running") j.child?.kill("SIGINT");
  }

  private emit(job: Job, e: Omit<JobEvent, "seq" | "ts">) {
    const event: JobEvent = { seq: ++job.seq, ts: new Date().toISOString(), ...e };
    job.events.push(event);
    if (job.events.length > MAX_EVENTS) job.events.shift();
    for (const l of job.listeners) l(event);
  }

  private pipeLines(job: Job, child: ChildProcess, stream: JobStream) {
    let rest = "";
    const src = stream === "stdout" ? child.stdout : child.stderr;
    src?.setEncoding("utf8");
    src?.on("data", (chunk: string) => {
      const parts = (rest + chunk).split(/\r\n|\n|\r/);
      rest = parts.pop() ?? "";
      for (const text of parts) this.emit(job, { kind: "log", stream, text });
    });
    src?.on("end", () => rest && this.emit(job, { kind: "log", stream, text: rest }));
  }

  private finish(job: Job, status: JobStatus, exitCode: number | undefined) {
    if (job.info.status !== "running") return;
    job.info = { ...job.info, status, exitCode, endedAt: new Date().toISOString() };
    this.emit(job, { kind: "status", text: "", status });
  }

  private trim() {
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break;
      if (j.info.status !== "running") this.jobs.delete(id);
    }
  }
}
