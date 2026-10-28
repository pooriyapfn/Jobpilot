import chalk from "chalk";
import { mkdir, writeFile } from "fs/promises";
import { SEARCH_QUERIES } from "./config.ts";
import { isExcluded, isExcludedATSCompany, deduplicate } from "./filters.ts";
import { runAllSearches } from "./search.ts";
import { ALL_SOURCES, runSources, type SourceName } from "./sources/index.ts";
import type { SearchJob, RunStats } from "./types.ts";
import { OUTPUT_DIR } from "./paths.ts";


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

  // --only=yc,hn,funding,watchlist,brave  (default: everything)
  const onlyArg = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  const only = onlyArg ? new Set(onlyArg.split(",")) : null;
  const useBrave = !only || only.has("brave");
  const sources = ALL_SOURCES.filter((s) => !only || only.has(s));

  const queryResults = useBrave ? await runAllSearches(SEARCH_QUERIES, onRequest) : [];

  // Non-Brave sources: board APIs for YC / freshly-funded / watchlist companies, HN hiring
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
    const accepted = results.filter((r) => !isExcluded(r.url) && !isExcludedATSCompany(r.url));
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
    if (isExcluded(rest.url) || isExcludedATSCompany(rest.url)) continue;
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
