import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { checkATS, type ATSResult } from "./ATSResult.ts";
import { config } from "./config.ts";
import { markdownToDocx, stripCodeFence } from "./docxExport.ts";
import { assessFit, type FitClassification } from "./fitAssessment.ts";
import { analyzeJD, type JDAnalysis } from "./JDAnalysis.ts";
import { callLLM, callLLMJson, getRunCost } from "./LLM.ts";
import * as logger from "./logger.ts";
import { getRelevantExperiences } from "./ReleventExperience.ts";
import type { ResumeWorkflowState } from "./state.ts";
import { tailorResume } from "./TailoreResume.ts";
import { validateResume } from "./validateResume.ts";

export type ResumeTailorInput = {
  jobDescription: string;
  baseResume: string;
  rules: string;
  rawExperiences: string;
  threshold?: number;
  force?: boolean;
};

export type ResumeCandidate = {
  resume: string;
  ats: ATSResult;
  iteration: number;
  violations: string[];
};

export class SkipError extends Error {
  readonly fit: FitClassification;
  constructor(fit: FitClassification) {
    super(`SKIP: ${fit.gaps.join("; ")}`);
    this.name = "SkipError";
    this.fit = fit;
  }
}

// Times a stage and reports its cost (delta of the running OpenRouter spend) in one line.
const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  logger.step(label);
  const costBefore = getRunCost();
  const start = Date.now();
  const result = await fn();
  logger.done(label, { ms: Date.now() - start, cost: getRunCost() - costBefore });
  return result;
};

export const runResumeTailor = async (
  input: ResumeTailorInput,
): Promise<ResumeCandidate & { jdAnalysis: JDAnalysis; fit: FitClassification }> => {
  const state: ResumeWorkflowState = {
    jobDescription: input.jobDescription,
    baseResume: input.baseResume,
    rules: input.rules,
    relevantExperience: [],
    iteration: 0,
    status: "analyzing",
  };
  const candidates: ResumeCandidate[] = [];

  state.jdAnalysis = await timed("Analyzing job description", () =>
    analyzeJD(input.jobDescription, callLLMJson),
  );
  const jdAnalysis = state.jdAnalysis;

  // SKIP gate — abort before spending tokens on tailoring if the role is a mismatch.
  const fit = await timed("Assessing fit", () =>
    assessFit(jdAnalysis, input.baseResume, input.rules, callLLMJson),
  );
  logger.done(`Fit: ${fit.classification}`);
  if (fit.classification === "SKIP") {
    if (!input.force) {
      throw new SkipError(fit);
    }
    logger.step("Fit was SKIP — continuing anyway (--force)");
  }

  state.status = "retrieving";
  state.relevantExperience = await timed(
    "Selecting relevant experience",
    () => getRelevantExperiences(jdAnalysis, input.rawExperiences, callLLMJson),
  );
  logger.done(`Selected ${state.relevantExperience.length} experience item(s)`);

  const threshold = input.threshold ?? config.atsThreshold;
  for (let i = 0; i < config.maxIterations; i++) {
    state.iteration = i + 1;
    state.status = "tailoring";

    state.currentResume = await timed(`Tailoring resume (round ${state.iteration})`, () =>
      tailorResume(
        {
          baseResume: input.baseResume,
          rules: input.rules,
          jdAnalysis,
          relventExperiences: state.relevantExperience,
          feedback: state.ats,
        },
        callLLM,
      ),
    );

    // Mechanical compliance check — no LLM, fast.
    const validation = validateResume(state.currentResume!, input.baseResume);
    if (!validation.passed) {
      logger.warn(`${validation.violations.length} compliance violation(s) in round ${state.iteration} — see summary`);
    }

    state.status = "checking";
    state.ats = await timed(`Scoring resume (round ${state.iteration})`, () =>
      checkATS(state.currentResume!, jdAnalysis, state.relevantExperience, callLLMJson),
    );
    logger.done(`Round ${state.iteration} score: ${state.ats.score}/100`);

    candidates.push({
      resume: state.currentResume,
      ats: state.ats,
      iteration: state.iteration,
      violations: validation.violations,
    });

    if (state.ats.score >= threshold) {
      logger.done(`Reached target score (${threshold}+)`);
      break;
    }

    const previous = candidates[candidates.length - 2];
    if (previous && state.ats.score <= previous.ats.score) {
      logger.warn("Score stopped improving — using best round so far");
      break;
    }
  }

  state.status = "completed";
  const best = candidates.sort((a, b) => b.ats.score - a.ats.score)[0];
  return { ...best, jdAnalysis, fit };
};

