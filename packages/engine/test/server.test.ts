import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineInfo, JobEvent, JobInfo, KnowledgeDocument, KnowledgeFile } from "@jobpilot/contracts";
import { z } from "zod";

// config reads JOBPILOT_HOME at import time, so set it first and import the server afterwards.
const home = mkdtempSync(join(tmpdir(), "jobpilot-test-"));
process.env.JOBPILOT_HOME = home;
const { startServer } = await import("../src/server/server.ts");

const node = (code: string) => ({ command: process.execPath, args: ["-e", code] });
const fake = {
  search: () => node("console.log('line one'); console.error('oops'); process.stdout.write('partial')"),
  verify: () => node("process.exit(3)"),
  enrich: () => node("setInterval(() => {}, 1000)"), // runs until cancelled
  prepare: ({ limit }: { limit?: number }) => node(`console.log('limit=${limit}')`),
  fill: () => node("0"),
  chrome: () => node("0"),
};

const TOKEN = "test-token";
let server: Awaited<ReturnType<typeof startServer>>;
let base = "";
const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = TOKEN, ...rest } = init;
  return fetch(base + path, { ...rest, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...rest.headers } });
};
const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

const waitDone = async (id: string) => {
  for (let i = 0; i < 100; i++) {
    const info = JobInfo.parse(await (await call(`/api/jobs/${id}`)).json());
    if (info.status !== "running") return info;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not finish");
};

before(async () => {
  server = await startServer({ token: TOKEN, tasks: fake });
  base = `http://127.0.0.1:${server.port}`;
});
after(() => server.close());

describe("auth", () => {
  it("rejects missing and wrong tokens, accepts the right one", async () => {
    assert.equal((await call("/api/info", { token: null })).status, 401);
    assert.equal((await call("/api/info", { token: "nope" })).status, 401);
    assert.equal((await call("/api/info")).status, 200);
  });
  it("404 for unknown paths, 405 for wrong method", async () => {
    assert.equal((await call("/api/nothing")).status, 404);
    assert.equal((await call("/api/info", { method: "DELETE" })).status, 405);
  });
  it("serves no dev page when a token is set", async () => {
    assert.equal((await call("/", { token: null })).status, 404);
  });
});

describe("info + data routes", () => {
  it("GET /api/info matches the contract", async () => {
    const info = EngineInfo.parse(await (await call("/api/info")).json());
    assert.equal(info.home, home);
  });
  it("lists no apps / eligible jobs on a fresh home", async () => {
    assert.deepEqual(await (await call("/api/apps")).json(), []);
    assert.deepEqual(await (await call("/api/eligible-jobs")).json(), []);
  });
  it("validates bodies (400) and unknown applications (404)", async () => {
    assert.equal((await post("/api/status/x", { status: "bogus" })).status, 400);
    assert.equal((await post("/api/answers/x", {})).status, 400);
    assert.equal((await post("/api/apply/x", {})).status, 404);
  });
});

describe("jobs", () => {
  it("runs a task, streams its lines as SSE, and reports success", async () => {
    const started = JobInfo.parse(await (await post("/api/jobs", { task: "search" })).json());
    assert.equal(started.status, "running");
    const res = await call(`/api/jobs/${started.id}/events`);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text(); // stream ends when the job does
    const events = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JobEvent.parse(JSON.parse(m[1]!)));
    const logs = events.filter((e) => e.kind === "log").map((e) => `${e.stream}:${e.text}`);
    assert.deepEqual(logs.sort(), ["stderr:oops", "stdout:line one", "stdout:partial"]);
    assert.deepEqual(events.filter((e) => e.kind === "status").map((e) => e.status), ["running", "succeeded"]);
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
    assert.equal((await waitDone(started.id)).exitCode, 0);
  });
  it("resumes after Last-Event-ID", async () => {
    const [job] = JobInfo.array().parse(await (await call("/api/jobs")).json());
    const text = await (await call(`/api/jobs/${job!.id}/events`, { headers: { "last-event-id": "3" } })).text();
    const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.ok(seqs.length > 0 && seqs.every((s) => s > 3));
  });
  it("marks a non-zero exit as failed with its exit code", async () => {
    const started = JobInfo.parse(await (await post("/api/jobs", { task: "verify" })).json());
    const done = await waitDone(started.id);
    assert.equal(done.status, "failed");
    assert.equal(done.exitCode, 3);
  });
  it("passes limit through, rejects bad input", async () => {
    const started = JobInfo.parse(await (await post("/api/jobs", { task: "prepare", limit: 7 })).json());
    const text = await (await call(`/api/jobs/${started.id}/events`)).text();
    assert.match(text, /limit=7/);
    assert.equal((await post("/api/jobs", { task: "rm -rf" })).status, 400);
    assert.equal((await post("/api/jobs", { task: "prepare", limit: 0 })).status, 400);
  });
  it("allows one running job per task and can cancel it", async () => {
    const first = JobInfo.parse(await (await post("/api/jobs", { task: "enrich" })).json());
    assert.equal((await post("/api/jobs", { task: "enrich" })).status, 409);
    await call(`/api/jobs/${first.id}/cancel`, { method: "POST" });
    assert.equal((await waitDone(first.id)).status, "cancelled");
    JobInfo.parse(await (await post("/api/jobs", { task: "enrich" })).json()); // free again
    server.runner.shutdown();
  });
  it("404 for unknown job", async () => {
    assert.equal((await call("/api/jobs/nope")).status, 404);
    assert.equal((await call("/api/jobs/nope/events")).status, 404);
  });
});

