import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../../../..");
const env = process.env;
// Where your personal data lives: knowledge/, data/, .env.local. Dev default is the repo root;
// the Mac app sets JOBPILOT_HOME to ~/Library/Application Support/JobPilot.
const home = env.JOBPILOT_HOME ? resolve(env.JOBPILOT_HOME) : root;

export const config = {
  root, // code checkout (where npm scripts run)
  home, // personal data
  dbPath: env.APPLY_DB ?? resolve(home, "data/agent.db"),
  // Knowledge: markdown the agents read as intelligence
  knowledgeDir: resolve(home, "knowledge"),
  resumeDir: resolve(home, "knowledge/resume"), // main_resume.md, base_resume.md, rules.md
  // Tool data
  jobSearchDir: env.JOB_SEARCH_DIR ?? resolve(home, "data/job-search"),
  jobsFile: env.JOBS_FILE ?? resolve(home, "data/job-search/eligible-jobs.json"),
  resumesDir: resolve(home, "data/resumes"), // resumes tailored by prepare-jobs (<id>.{md,docx})
  tailorDir: resolve(home, "data/tailor"), // job_description.md for single runs
  tailorOutputDir: resolve(home, "data/tailor/output"), // archive of tailored resumes
  port: Number(env.APPLY_PORT ?? 4000),
  cdpUrl: env.CDP_URL ?? "http://localhost:9222",
  chromeProfile: env.CHROME_PROFILE ?? resolve(homedir(), ".chrome-jobs"), // separate profile: Chrome 136+ blocks CDP on the default one
  navTimeoutMs: 20_000,
  retryTimeoutMs: 45_000,
};
