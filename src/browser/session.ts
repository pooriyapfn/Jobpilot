import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { config } from "../config.ts";

// Headless browser for the prepare batch (your installed Chrome, no extra download).
export const launchHeadless = async (): Promise<Browser> =>
  chromium.launch({ channel: "chrome", headless: true });

const reachable = () => fetch(`${config.cdpUrl}/json/version`).then((r) => r.ok, () => false);

// Starts your job-hunting Chrome (own profile, remote debugging) unless it's already running.
export const ensureChrome = async (): Promise<void> => {
  if (await reachable()) return;
  const port = new URL(config.cdpUrl).port;
  spawn("open", ["-na", "Google Chrome", "--args", `--remote-debugging-port=${port}`, `--user-data-dir=${config.chromeProfile}`], {
    stdio: "ignore",
    detached: true,
  }).unref();
  for (let i = 0; i < 120; i++) { // first launch of a new profile can take a while
    await sleep(500);
    if (await reachable()) return;
  }
  throw new Error(`Chrome didn't open remote debugging on ${config.cdpUrl} within 60s. Is another Chrome using --user-data-dir=${config.chromeProfile} without the debug port? Quit it and retry.`);
};

// Your own Chrome, reused across apply clicks.
let ctx: Promise<BrowserContext> | undefined;

export const userChrome = (): Promise<BrowserContext> => {
  ctx ??= chromium.connectOverCDP(config.cdpUrl).then((b) => {
    b.on("disconnected", () => (ctx = undefined));
    return b.contexts()[0] ?? b.newContext();
  });
  return ctx.catch((e) => {
    ctx = undefined;
    throw new Error(`Chrome not reachable at ${config.cdpUrl} — run \`npm run chrome\` first. (${e.message})`);
  });
};

// CLI entry for `npm run chrome`: open it once to log in to LinkedIn etc.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureChrome().then(() => console.log(`Job Chrome ready (${config.chromeProfile})`));
}
