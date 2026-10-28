// Tool: ready jobs from the job-search tool's latest run.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "../../config.ts";

export type ReadyJob = {
  id: string;
  url: string;
  title: string;
  company: string;
  description: string;
};

type SearcherJob = {
  url: string;
  title: string;
  company?: string;
  description?: string;
  visibleText?: string;
  extraSnippets?: string[];
};

export const jobId = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 16);

export const loadReadyJobs = (): ReadyJob[] => {
  const jobs = JSON.parse(readFileSync(config.jobsFile, "utf8")) as SearcherJob[];
  return jobs.map((j) => ({
    id: jobId(j.url),
    url: j.url,
    title: j.title,
    company: j.company ?? "unknown",
    description: [j.visibleText || j.description || "", ...(j.extraSnippets ?? [])].join("\n"),
  }));
};
