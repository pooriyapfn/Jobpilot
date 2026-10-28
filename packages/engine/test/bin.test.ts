import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { API_VERSION, EngineReady } from "@jobpilot/contracts";

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

describe("engine serve (real process)", () => {
  it("prints one ready line, serves with its token, and exits when stdin closes", async () => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", bin, "serve", "--exit-on-stdin-close"], {
      env: { ...process.env, JOBPILOT_HOME: mkdtempSync(join(tmpdir(), "jobpilot-bin-")), JOBPILOT_TOKEN: "abc" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const exited = new Promise<number | null>((r) => child.on("exit", r));
    try {
      const first = (await createInterface({ input: child.stdout })[Symbol.asyncIterator]().next()).value as string;
      const ready = EngineReady.parse(JSON.parse(first));
      assert.equal(ready.token, "abc");
      assert.equal(ready.apiVersion, API_VERSION);
      const res = await fetch(`http://127.0.0.1:${ready.port}/api/info`, { headers: { authorization: "Bearer abc" } });
      assert.equal(res.status, 200);
      child.stdin.end();
      assert.equal(await exited, 0);
    } finally {
      child.kill();
    }
  });

  it("usage error without a command", async () => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", bin, "bogus"], { stdio: "ignore" });
    assert.equal(await new Promise((r) => child.on("exit", r)), 2);
  });
});
