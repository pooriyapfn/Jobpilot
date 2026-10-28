import chalk from "chalk";
import select, { Separator } from "@inquirer/select";
import Database from "better-sqlite3";
import { spawn } from "child_process";
import { existsSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { config } from "../config.ts";
import { addExcludedCompanies } from "../tools/job-search/company-exclusions.ts";
import { makeId } from "../tools/job-search/db.ts";
import { OUTPUT_DIR } from "../tools/job-search/paths.ts";
import { generateReport } from "../tools/job-search/report.ts";
import type { RunStats, ScoredJob, VerifiedJob } from "../tools/job-search/types.ts";

const ROOT = config.root; // every npm script runs from the project root
const APPLY_DB = config.dbPath;
const DASHBOARD_URL = `http://localhost:${config.port}`;

// ── actions ────────────────────────────────────────────────────────────────

type Action =
  | "search" | "verify" | "enrich" | "prepare" | "fill" | "dashboard"
  | "find-prepare" | "tailor" | "chrome" | "report" | "exclude" | "quit";

interface Step { label: string; desc: string; run: () => Promise<boolean> }

const outcome: Partial<Record<Action, boolean>> = {}; // this session's results (✓ / ✗)

// ── data ───────────────────────────────────────────────────────────────────

async function readJson<T>(name: string): Promise<T | null> {
  try { return JSON.parse(await readFile(join(OUTPUT_DIR, name), "utf8")) as T; }
  catch { return null; }
}

const mtime = (file: string): Date | undefined =>
  existsSync(file) ? statSync(file).mtime : undefined;

interface ApplyStats {
  byStatus: Record<string, number>;
  submittedToday: number;
  newJobs: number;      // eligible jobs not prepared yet
  lastPrepared?: Date;
}

function applyStats(eligible: ScoredJob[]): ApplyStats {
  const empty = { byStatus: {}, submittedToday: 0, newJobs: eligible.length };
  if (!existsSync(APPLY_DB)) return empty;
  const db = new Database(APPLY_DB, { readonly: true });
  try {
    const rows = db.prepare("SELECT id, status, updated_at FROM applications").all() as
      { id: string; status: string; updated_at: string }[];
    const known = new Set(rows.map((r) => r.id));
    const today = new Date().toDateString();
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const last = rows.map((r) => r.updated_at).sort().at(-1);
    return {
      byStatus,
      submittedToday: rows.filter((r) => r.status === "submitted" && new Date(r.updated_at).toDateString() === today).length,
      newJobs: eligible.filter((j) => !known.has(makeId(j.url))).length,
      lastPrepared: last ? new Date(last) : undefined,
    };
  } finally {
    db.close();
  }
}

async function loadState() {
  const [stats, fresh, eligible] = await Promise.all([
    readJson<RunStats>("stats.json"),
    readJson<VerifiedJob[]>("verified-fresh.json"),
    readJson<ScoredJob[]>("eligible-jobs.json"),
  ]);
  const apply = applyStats(eligible ?? []);
  const s = apply.byStatus;
  return {
    found: stats?.uniqueResults ?? 0,
    fresh: fresh?.length ?? 0,
    eligible: eligible?.length ?? 0,
    ready: (s["prepared"] ?? 0) + (s["blocked"] ?? 0),
    manual: s["manual"] ?? 0,
    submitted: s["submitted"] ?? 0,
    apply,
    ran: {
      search: mtime(join(OUTPUT_DIR, "stats.json")),
      verify: mtime(join(OUTPUT_DIR, "verified-fresh.json")),
      enrich: mtime(join(OUTPUT_DIR, "eligible-jobs.json")),
      prepare: apply.lastPrepared,
    } as Partial<Record<Action, Date>>,
  };
}
type State = Awaited<ReturnType<typeof loadState>>;

// ── formatting ─────────────────────────────────────────────────────────────

function ago(d?: Date): string {
  if (!d) return "never";
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

const num = (v: number, color: (s: string) => string) => (v ? color(String(v)) : chalk.dim("0"));
const dot = chalk.dim("  ·  ");

function printHeader(st: State): void {
  const now = new Date().toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  console.log(`\n   ${chalk.bold.cyan("Job Pipeline")}   ${chalk.dim(now)}\n`);
  console.log(
    `   ${chalk.dim("Find ")}   found ${num(st.found, chalk.white)}${dot}fresh ${num(st.fresh, chalk.green)}` +
    `${dot}eligible ${num(st.eligible, chalk.bold.green)}`,
  );
  console.log(
    `   ${chalk.dim("Apply")}   ready ${num(st.ready, chalk.bold.cyan)}${dot}new ${num(st.apply.newJobs, chalk.yellow)}` +
    `${dot}manual ${num(st.manual, chalk.magenta)}${dot}submitted ${num(st.submitted, chalk.green)}` +
    (st.apply.submittedToday ? chalk.dim(` (${st.apply.submittedToday} today)`) : ""),
  );
  console.log();
}

// ── running things ─────────────────────────────────────────────────────────

function run(cmd: string, args: string[], cwd = ROOT): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env: process.env });
    child.on("close", (code) => done(code === 0));
    child.on("error", () => done(false));
  });
}
const npm = (script: string) => run("npm", ["run", "-s", script]);
const npmArgs = (script: string, ...args: string[]) =>
  run("npm", ["run", "-s", script, ...(args.length ? ["--", ...args] : [])]);

