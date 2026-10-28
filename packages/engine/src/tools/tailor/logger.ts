import chalk from "chalk";

const fmtSeconds = (ms: number) => chalk.dim(`${(ms / 1000).toFixed(1)}s`);
const fmtCost = (cost: number) => chalk.dim(`$${cost.toFixed(4)}`);

export const step = (message: string) =>
  console.log(chalk.cyan("→") + " " + chalk.bold(message));

export const done = (message: string, opts: { ms?: number; cost?: number } = {}) => {
  const parts = [
    opts.ms != null ? fmtSeconds(opts.ms) : undefined,
    opts.cost != null ? fmtCost(opts.cost) : undefined,
  ].filter(Boolean);
  const suffix = parts.length ? ` (${parts.join(", ")})` : "";
  console.log(chalk.green("  ✓") + " " + message + suffix);
};

export const warn = (message: string) =>
  console.log(chalk.yellow("  !") + " " + chalk.yellow(message));

export const fail = (message: string) =>
  console.error(chalk.red("✗") + " " + chalk.red(message));

const fitColor = (line: string): string => {
  if (line.includes("STRONG_FIT")) return chalk.bgGreen.black.bold(` STRONG FIT `);
  if (line.includes("POSSIBLE_FIT")) return chalk.bgYellow.black.bold(` POSSIBLE FIT `);
  if (line.includes("SKIP")) return chalk.bgRed.white.bold(` SKIP `);
  if (line.includes("PASSED")) return chalk.green(line);
  if (line.includes("COMPLIANCE VIOLATIONS") || line.includes("⚠")) return chalk.red.bold(line);
  if (line.startsWith("    ")) return chalk.red(line); // violation detail lines
  if (line.includes("ATS score")) return chalk.cyan(line);
  if (line.includes("Total cost")) return chalk.dim(line);
  return line;
};

export const summary = (lines: string[]) => {
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const width = Math.max(...plain.map((l) => l.length), 40);
  const bar = chalk.dim("─".repeat(width));
  console.log(`\n${bar}`);
  for (const line of lines) {
    // Replace fit classification tokens inline if they appear mid-line
    const colored = line
      .replace("STRONG_FIT", chalk.bgGreen.black.bold(" STRONG FIT "))
      .replace("POSSIBLE_FIT", chalk.bgYellow.black.bold(" POSSIBLE FIT "))
      .replace(/\bSKIP\b/, chalk.bgRed.white.bold(" SKIP "));
    console.log(fitColor(colored));
  }
  console.log(`${bar}\n`);
};
