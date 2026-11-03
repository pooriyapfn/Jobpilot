import chalk from "chalk";
import { mkdir, readFile, writeFile } from "fs/promises";
import { searchQueries } from "./config.ts";
import { deduplicate, isBlocked } from "./filters.ts";
import { braveFreshness, runAllSearches, searchWindowDays } from "./search.ts";
import { setSourceMaxAgeDays } from "./sources/boards.ts";
import { resolvedNote, resolveListings, WELLFOUND_QUERIES, wellfoundListings } from "./sources/aggregators.ts";
import { harvestBoards } from "./sources/company-boards.ts";
import { ALL_SOURCES, runSources, type SourceName } from "./sources/index.ts";
import type { SearchJob, RunStats } from "./types.ts";
import { OUTPUT_DIR } from "./paths.ts";

// When each part last ran — the next run only looks back that far (plus overlap).
interface LastRun {
  brave?: string;
  boards?: string;
}
const LAST_RUN_PATH = `${OUTPUT_DIR}last-run.json`;

async function main() {
  const runAt = new Date().toISOString();
  console.log(chalk.bold.cyan("\n  Job Search CLI — Brave Search"));
  console.log(chalk.dim(`  ${runAt}\n`));

  await mkdir(OUTPUT_DIR, { recursive: true });

  let totalRequests = 0;
  const onRequest = () => { totalRequests++; };

  const allRaw: Array<Omit<SearchJob, "foundByQueries"> & { query: string }> = [];
  const stats: RunStats = {
    runAt,
    requests: 0,
    rawResults: 0,
    afterDomainFiltering: 0,
    uniqueResults: 0,
    queries: {},
  };

  // --only=brave,wellfound,watchlist,funding,yc,hn,google,sites,remoteok,himalayas,known  (default: everything)
  const onlyArg = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  const only = onlyArg ? new Set(onlyArg.split(",")) : null;
  const useBrave = !only || only.has("brave");
  const useWellfound = !only || only.has("wellfound");
  const sources = ALL_SOURCES.filter((s) => !only || only.has(s));

  const lastRun: LastRun = await readFile(LAST_RUN_PATH, "utf8").then((s) => JSON.parse(s) as LastRun, () => ({}));
  const braveDays = searchWindowDays(lastRun.brave);
  const boardDays = searchWindowDays(lastRun.boards);
  setSourceMaxAgeDays(boardDays);
  const freshness = braveFreshness(braveDays);
  console.log(chalk.dim(`  Window: Brave ${braveDays}d (${freshness}), job boards ${Math.max(2, boardDays)}d\n`));

  const queryResults = useBrave ? await runAllSearches(searchQueries(), onRequest, freshness) : [];
  // Every ATS board Brave surfaced joins the known-company registry; the "known" source polls it in full
  const harvested = await harvestBoards(queryResults.flatMap((q) => q.results.map((r) => r.url)), "brave");
  if (harvested) console.log(chalk.dim(`  ${harvested} new company boards from search results`));

  // Wellfound: no public API and a bot check on its pages, so jobs come from Brave's index of them,
  // then get matched to the company's own posting. A month of results: Brave indexes Wellfound slowly.
  if (useWellfound && process.env.BRAVE_API_KEY) {
    const found = await runAllSearches(WELLFOUND_QUERIES, onRequest, "pm");
    const listings = wellfoundListings(found.flatMap((q) => q.results));
    const unique = [...new Map(listings.map((l) => [l.url, l])).values()];
    const r = await resolveListings(unique, "wellfound");
    console.log(chalk.dim(`  source:wellfound: ${resolvedNote(unique.length, r)}`));
    queryResults.push({ query: "source:wellfound", results: r.jobs });
  }

  // Non-Brave sources: board APIs for YC / freshly-funded / watchlist / known companies, HN, Google Jobs, watched sites
  const sourceResults = await runSources(sources as SourceName[]);
  for (const r of sourceResults) {
    const label = `source:${r.source}`;
    if (r.error) {
      console.log(chalk.red(`  ${label} failed: ${r.error}`));
      continue;
    }
    console.log(chalk.dim(`  ${label}: ${r.note}`));
    queryResults.push({ query: label, results: r.jobs });
  }

  // Flatten raw results
  for (const { query, results } of queryResults) {
    const accepted = results.filter((r) => !isBlocked(r));
    console.log(
      chalk.dim(`  ${query}`) +
        chalk.green(` → ${accepted.length}`) +
        chalk.dim(`/${results.length} kept`)
    );

    stats.queries[query] = {
      raw: results.length,
      accepted: accepted.length,
      unique: 0, // filled in after dedup
    };

    for (const r of results) {
      allRaw.push({ ...r, query });
    }
  }

  stats.rawResults = allRaw.length;

  // Build SearchJob list (pre-dedup)
  const jobsWithQuery: SearchJob[] = [];

  for (const { query, ...rest } of allRaw) {
    if (isBlocked(rest)) continue;
    jobsWithQuery.push({ ...rest, foundByQueries: [query] });
  }

  stats.afterDomainFiltering = jobsWithQuery.length;

  // Deduplicate
  const unique = deduplicate(jobsWithQuery);
  stats.uniqueResults = unique.length;
  stats.requests = totalRequests;

  // Update per-query unique counts
  for (const job of unique) {
    for (const q of job.foundByQueries) {
      if (stats.queries[q]) {
        stats.queries[q].unique++;
      }
    }
  }

  // Write output files
  await Promise.all([
    writeFile(
      `${OUTPUT_DIR}raw.json`,
      JSON.stringify(allRaw, null, 2),
      "utf8"
    ),
    writeFile(
      `${OUTPUT_DIR}jobs.json`,
      JSON.stringify(unique, null, 2),
      "utf8"
    ),
    writeFile(
      `${OUTPUT_DIR}stats.json`,
      JSON.stringify(stats, null, 2),
      "utf8"
    ),
    writeFile(
      LAST_RUN_PATH,
      JSON.stringify({ brave: useBrave ? runAt : lastRun.brave, boards: sources.length ? runAt : lastRun.boards }, null, 2),
      "utf8"
    ),
  ]);

  console.log(chalk.bold.cyan("\n  Summary"));
  console.log(`  Requests made:       ${chalk.white(stats.requests)}`);
  console.log(`  Raw results:         ${chalk.white(stats.rawResults)}`);
  console.log(`  After domain filter: ${chalk.white(stats.afterDomainFiltering)}`);
  console.log(`  Unique jobs:         ${chalk.bold.green(stats.uniqueResults)}`);
  console.log(chalk.dim(`\n  output/raw.json   — ${allRaw.length} entries`));
  console.log(chalk.dim(`  output/jobs.json  — ${unique.length} entries`));
  console.log(chalk.dim(`  output/stats.json — run metadata`));
  console.log(chalk.dim(`\n  Run "npm run verify" to fetch pages and label freshness.\n`));
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
