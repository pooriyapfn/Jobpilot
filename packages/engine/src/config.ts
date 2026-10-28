import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../../../..");
const env = process.env;

export const config = {
  root,
  dbPath: env.APPLY_DB ?? resolve(root, "data/agent.db"),
  // Knowledge: markdown the agents read as intelligence
  knowledgeDir: resolve(root, "knowledge"),
  resumeDir: resolve(root, "knowledge/resume"), // main_resume.md, base_resume.md, rules.md
  // Tool data
  jobSearchDir: env.JOB_SEARCH_DIR ?? resolve(root, "data/job-search"),
  jobsFile: env.JOBS_FILE ?? resolve(root, "data/job-search/eligible-jobs.json"),
  tailorDir: resolve(root, "data/tailor"), // job_description.md for single runs
  tailorOutputDir: resolve(root, "data/tailor/output"), // archive of tailored resumes
  port: Number(env.APPLY_PORT ?? 4000),
  cdpUrl: env.CDP_URL ?? "http://localhost:9222",
  chromeProfile: env.CHROME_PROFILE ?? resolve(homedir(), ".chrome-jobs"), // separate profile: Chrome 136+ blocks CDP on the default one
  navTimeoutMs: 20_000,
  retryTimeoutMs: 45_000,
};
