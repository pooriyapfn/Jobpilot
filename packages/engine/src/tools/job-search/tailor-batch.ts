import chalk from "chalk";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { config as appConfig } from "../../config.ts";
import { config } from "../tailor/config.ts";
import { markdownToDocx, stripCodeFence } from "../tailor/docxExport.ts";
import { runResumeTailor, SkipError } from "../tailor/runner.ts";
import { initDb, upsertJob } from "./db.ts";
import { OUTPUT_DIR } from "./paths.ts";
import type { ScoredJob } from "./types.ts";

const DB_PATH = process.env["DB_PATH"] ?? `${OUTPUT_DIR}jobs.db`;
const BATCH_DELAY_MS = 5_000;

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

async function main() {
  const runAt = new Date().toISOString();
  console.log(chalk.bold.cyan("\n  Tailor Batch — Fit Assessment + Resume Generation"));
  console.log(chalk.dim(`  ${runAt}\n`));

  // 1. Read eligible-jobs.json
  let eligibleJobs: ScoredJob[];
  try {
    const raw = await readFile(`${OUTPUT_DIR}eligible-jobs.json`, "utf8");
    eligibleJobs = JSON.parse(raw) as ScoredJob[];
  } catch {
    console.error(chalk.red("  eligible-jobs.json not found. Run `npm run enrich` first.\n"));
    process.exit(1);
  }

  if (eligibleJobs.length === 0) {
    console.log(chalk.yellow("  No eligible jobs. Run `npm run enrich` first.\n"));
    process.exit(0);
  }

  console.log(`  Jobs to process:  ${chalk.bold(eligibleJobs.length)}\n`);

  // 2. Load resume knowledge once
  const [mainResume, baseResume, rules] = await Promise.all([
    readFile(join(appConfig.resumeDir, "main_resume.md"), "utf8"),
    readFile(join(appConfig.resumeDir, "base_resume.md"), "utf8"),
    readFile(join(appConfig.resumeDir, "rules.md"), "utf8"),
  ]);

  // 3. Init DB
  const db = initDb(DB_PATH);

  const outputDir = config.outputDir;
  await mkdir(outputDir, { recursive: true });

  let processed = 0;
  let resumes = 0;
  let skipped = 0;

  // 5. Process each job sequentially
  for (const job of eligibleJobs) {
    const label = `${job.title} @ ${job.company ?? "unknown"}`;
    console.log(chalk.dim(`  Processing: ${label}`));

    const jobDescription = [
      `# ${job.title} at ${job.company ?? "unknown"}`,
      "",
      job.description ?? "",
      ...(job.extraSnippets ?? []),
    ].join("\n");

    try {
      const result = await runResumeTailor({
        jobDescription,
        baseResume: mainResume,
        rawExperiences: baseResume,
        rules,
      });

      const cleanMarkdown = stripCodeFence(result.resume);
      const candidateName = config.candidateName ?? extractCandidateName(cleanMarkdown);

      const now = new Date();
      const month = now.toLocaleString("en-US", { month: "long" });
      const baseName = [candidateName, result.jdAnalysis.title, result.jdAnalysis.company]
        .map(slugPart)
        .filter(Boolean)
        .concat(`${now.getFullYear()}`, month)
        .join("-");

      const mdPath = join(outputDir, `${baseName}.md`);
      const docxPath = join(outputDir, `${baseName}.docx`);

      await writeFile(mdPath, cleanMarkdown, "utf8");
      await writeFile(docxPath, await markdownToDocx(cleanMarkdown));

      const updatedJob: ScoredJob = {
        ...job,
        fitClassification: result.fit.classification,
        fitReasons: result.fit.reasons,
        fitGaps: result.fit.gaps,
        resumeMdPath: mdPath,
        resumeDocxPath: docxPath,
      };
      const id = upsertJob(db, updatedJob);
      updatedJob.dbId = id;

      const fitColor =
        result.fit.classification === "STRONG_FIT" ? chalk.bold.green : chalk.green;
      console.log(
        `  ${fitColor(result.fit.classification)} — ${label} — ATS ${result.ats.score}/100`
      );
      resumes++;
    } catch (err) {
      if (err instanceof SkipError) {
        const updatedJob: ScoredJob = {
          ...job,
          fitClassification: "SKIP",
          fitReasons: err.fit.reasons,
          fitGaps: err.fit.gaps,
        };
        upsertJob(db, updatedJob);
        console.log(`  ${chalk.yellow("SKIP")} — ${label}`);
        skipped++;
      } else {
        console.error(
          chalk.red(`  ERROR — ${label}: ${err instanceof Error ? err.message : String(err)}`)
        );
      }
    }

    processed++;

    if (processed < eligibleJobs.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(
    `\n  ${chalk.bold("Done")} — ${processed} processed, ${chalk.green(resumes)} resumes generated, ${chalk.yellow(skipped)} skipped\n`
  );
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
