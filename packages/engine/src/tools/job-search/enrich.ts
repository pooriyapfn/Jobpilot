import chalk from "chalk";
import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "node:url";
import { checkEligibilityBatch } from "./eligibility.ts";
import { initDb, upsertJob, getNewJobs, markNotified } from "./db.ts";
import type { ScoredJob, VerifiedJob } from "./types.ts";
import { OUTPUT_DIR } from "./paths.ts";

const DB_PATH = process.env["DB_PATH"] ?? `${OUTPUT_DIR}jobs.db`;
const ELIGIBILITY_THRESHOLD = 0.85;
const ELIGIBLE_SCOPES = new Set(["home", "worldwide", "emea"]);

async function readJobFile(name: string): Promise<VerifiedJob[]> {
  try {
    const raw = await readFile(`${OUTPUT_DIR}${name}`, "utf8");
    // Files written before the "turkey" → "home" rename
    return (JSON.parse(raw) as VerifiedJob[]).map((j) => {
      const legacy = j as unknown as { geographicScope?: string; locationEligibility?: string };
      if (legacy.geographicScope === "turkey") legacy.geographicScope = "home";
      if (legacy.locationEligibility === "turkey-ok") legacy.locationEligibility = "home-ok";
      return j;
    });
  } catch {
    return [];
  }
}

/**
 * Pure function: check whether a job satisfies all fail-closed output invariants.
 * Exported for testing.
 */