const ask = <T>(message: string, choices: { name: string; value: T }[], def?: T) =>
  select<T>({ message, choices, default: def });

const askCount = (what: string, available: number) =>
  ask(`How many jobs to ${what}?`, [
    ...[5, 10, 20].filter((n) => n < available).map((n) => ({ name: String(n), value: n })),
    { name: `All (${available})`, value: available },
  ], Math.min(10, available));

function waitKey(message = "Press any key to return to menu…"): Promise<void> {
  console.log(chalk.dim(`\n   ${message}`));
  return new Promise((done) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      done();
    });
  });
}

async function prepare(st: State): Promise<boolean> {
  if (!st.apply.newJobs) return console.log(chalk.yellow("   No new eligible jobs — run Find first.")), true;
  const n = await askCount("prepare", st.apply.newJobs);
  console.log(chalk.dim(`\n   Tailoring resumes + answering forms for ${n} job(s) · ~1–2 min each\n`));
  return npmArgs("prepare-jobs", "--limit", String(n));
}

async function fill(st: State): Promise<boolean> {
  if (!st.ready) return console.log(chalk.yellow("   Nothing ready — run Prepare first.")), true;
  const n = await askCount("open in Chrome", st.ready);
  return npmArgs("fill", "--limit", String(n));
}

async function dashboard(): Promise<boolean> {
  const server = spawn("npm", ["run", "-s", "dashboard"], { cwd: ROOT, stdio: "inherit", env: process.env });
  setTimeout(() => spawn("open", [DASHBOARD_URL]), 1_500);
  await waitKey("Dashboard running — press any key to stop it…");
  server.kill();
  return true;
}

async function excludeEligible(): Promise<boolean> {
  const companies = [...new Set((await readJson<ScoredJob[]>("eligible-jobs.json") ?? [])
    .map((j) => j.company).filter((c): c is string => !!c))];
  if (!companies.length) return console.log(chalk.yellow("   No companies in eligible-jobs.json.")), true;
  const { added, total } = await addExcludedCompanies(join(OUTPUT_DIR, "excluded-companies.json"), companies);
  console.log(`   +${chalk.green(added)} new  ·  ${chalk.dim(`${total} total`)}`);
  for (const c of companies) console.log(chalk.dim(`     - ${c}`));
  console.log(chalk.dim("\n   They'll be rejected on the next Verify."));
  return true;
}

async function findAndPrepare(st: State): Promise<boolean> {
  for (const key of ["search", "verify", "enrich"] as const) {
    console.log(chalk.bold(`\n   ── ${steps(st)[key].label} ${"─".repeat(40)}\n`));
    if (!(outcome[key] = await steps(st)[key].run())) return false;
  }
  console.log(chalk.bold(`\n   ── Prepare applications ${"─".repeat(40)}\n`));
  if (!(await prepare(await loadState()))) return false;
  const st2 = await loadState();
  if (st2.ready && (await ask("Open them in Chrome now?", [{ name: "Yes, fill now", value: true }, { name: "Later", value: false }], true))) {
    return fill(st2);
  }
  return true;
}

