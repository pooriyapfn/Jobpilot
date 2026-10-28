import { unlinkSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import { homedir } from "os";

const PLIST_LABEL = "com.job-searcher";
const PLIST_PATH = resolve(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
const SCRIPT_PATH = resolve(homedir(), ".job-searcher-run.sh");

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
    console.log(`Deleted ${path}`);
  } catch {
    // missing — fine
  }
}

function main(): void {
  // 1. Unload from launchd (ignore error if not loaded)
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: "ignore" });
    console.log(`Unloaded ${PLIST_LABEL}`);
  } catch {
    // not loaded — fine
  }

  // 2. Delete files
  tryUnlink(PLIST_PATH);
  tryUnlink(SCRIPT_PATH);

  console.log("Scheduler removed. Auto-run is disabled.");
}

main();