export function isEligibleForOutput(job: ScoredJob): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (job.availabilityStatus !== "confirmed-live") {
    violations.push(`availabilityStatus=${job.availabilityStatus ?? "missing"}`);
  }
  if (job.workMode !== "remote") {
    violations.push(`workMode=${job.workMode ?? "missing"}`);
  }
  if (job.freshness === "old") {
    violations.push("freshness=old");
  }
  const deterministicGeoEligible =
    !!job.geographicScope && ELIGIBLE_SCOPES.has(job.geographicScope);
  const llmGeoEligible =
    (!job.geographicScope || job.geographicScope === "unknown") &&
    job.llmEligibility?.status === "eligible" &&
    job.llmEligibility.confidence >= ELIGIBILITY_THRESHOLD;
  if (!deterministicGeoEligible && !llmGeoEligible) {
    violations.push("geographic eligibility not confirmed");
  }
  if (job.rejectionReason) {
    violations.push(`rejectionReason=${job.rejectionReason}`);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Final output invariant gate — logs violations and returns false on failure.
 */
function assertEligible(job: ScoredJob): boolean {
  const { ok, violations } = isEligibleForOutput(job);
  if (!ok) {
    console.warn(`  [invariant] ${job.url} failed: ${violations.join(", ")} — dropping from eligible`);
  }
  return ok;
}

async function main() {
  const runAt = new Date().toISOString();
  console.log(chalk.bold.cyan("\n  Job Enricher — LLM Eligibility + SQLite (fail-closed)"));
  console.log(chalk.dim(`  ${runAt}\n`));

  // 1. Load verified jobs
  const fresh = await readJobFile("verified-fresh.json");
  const needsDate = await readJobFile("needs-date.json");
  const uncertainRaw = await readJobFile("uncertain.json");

  console.log(`  Eligible (fresh):     ${chalk.green(fresh.length)}`);
  console.log(`  Eligible (no date):   ${chalk.green(needsDate.length)}`);
  console.log(`  Uncertain (→ LLM):    ${chalk.cyan(uncertainRaw.length)}\n`);

  // 2. LLM eligibility check for uncertain jobs (fail-closed)
  const llmEligible: ScoredJob[] = [];
  const llmRestricted: ScoredJob[] = [];
  const llmUncertain: ScoredJob[] = [];
  const llmFailed: ScoredJob[] = [];
  let allLlmChecked: ScoredJob[] = [];

  if (uncertainRaw.length > 0) {
    console.log(chalk.dim(`  Running eligibility LLM on ${uncertainRaw.length} uncertain jobs...`));
    const eligibilityMap = await checkEligibilityBatch(
      uncertainRaw,
      undefined,
      (done, total) => process.stdout.write(`\r  Eligibility: ${done}/${total}`)
    );
    console.log("\n");

    allLlmChecked = uncertainRaw.map((job): ScoredJob => ({
      ...job,
      llmEligibility: eligibilityMap.get(job.url),
    }));

    // Fail-closed: only keep jobs where LLM explicitly says eligible with high confidence
    for (const job of allLlmChecked) {
      const e = job.llmEligibility;
      if (!e || e.confidence === 0) {
        llmFailed.push({
          ...job,
          effectiveLocationEligibility: "uncertain",
          eligibilitySource: "llm",
        });
      } else if (e.status === "eligible" && e.confidence >= ELIGIBILITY_THRESHOLD) {
        llmEligible.push({
          ...job,
          effectiveLocationEligibility: "eligible",
          eligibilitySource: "llm",
        });
      } else if (e.status === "restricted") {
        llmRestricted.push({
          ...job,
          effectiveLocationEligibility: "restricted",
          eligibilitySource: "llm",
        });
      } else {
        llmUncertain.push({
          ...job,
          effectiveLocationEligibility: "uncertain",
          eligibilitySource: "llm",
        });
      }
    }

    console.log(`  LLM eligible:    ${chalk.green(llmEligible.length)}`);
    console.log(`  LLM restricted:  ${chalk.yellow(llmRestricted.length)}`);
    console.log(`  LLM uncertain:   ${chalk.cyan(llmUncertain.length)}`);
    console.log(`  LLM failed:      ${chalk.red(llmFailed.length)}`);
  }

  // 3. Combine eligible jobs (fresh + needsDate are already scope-eligible from verify)
  const preInvariant: ScoredJob[] = [
    ...fresh.map((j): ScoredJob => ({
      ...j,
      effectiveLocationEligibility: "eligible",
      eligibilitySource: "deterministic",
    })),
    ...needsDate.map((j): ScoredJob => ({
      ...j,
      effectiveLocationEligibility: "eligible",
      eligibilitySource: "deterministic",
    })),
    ...llmEligible,
  ];

  // 4. Apply output invariant — final safety net
  const eligibleJobs: ScoredJob[] = [];
  const invariantFailures: ScoredJob[] = [];
  for (const job of preInvariant) {
    if (assertEligible(job)) {
      eligibleJobs.push(job);
    } else {
      invariantFailures.push({
        ...job,
        effectiveLocationEligibility: "uncertain",
      });
    }
  }

  if (invariantFailures.length > 0) {
    console.log(chalk.yellow(`\n  Invariant violations: ${invariantFailures.length} jobs moved to uncertain`));
  }

  console.log(`\n  Total eligible:       ${chalk.bold(eligibleJobs.length)}\n`);

  const unresolvedJobs = [...llmUncertain, ...llmFailed, ...invariantFailures];
  await Promise.all([
    writeFile(`${OUTPUT_DIR}eligible-jobs.json`, JSON.stringify(eligibleJobs, null, 2), "utf8"),
    writeFile(`${OUTPUT_DIR}uncertain.json`, JSON.stringify(unresolvedJobs, null, 2), "utf8"),
    writeFile(`${OUTPUT_DIR}eligibility-reviewed.json`, JSON.stringify(allLlmChecked, null, 2), "utf8"),
    writeFile(`${OUTPUT_DIR}eligibility-rejected.json`, JSON.stringify(llmRestricted, null, 2), "utf8"),
  ]);

  if (eligibleJobs.length === 0) {
    console.log(chalk.yellow("  No jobs to process. Run `npm run verify` first.\n"));
    process.exit(0);
  }

  // 5. Persist to SQLite
  const db = initDb(DB_PATH);
  for (const job of eligibleJobs) {
    const id = upsertJob(db, job);
    job.dbId = id;
  }
  console.log(chalk.dim(`  Saved ${eligibleJobs.length} jobs to ${DB_PATH}\n`));

  // 6. Eligible and review outputs were written before persistence.
  console.log(chalk.dim(`  output/eligible-jobs.json — ${eligibleJobs.length} entries\n`));

  // 7. Print any already-classified jobs from previous tailor-batch runs
  const newJobs = getNewJobs(db);

  if (newJobs.length === 0) {
    console.log(chalk.dim(`  No classified jobs yet. Run \`npm run tailor-batch\` to generate resumes.\n`));
    return;
  }

  console.log(chalk.bold.cyan(`  Previously Classified Jobs\n`));
  console.log(
    chalk.dim(
      `  ${"Fit".padEnd(14)} ${"Company".padEnd(22)} ${"Title".padEnd(40)} URL`
    )
  );
  console.log(chalk.dim("  " + "─".repeat(100)));

  for (const job of newJobs) {
    const fit = (job.fitClassification ?? "unknown").padEnd(14);
    const company = (job.company ?? "unknown").slice(0, 20).padEnd(22);
    const title = job.title.slice(0, 38).padEnd(40);
    const fitColor = job.fitClassification === "STRONG_FIT" ? chalk.bold.green : chalk.green;
    console.log(`  ${fitColor(fit)} ${chalk.white(company)} ${title} ${chalk.dim(job.url)}`);
  }
  console.log();

  // 8. Mark as notified
  const idsToNotify = newJobs.map((j) => j.dbId!).filter(Boolean);
  markNotified(db, idsToNotify);
  console.log(chalk.dim(`  Marked ${idsToNotify.length} jobs as notified.\n`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(chalk.red("Fatal:"), err);
    process.exit(1);
  });
}