const readRequired = async (path: string): Promise<string> => {
  const text = await readFile(path, "utf8");
  if (!text.trim()) {
    throw new Error(`${basename(path)} is empty`);
  }
  return text;
};

const slugPart = (value: string): string =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const toTitleCase = (value: string): string =>
  value
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");

const extractCandidateName = (resumeMarkdown: string): string => {
  const heading = resumeMarkdown.match(/^#\s+(.+)$/m);
  return heading ? toTitleCase(heading[1]!.trim()) : "Candidate";
};

const buildOutputBaseName = (candidateName: string, jd: JDAnalysis): string => {
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "long" });
  return [candidateName, jd.title, jd.company]
    .map(slugPart)
    .filter(Boolean)
    .concat(`${now.getFullYear()}`, month)
    .join("-");
};

const main = async () => {
  const force = process.argv.slice(2).some((arg) => arg === "--force" || arg === "-f");

  const [jobDescription, mainResume, baseResume, rules] = await Promise.all([
    readRequired(config.inputFiles.jobDescription),
    readRequired(config.inputFiles.resume),
    readRequired(config.inputFiles.experience),
    readRequired(config.inputFiles.rules),
  ]);

  let result: Awaited<ReturnType<typeof runResumeTailor>>;
  try {
    result = await runResumeTailor({
      jobDescription,
      baseResume: mainResume,
      rawExperiences: baseResume,
      rules,
      force,
    });
  } catch (error) {
    if (error instanceof SkipError) {
      logger.summary([
        `  Fit:          SKIP — no resume generated`,
        `  Gaps:         ${error.fit.gaps.join(", ") || "see reasons below"}`,
        ...error.fit.reasons.map((r) => `  Reason:       ${r}`),
        `  Total cost:   $${getRunCost().toFixed(4)}`,
      ]);
      return;
    }
    throw error;
  }

  const cleanMarkdown = stripCodeFence(result.resume);
  const candidateName = config.candidateName ?? extractCandidateName(cleanMarkdown);
  const baseName = buildOutputBaseName(candidateName, result.jdAnalysis);

  const outputDir = config.outputDir;
  await mkdir(outputDir, { recursive: true });

  const mdPath = join(outputDir, `${baseName}.md`);
  const docxPath = join(outputDir, `${baseName}.docx`);

  await writeFile(mdPath, cleanMarkdown, "utf8");
  await writeFile(docxPath, await markdownToDocx(cleanMarkdown));

  const hasViolations = result.violations.length > 0;
  logger.summary([
    `  Fit:          ${result.fit.classification}`,
    `  Best round:   ${result.iteration}`,
    `  ATS score:    ${result.ats.score}/100`,
    `  Total cost:   $${getRunCost().toFixed(4)}`,
    `  Output:       ${relative(process.cwd(), mdPath)}`,
    `                ${relative(process.cwd(), docxPath)}`,
    ...(hasViolations
      ? [
          ``,
          `  ⚠ COMPLIANCE VIOLATIONS — review before submitting:`,
          ...result.violations.map((v) => `    ${v}`),
        ]
      : [`  Compliance:   PASSED`]),
  ]);
};

// Only run the CLI when executed directly — importing runResumeTailor as a library must not tailor job_description.md.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    logger.fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