describe("knowledge", () => {
  const put = (path: string, content: string) =>
    call(`/api/knowledge/file?path=${encodeURIComponent(path)}`, { method: "PUT", body: JSON.stringify({ content }) });
  const get = (path: string) => call(`/api/knowledge/file?path=${encodeURIComponent(path)}`);

  it("creates, reads, lists and updates files", async () => {
    assert.equal((await put("profile.md", "# Me")).status, 200);
    assert.equal((await put("resume/main_resume.md", "cv v1")).status, 200);
    assert.equal((await put("resume/main_resume.md", "cv v2")).status, 200);
    mkdirSync(join(home, "knowledge"), { recursive: true });
    writeFileSync(join(home, "knowledge", "style.example.md"), "template");
    const doc = KnowledgeDocument.parse(await (await get("resume/main_resume.md")).json());
    assert.equal(doc.content, "cv v2");
    const files = KnowledgeFile.array().parse(await (await call("/api/knowledge")).json());
    assert.deepEqual(files.map((f) => f.path), ["profile.md", "resume/main_resume.md"]); // templates hidden
  });
  it("rejects traversal, dotfiles, other extensions and symlink escapes", async () => {
    for (const bad of ["../secret.md", "/etc/passwd.md", "a/../../b.md", ".env.md", "x.sh", "notes/.hidden.md", ""]) {
      assert.equal((await put(bad, "x")).status, 400, bad);
      assert.equal((await get(bad)).status, 400, bad);
    }
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    symlinkSync(outside, join(home, "knowledge", "link"));
    assert.equal((await put("link/evil.md", "x")).status, 400);
  });
  it("404 for a missing file, 413 for oversized content", async () => {
    assert.equal((await get("nope.md")).status, 404);
    assert.equal((await put("big.md", "x".repeat(1024 * 1024 + 1))).status, 413);
  });
});

describe("dev mode (no token)", () => {
  it("serves the dev dashboard page and open API", async () => {
    const dev = await startServer({ tasks: fake });
    try {
      const page = await fetch(`http://127.0.0.1:${dev.port}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<html/i);
      assert.equal((await fetch(`http://127.0.0.1:${dev.port}/api/apps`)).status, 200);
    } finally {
      await dev.close();
    }
  });
});
