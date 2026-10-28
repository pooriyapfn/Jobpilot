// Structural config only — safe to commit and publish.
// Anything personal (your name, API keys) lives in `.env.local`, which is gitignored.
// Models are set per agent in agents.config.ts at the project root.

import { join } from "node:path";
import { agents } from "../../../agents.config.ts";
import { config as appConfig } from "../../config.ts";

export const config = {
  // Falls back to the tailored resume's own heading if unset.
  candidateName: process.env.CANDIDATE_NAME,

  atsThreshold: Number(process.env.ATS_THRESHOLD ?? 85),
  maxIterations: Number(process.env.MAX_ITERATIONS ?? 3),

  models: agents.tailor,

  // Absolute paths: knowledge/resume/* is the intelligence, data/tailor/* the per-run input.
  inputFiles: {
    jobDescription: join(appConfig.tailorDir, "job_description.md"),
    resume: join(appConfig.resumeDir, "main_resume.md"),
    experience: join(appConfig.resumeDir, "base_resume.md"),
    rules: join(appConfig.resumeDir, "rules.md"),
  },

  outputDir: appConfig.tailorOutputDir,
} as const;
