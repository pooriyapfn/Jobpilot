import { writeFileSync, chmodSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import { config } from "../../config.ts";
import { OUTPUT_DIR } from "./paths.ts";
import { homedir } from "os";

const PROJECT_DIR = config.root;
// Script must live outside ~/Desktop (TCC-protected) so launchd can access it
const SCRIPT_PATH = resolve(homedir(), ".job-searcher-run.sh");
const PLIST_LABEL = "com.job-searcher";
const PLIST_PATH = resolve(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
const LOG_PATH = resolve(OUTPUT_DIR, "run.log");
const NODE_PATH = (() => {
  try {
    return execSync("which node", { encoding: "utf8" }).trim();
  } catch {
    return "/usr/local/bin/node";
  }
})();

function writeScript(): void {
  const nodeBinDir = NODE_PATH.replace(/\/node$/, "");
  const content = `#!/bin/bash
set -e
export PATH="${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"
cd "${PROJECT_DIR}"
npm run search
npm run verify
npm run enrich
`;
  writeFileSync(SCRIPT_PATH, content, { encoding: "utf8" });
  chmodSync(SCRIPT_PATH, 0o755);
  console.log(`Wrote ${SCRIPT_PATH}`);
}

function writePlist(): void {
  const launchAgentsDir = resolve(homedir(), "Library", "LaunchAgents");
  if (!existsSync(launchAgentsDir)) {
    mkdirSync(launchAgentsDir, { recursive: true });
  }

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT_PATH}</string>
  </array>
  <key>StartInterval</key>
  <integer>43200</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_PATH.replace(/\/node$/, "")}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
`;
  writeFileSync(PLIST_PATH, content, { encoding: "utf8" });
  console.log(`Wrote ${PLIST_PATH}`);
}

function loadLaunchd(): void {
  // Unload first if already loaded (ignore errors)
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // not loaded — fine
  }
  execSync(`launchctl load "${PLIST_PATH}"`);
  console.log(`Loaded ${PLIST_LABEL} via launchctl`);
}

function main(): void {
  console.log("Setting up job-searcher scheduler...\n");

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  writeScript();
  writePlist();
  loadLaunchd();

  const nextRun = new Date(Date.now() + 12 * 60 * 60 * 1000);
  console.log(`\nScheduler active. Next run: ${nextRun.toLocaleString()}`);
  console.log(`\nUseful commands:`);
  console.log(`  Manual trigger:  launchctl start ${PLIST_LABEL}`);
  console.log(`  Check status:    launchctl list | grep job-searcher`);
  console.log(`  View logs:       tail -f ${LOG_PATH}`);
  console.log(`  Unload:          launchctl unload "${PLIST_PATH}"`);
}

main();
