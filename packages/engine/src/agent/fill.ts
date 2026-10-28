// Opens up to N prepared jobs as filled tabs in your Chrome and waits while you review + submit each.
// Usage: npm run fill [-- --limit 10]
import { styleText } from "node:util";
import { getApp, listApps, setStatus } from "../db.ts";
import { ensureChrome } from "../browser/session.ts";
import type { Application, Status } from "../types.ts";
import { applyJob } from "./apply.ts";

const FIT_RANK: Record<string, number> = { STRONG_FIT: 0, POSSIBLE_FIT: 1 };
const READY: Status[] = ["prepared", "blocked"];

// Best fit first, then highest ATS score.
const pickJobs = (limit: number): Application[] =>
  listApps()
    .filter((a) => READY.includes(a.status))
    .sort((a, b) => (FIT_RANK[a.fit ?? ""] ?? 2) - (FIT_RANK[b.fit ?? ""] ?? 2) || (b.atsScore ?? 0) - (a.atsScore ?? 0))
    .slice(0, limit);

const ICON: Partial<Record<Status, string>> = {
  filling: styleText("yellow", "◐ filling  "),
  submitted: styleText("green", "✓ submitted"),
  skipped: styleText("gray", "– skipped  "),
  closed: styleText("gray", "✗ closed   "),
  error: styleText("red", "✗ error    "),
};

// One row per job, cut to the terminal width so the in-place redraw never wraps.
const line = (a: Application) => {
  const text = `${a.company} — ${a.title}${a.note ? `  · ${a.note}` : ""}`;
  return `  ${ICON[a.status] ?? a.status.padEnd(11)}  ${text.slice(0, (process.stdout.columns || 100) - 17)}`;
};

// Redraws the status block in place.
const render = (ids: string[], first: boolean) => {
  const apps = ids.map((id) => getApp(id)!);
  const open = apps.filter((a) => a.status === "filling").length;
  const out = [...apps.map(line), "", styleText("gray", `  ${open} tab(s) waiting for you · Ctrl+C to stop (tabs stay open)`)];
  if (!first) process.stdout.write(`\x1b[${out.length}A`);
  process.stdout.write(out.map((l) => `\x1b[2K${l}`).join("\n") + "\n");
};

const main = async () => {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 10;
  const jobs = pickJobs(limit);
  if (!jobs.length) return console.log("Nothing ready — run prepare first.");

  await ensureChrome();
  const ids = jobs.map((j) => j.id);
  console.log(`\n  Filling ${ids.length} job(s) in your Chrome — review each tab, fix orange fields, press Submit.\n`);

  // Stopping early: unfinished jobs go back to the queue for the next run.
  process.on("SIGINT", () => {
    for (const id of ids) if (getApp(id)?.status === "filling") setStatus(id, "prepared", "");
    process.exit(0);
  });

  render(ids, true);
  const timer = setInterval(() => render(ids, false), 1_000);
  await Promise.all(ids.map((id) => applyJob(id).catch((e) => setStatus(id, "error", String(e.message ?? e)))));
  clearInterval(timer);
  render(ids, false);

  const done = ids.filter((id) => getApp(id)?.status === "submitted").length;
  console.log(`\n  ${styleText("bold", `${done}/${ids.length} submitted.`)}\n`);
  process.exit(0);
};

main().catch((e) => {
  console.error(`\n  ✗ ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
