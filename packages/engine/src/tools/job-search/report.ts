import { mkdir, readFile, writeFile } from "fs/promises";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import { initDb } from "./db.ts";
import { OUTPUT_DIR } from "./paths.ts";
import type { ScoredJob, RunStats, VerifiedJob } from "./types.ts";

const DEFAULT_OUTPUT_DIR = OUTPUT_DIR;
const DEFAULT_DB_PATH = join(DEFAULT_OUTPUT_DIR, "jobs.db");

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function formatDate(d: Date): { weekday: string; month: string; day: number; year: number; time: string } {
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const month = d.toLocaleDateString("en-US", { month: "long" });
  const day = d.getDate();
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return { weekday, month, day, year, time: `${hh}:${mm}:${ss}` };
}

function jobSection(job: ScoredJob): string {
  const posted = job.datePosted ?? "unknown";
  const desc = (job.description ?? "").slice(0, 300).replace(/\n/g, " ");
  const lines: string[] = [
    `#### ${job.title} — ${job.company ?? "unknown"}`,
    `- **URL:** ${job.url}`,
    `- **Posted:** ${posted}`,
    `- **Description:** ${desc}${desc.length >= 300 ? "..." : ""}`,
  ];

  if (job.fitReasons && job.fitReasons.length > 0) {
    lines.push(`- **Fit reasons:** ${job.fitReasons.join("; ")}`);
  }
  if (job.fitGaps && job.fitGaps.length > 0) {
    lines.push(`- **Gaps:** ${job.fitGaps.join("; ")}`);
  }
  if (job.resumeMdPath) {
    const filename = job.resumeMdPath.split("/").pop() ?? job.resumeMdPath;
    lines.push(`- **Resume:** ${filename}`);
    lines.push(`- **Path:** ${job.resumeMdPath}`);
  }

  return lines.join("\n");
}

export async function generateReport(
  outputDir: string = DEFAULT_OUTPUT_DIR,
  dbPath: string = DEFAULT_DB_PATH
): Promise<string> {
  const now = new Date();
  const { weekday, month, day, year, time } = formatDate(now);

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const dateTag = `${year}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}-${hh}${mm}`;

  const reportsDir = join(outputDir, "reports");
  await mkdir(reportsDir, { recursive: true });

  // Load data sources
  const stats = await readJson<RunStats>(join(outputDir, "stats.json"));
  const fresh = await readJson<VerifiedJob[]>(join(outputDir, "verified-fresh.json")) ?? [];
  const needsDate = await readJson<VerifiedJob[]>(join(outputDir, "needs-date.json")) ?? [];
  const eligible = await readJson<ScoredJob[]>(join(outputDir, "eligible-jobs.json")) ?? [];

  const jobsFound = stats?.uniqueResults ?? 0;
  const afterVerification = fresh.length + needsDate.length;
  const eligibleCount = eligible.length;

  // Load all classified jobs from DB
  let strong: ScoredJob[] = [];
  let possible: ScoredJob[] = [];
  let skipped: ScoredJob[] = [];
  let notAssessed: ScoredJob[] = [];

  try {
    const db = initDb(dbPath);
    const rows = db
      .prepare(
        `SELECT raw_json, fit_classification, resume_md_path, fit_reasons, fit_gaps
         FROM jobs ORDER BY last_seen_at DESC`
      )
      .all() as Array<{
        raw_json: string;
        fit_classification: string | null;
        resume_md_path: string | null;
        fit_reasons: string | null;
        fit_gaps: string | null;
      }>;

    for (const row of rows) {
      const job = JSON.parse(row.raw_json) as ScoredJob;
      // Hydrate from DB columns (tailor-batch updates DB but may not update raw_json fully)
      if (row.fit_classification) job.fitClassification = row.fit_classification as ScoredJob["fitClassification"];
      if (row.resume_md_path) job.resumeMdPath = row.resume_md_path;
      if (row.fit_reasons) {
        try { job.fitReasons = JSON.parse(row.fit_reasons) as string[]; } catch { /* ignore */ }
      }
      if (row.fit_gaps) {
        try { job.fitGaps = JSON.parse(row.fit_gaps) as string[]; } catch { /* ignore */ }
      }

      switch (job.fitClassification) {
        case "STRONG_FIT": strong.push(job); break;
        case "POSSIBLE_FIT": possible.push(job); break;
        case "SKIP": skipped.push(job); break;
        default: notAssessed.push(job); break;
      }
    }
  } catch {
    // DB not available — use eligible list as not-assessed
    notAssessed = eligible;
  }

  const resumesGenerated = strong.length + possible.length;
  const skippedCount = skipped.length;

  // Build report
  const lines: string[] = [
    `# Job Search Report`,
    `**Date:** ${weekday}, ${month} ${day}, ${year}`,
    `**Time:** ${time}`,
    ``,
    `## Summary`,
    `| Metric | Count |`,
    `|---|---|`,
    `| Jobs found (search) | ${jobsFound} |`,
    `| After verification | ${afterVerification} |`,
    `| Eligible (post-enrich) | ${eligibleCount} |`,
    `| Resumes generated | ${resumesGenerated} |`,
    `| Skipped (poor fit) | ${skippedCount} |`,
    ``,
    `## Jobs`,
  ];

  if (strong.length > 0) {
    lines.push(``, `### STRONG_FIT`, ``);
    lines.push(...strong.map(jobSection));
  }

  if (possible.length > 0) {
    lines.push(``, `### POSSIBLE_FIT`, ``);
    lines.push(...possible.map(jobSection));
  }

  if (skipped.length > 0) {
    lines.push(``, `### SKIP`, ``);
    lines.push(...skipped.map(jobSection));
  }

  if (notAssessed.length > 0) {
    lines.push(``, `### Not Assessed (eligible but tailor-batch not yet run)`, ``);
    lines.push(...notAssessed.map(jobSection));
  }

  if (strong.length === 0 && possible.length === 0 && skipped.length === 0 && notAssessed.length === 0) {
    lines.push(``, `_No jobs in database yet. Run steps 1–4 first._`);
  }

  const content = lines.join("\n") + "\n";
  const reportPath = join(reportsDir, `report-${dateTag}.md`);
  await writeFile(reportPath, content, "utf8");
  return reportPath;
}

// Run directly
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  generateReport()
    .then((path) => console.log(`Report saved to ${path}`))
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
}