function steps(st: State): Record<Action, Step> {
  return {
    search:  { label: "Search jobs",            desc: "Brave + job boards → output/jobs.json", run: () => npm("search") },
    verify:  { label: "Verify + filter",        desc: "Fetch pages, freshness, location, closed postings", run: () => npm("verify") },
    enrich:  { label: "Check eligibility",      desc: "LLM reviews uncertain locations → eligible-jobs.json", run: () => npm("enrich") },
    prepare: { label: "Prepare applications",   desc: "Tailor resume + answer form questions per job (headless)", run: () => prepare(st) },
    fill:    { label: "Fill jobs in Chrome",    desc: "Open N tabs filled in your Chrome · you review and submit", run: () => fill(st) },
    dashboard: { label: "Review answers",       desc: `Edit answers / see statuses at ${DASHBOARD_URL}`, run: dashboard },
    "find-prepare": { label: "Find + prepare",  desc: "Search → verify → eligibility → prepare, then offer to fill", run: () => findAndPrepare(st) },
    tailor:  { label: "Tailor one resume",      desc: "Resume for data/tailor/job_description.md → data/tailor/output/", run: () => npm("tailor") },
    chrome:  { label: "Open job Chrome",        desc: "Separate Chrome profile — log in to LinkedIn etc. once", run: () => npm("chrome") },
    report:  { label: "Generate report",        desc: "Markdown report from all output files", run: async () => (console.log(`   Saved: ${await generateReport(OUTPUT_DIR)}`), true) },
    exclude: { label: "Exclude eligible companies", desc: "Never show these companies again", run: excludeEligible },
    quit:    { label: "Quit", desc: "", run: async () => true },
  };
}

// ── menu ───────────────────────────────────────────────────────────────────

// Where the cursor starts: the step that makes sense next.
function suggested(st: State): Action {
  if (st.ready) return "fill";
  if (st.apply.newJobs) return "prepare";
  return "find-prepare";
}

function choices(st: State) {
  const all = steps(st);
  const mark = (a: Action) => (outcome[a] === true ? chalk.green("✓") : outcome[a] === false ? chalk.red("✗") : " ");
  const item = (a: Action, hint = "") => ({
    name: `${mark(a)} ${all[a].label.padEnd(28)}${chalk.dim(hint)}`,
    value: a,
    description: chalk.dim(all[a].desc),
  });
  const section = (t: string) => new Separator(chalk.dim(`\n  ${t}`));
  return [
    section("FIND"),
    item("search", ago(st.ran.search)),
    item("verify", ago(st.ran.verify)),
    item("enrich", ago(st.ran.enrich)),
    section("APPLY"),
    item("prepare", st.apply.newJobs ? `${st.apply.newJobs} new` : ago(st.ran.prepare)),
    item("fill", st.ready ? `${st.ready} ready` : ""),
    item("dashboard"),
    section("RUN"),
    item("find-prepare", "the daily run"),
    section("MORE"),
    item("tailor"),
    item("chrome"),
    item("report"),
    item("exclude"),
    item("quit"),
  ];
}

// ── main ───────────────────────────────────────────────────────────────────

const ALT_ON = "\x1b[?1049h", ALT_OFF = "\x1b[?1049l", CLEAR = "\x1b[H\x1b[J";
const CURSOR_HIDE = "\x1b[?25l", CURSOR_SHOW = "\x1b[?25h";

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("CLI requires an interactive terminal (TTY).");
    process.exit(1);
  }
  const bye = () => { process.stdout.write(ALT_OFF + CURSOR_SHOW); process.exit(0); };
  process.on("SIGTERM", bye);
  // Ctrl+C while a step runs belongs to that step (fill puts open jobs back in the queue) — keep the CLI alive.
  process.on("SIGINT", () => {});

  while (true) {
    // Menu lives on the alternate screen so it never clutters scroll history.
    process.stdout.write(ALT_ON + CURSOR_HIDE + CLEAR);
    const st = await loadState();
    printHeader(st);

    let action: Action;
    try {
      action = await select<Action>({
        message: chalk.dim("↑↓ move · enter run"),
        choices: choices(st),
        default: suggested(st),
        pageSize: 20,
        loop: false,
        theme: {
          icon: { cursor: chalk.cyan("❯") },
          style: { highlight: (t: string) => chalk.bold.white(t), description: (t: string) => `\n  ${t}` },
        },
      });
    } catch {
      return bye(); // Ctrl+C in the menu
    }
    if (action === "quit") return bye();

    // Step output goes to the normal screen (scrollable, stays after exit).
    process.stdout.write(ALT_OFF + CURSOR_SHOW);
    const step = steps(st)[action];
    console.log(chalk.bold.cyan(`\n   ${step.label}\n`));
    try {
      outcome[action] = await step.run();
      if (!outcome[action]) console.log(chalk.red("\n   Failed — see output above."));
    } catch (err) {
      outcome[action] = false; // e.g. Ctrl+C in a sub-prompt
      console.log(chalk.red(`\n   ${err instanceof Error ? err.message : String(err)}`));
    }
    await waitKey();
  }
}

main().catch((err) => {
  process.stdout.write(ALT_OFF + CURSOR_SHOW);
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
