import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { EngineInfo, JobEvent, JobInfo, JobListing, JobListingDetail, KnowledgeDocument, KnowledgeFile } from "@jobpilot/contracts";
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

describe("application detail + answer confirmation", () => {
  const app = {
    id: "app1", url: "https://jobs.example.com/1", applyUrl: "https://jobs.example.com/1/apply", title: "Engineer", company: "Acme",
    jd: "Build things.", status: "prepared" as const, updatedAt: "2026-10-28T12:00:00.000Z",
    fields: [
      { id: "how", selector: "#how", label: "How did you hear?", type: "text" as const, required: false },
      { id: "blank", selector: "#blank", label: "Anything else?", type: "text" as const, required: false },
    ],
    answers: { how: { value: "LinkedIn", confident: false }, blank: { value: "", confident: false } },
  };
  before(async () => (await import("../src/db.ts")).saveApp(app));

  it("GET /api/apps/:id returns the full application, including the job description", async () => {
    const got = await (await call("/api/apps/app1")).json();
    assert.equal(got.jd, "Build things.");
    assert.equal((await call("/api/apps/nope")).status, 404);
    const [summary] = await (await call("/api/apps")).json();
    assert.equal(summary.jd, undefined); // the list stays light
  });
  it("an unchanged, unsure answer is confirmed; an unchanged empty one is not", async () => {
    await post("/api/answers/app1", { answers: { how: "LinkedIn", blank: "" } });
    const got = await (await call("/api/apps/app1")).json();
    assert.deepEqual(got.answers.how, { value: "LinkedIn", confident: true });
    assert.deepEqual(got.answers.blank, { value: "", confident: false });
  });
});

describe("jobs repository (listings)", () => {
  const dir = join(home, "data/job-search");
  const feed = (title: string, url: string, extra = {}) => ({
    title, url, company: "Acme", description: `${title} description`, extraSnippets: [], datePosted: "2026-10-20T00:00:00Z", ...extra,
  });
  const list = async () => JobListing.array().parse(await (await call("/api/listings")).json());
  const byTitle = async (t: string) => (await list()).find((l) => l.title === t)!;
  const mkApp = async (id: string, extra = {}) => {
    const { saveApp } = await import("../src/db.ts");
    saveApp({ id, url: `https://x.test/${id}`, applyUrl: "", title: id, company: "Co", jd: "jd", status: "prepared", fields: [], answers: {}, updatedAt: "", ...extra });
  };

  before(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "eligible-jobs.json"), JSON.stringify([
      feed("Engineer A", "https://x.test/a", { description: "&lt;div&gt;&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;We build &amp;amp; ship.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;&lt;style&gt;.x{color:red}&lt;/style&gt;&lt;/div&gt;" }),
      feed("Engineer B", "https://x.test/b", { datePosted: "garbage" }),
    ]));
    writeFileSync(join(dir, "uncertain.json"), JSON.stringify([feed("Engineer C", "https://x.test/c", { workMode: "hybrid" })]));
  });

  it("collects search results with posted/added dates, an eligibility and a reason", async () => {
    const a = await byTitle("Engineer A");
    assert.equal(a.eligibility, "eligible");
    assert.equal(a.eligibilitySource, "search");
    assert.equal(a.datePosted, "2026-10-20T00:00:00.000Z");
    assert.equal((await byTitle("Engineer B")).datePosted, undefined); // an unparseable date is dropped, not invented
    const c = await byTitle("Engineer C");
    assert.equal(c.eligibility, "review");
    assert.match(c.eligibilityReason ?? "", /hybrid/);
    for (const l of await list()) assert.ok(Date.parse(l.addedAt) > 0 && Date.parse(l.updatedAt) > 0 && l.snippet);
  });
  it("never shows HTML: previews and the full text are plain text with light markers", async () => {
    const a = await byTitle("Engineer A");
    assert.equal(a.snippet, "About We build & ship. One");
    const detail = JobListingDetail.parse(await (await call(`/api/listings/${a.id}`)).json());
    assert.equal(detail.description, "## About\n\nWe build & ship.\n\n- One");
    assert.doesNotMatch(JSON.stringify(await list()), /<\/?(div|span|h2|p|style)|&lt;|&amp;/);
    assert.equal((await call("/api/listings/nope")).status, 404);
  });
  it("lists applications that predate the repository; a submitted one has an applied date", async () => {
    await mkApp("old1", { status: "submitted", updatedAt: "2026-10-01T00:00:00.000Z" });
    const { saveApp, getApp } = await import("../src/db.ts");
    saveApp(getApp("old1")!); // keeps updatedAt realistic
    const old = (await list()).find((l) => l.id === "old1")!;
    assert.equal(old.eligibility, "not-evaluated"); // applying says nothing about eligibility
    assert.equal(old.applicationStatus, "submitted");
    assert.ok(old.appliedAt);
    assert.equal(old.resumeReady, false);
  });
  it("eligibility, applied and note are independent", async () => {
    await mkApp("p1");
    await list();
    assert.equal((await post("/api/listings/p1/eligibility", { eligibility: "not-eligible" })).status, 200);
    let l = (await list()).find((x) => x.id === "p1")!;
    assert.equal(l.eligibility, "not-eligible");
    assert.equal(l.eligibilitySource, "you");
    assert.equal(l.appliedAt, undefined);
    assert.equal((await import("../src/db.ts")).getApp("p1")!.status, "skipped"); // left the review queue

    assert.equal((await post("/api/listings/p1/note", { note: "Recruiter is Sam" })).status, 200);
    assert.equal((await post("/api/listings/p1/applied", {})).status, 200);
    l = (await list()).find((x) => x.id === "p1")!;
    assert.equal(l.eligibility, "not-eligible"); // unchanged by applying
    assert.equal(l.userNote, "Recruiter is Sam"); // unchanged by applying
    assert.ok(l.appliedAt);
    assert.equal(l.applicationStatus, "submitted");

    await post("/api/listings/p1/eligibility", { eligibility: "eligible" });
    l = (await list()).find((x) => x.id === "p1")!;
    assert.equal(l.eligibility, "eligible");
    assert.ok(l.appliedAt && l.userNote); // still there
    assert.equal((await post("/api/listings/p1/eligibility", { eligibility: "bogus" })).status, 400);
    assert.equal((await post("/api/listings/nope/eligibility", { eligibility: "eligible" })).status, 404);
  });
  it("a note you wrote, and a state you chose, survive the next search", async () => {
    const b = await byTitle("Engineer B");
    await post(`/api/listings/${b.id}/eligibility`, { eligibility: "not-eligible" });
    await post(`/api/listings/${b.id}/note`, { note: "  keep me  " });
    writeFileSync(join(dir, "eligible-jobs.json"), JSON.stringify([feed("Engineer B", "https://x.test/b", { description: "changed" })]) + " ");
    const again = (await list()).find((l) => l.id === b.id)!;
    assert.equal(again.eligibility, "not-eligible");
    assert.equal(again.userNote, "  keep me  ");
    await post(`/api/listings/${b.id}/note`, { note: "   " });
    assert.equal((await list()).find((l) => l.id === b.id)!.userNote, undefined); // blank clears
    assert.equal((await post(`/api/listings/${b.id}/note`, { note: "x".repeat(10_001) })).status, 413);
  });
  it("reports a resume as ready only when the file exists, and match separately from eligibility", async () => {
    const resume = join(home, "data/resumes/r1.docx");
    mkdirSync(join(home, "data/resumes"), { recursive: true });
    writeFileSync(resume, "docx");
    await mkApp("r1", { resumePath: resume, fit: "POSSIBLE_FIT" });
    await mkApp("r2", { resumePath: join(home, "data/resumes/gone.docx") });
    await mkApp("r3", { status: "skip-fit", note: "Needs 10y of Rust" });
    const got = await list();
    assert.equal(got.find((l) => l.id === "r1")!.resumeReady, true);
    assert.equal(got.find((l) => l.id === "r1")!.matchFit, "POSSIBLE_FIT");
    assert.equal(got.find((l) => l.id === "r2")!.resumeReady, false);
    const r3 = got.find((l) => l.id === "r3")!;
    assert.equal(r3.matchFit, "SKIP");
    assert.equal(r3.eligibility, "not-evaluated"); // "not a fit" never turns into "not eligible"
    const detail = JobListingDetail.parse(await (await call("/api/listings/r3")).json());
    assert.equal(detail.matchNotes, "Needs 10y of Rust");
  });
  it("remove keeps the application by default; 'everything' deletes it and its resume files", async () => {
    const { getApp } = await import("../src/db.ts");
    assert.equal((await call("/api/listings/r2", { method: "DELETE" })).status, 200);
    assert.ok(getApp("r2")); // history kept
    assert.ok(!(await list()).some((l) => l.id === "r2"));
    assert.equal((await call("/api/listings/r2", { method: "DELETE" })).status, 404);

    assert.equal((await call("/api/listings/r1?scope=everything", { method: "DELETE" })).status, 200);
    assert.equal(getApp("r1"), undefined);
    assert.ok(!existsSync(join(home, "data/resumes/r1.docx")));
    assert.equal((await call("/api/listings/p1?scope=bogus", { method: "DELETE" })).status, 400);

    const a = await byTitle("Engineer A");
    await call(`/api/listings/${a.id}`, { method: "DELETE" });
    writeFileSync(join(dir, "eligible-jobs.json"), JSON.stringify([feed("Engineer A", "https://x.test/a")]) + "  ");
    assert.ok(!(await list()).some((l) => l.id === a.id)); // a later search doesn't bring it back
  });
  it("guards: regenerate needs an application; unknown jobs 404", async () => {
    const c = await byTitle("Engineer C");
    assert.equal((await post(`/api/listings/${c.id}/regenerate-resume`, {})).status, 409);
    assert.equal((await post("/api/listings/nope/prepare", {})).status, 404);
    assert.equal((await post("/api/listings/nope/assess", {})).status, 404);
  });
  it("keeps the posting link and the application link; either one marks a duplicate", async () => {
    const { setApplyLink, Conflict } = await import("../src/listings.ts");
    const b = await byTitle("Engineer B");
    const c = await byTitle("Engineer C");
    assert.equal(setApplyLink(b.id, "  https://boards.test/acme/jobs/42/#form "), "https://boards.test/acme/jobs/42/");
    const saved = (await list()).find((l) => l.id === b.id)!;
    assert.equal(saved.url, "https://x.test/b"); // the original stays
    assert.equal(saved.applyUrl, "https://boards.test/acme/jobs/42/");
    // another job can't claim the same page, with or without a trailing slash, nor the original posting link
    assert.throws(() => setApplyLink(c.id, "https://boards.test/acme/jobs/42"), Conflict);
    assert.throws(() => setApplyLink(c.id, "https://x.test/b"), Conflict);
    assert.throws(() => setApplyLink(c.id, "file:///etc/passwd"), TypeError);
    assert.equal(setApplyLink("nope", "https://boards.test/other"), undefined);
    // a search that later finds the application link is the same job, not a new one
    const before = (await list()).length;
    writeFileSync(join(dir, "eligible-jobs.json"), JSON.stringify([feed("Engineer B", "https://x.test/b"), feed("Engineer B (board)", "https://boards.test/acme/jobs/42")]));
    assert.equal((await list()).length, before);
    // the same over HTTP
    assert.equal((await post(`/api/listings/${c.id}/apply-link`, { url: "https://boards.test/acme/jobs/42" })).status, 409);
    assert.equal((await post(`/api/listings/${c.id}/apply-link`, { url: "nope" })).status, 400);
    assert.equal((await post("/api/listings/nope/apply-link", { url: "https://boards.test/z" })).status, 404);
    // pasting the application link as a new job finds the existing one
    const again = JobListing.parse(await (await post("/api/listings", { url: "https://boards.test/acme/jobs/42" })).json());
    assert.equal(again.id, b.id);
    // clearing removes the link; the original stays
    assert.equal((await post(`/api/listings/${b.id}/apply-link`, { url: "" })).status, 200);
    assert.equal((await list()).find((l) => l.id === b.id)!.applyUrl, undefined);
  });
  it("adds a pasted link: reads title, company and date; same link twice is one job", async () => {
    const page = createServer((_, res) =>
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<html><head><title>x</title><script type="application/ld+json">${JSON.stringify({
          "@type": "JobPosting", title: "Platform Engineer", datePosted: "2026-10-30", description: "<p>Run the <b>platform</b>.</p>",
          hiringOrganization: { name: "Globex" }, jobLocationType: "TELECOMMUTE",
        })}</script></head><body><h1>Platform Engineer</h1></body></html>`,
      ),
    );
    await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/jobs/1#apply`;
      const added = JobListing.parse(await (await post("/api/listings", { url })).json());
      assert.equal(added.title, "Platform Engineer");
      assert.equal(added.company, "Globex");
      assert.equal(added.datePosted, "2026-10-30T00:00:00.000Z");
      assert.equal(added.snippet, "Run the platform.");
      assert.ok(["eligible", "review", "not-eligible"].includes(added.eligibility));
      assert.ok(added.eligibilityReason);
      const again = JobListing.parse(await (await post("/api/listings", { url })).json());
      assert.equal(again.id, added.id);
      assert.equal((await list()).filter((l) => l.id === added.id).length, 1);
    } finally {
      page.close();
    }
  });
  it("rejects non-links; a page it can't read is kept as not evaluated, with a title from the URL", async () => {
    assert.equal((await post("/api/listings", { url: "not a url" })).status, 400);
    assert.equal((await post("/api/listings", { url: "file:///etc/passwd" })).status, 400);
    const dead = JobListing.parse(await (await post("/api/listings", { url: "http://127.0.0.1:1/jobs/senior-dev" })).json());
    assert.equal(dead.eligibility, "not-evaluated");
    assert.equal(dead.title, "senior dev");
    assert.match(dead.eligibilityReason ?? "", /Couldn't read/);
    assert.equal(dead.datePosted, undefined);
  });
  it("migrates a v1 table (mixed state column) without losing anything", () => {
    const dbFile = join(home, "legacy.db");
    const legacy = new DatabaseSync(dbFile);
    legacy.exec(`CREATE TABLE applications (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE listings (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, company TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        date_posted TEXT, added_at TEXT NOT NULL, state TEXT NOT NULL, state_source TEXT NOT NULL DEFAULT 'auto', location TEXT, note TEXT, deleted_at TEXT);`);
    const ins = legacy.prepare("INSERT INTO listings (id, url, title, company, added_at, state, state_source, note) VALUES (?, ?, ?, 'Co', '2026-10-01T00:00:00.000Z', ?, ?, ?)");
    ins.run("n", "https://l.test/n", "New one", "new", "auto", "unreadable");
    ins.run("e", "https://l.test/e", "Eligible one", "eligible", "user", null);
    ins.run("v", "https://l.test/v", "Review one", "review", "auto", "hybrid");
    ins.run("x", "https://l.test/x", "No one", "not-eligible", "user", null);
    ins.run("a", "https://l.test/a", "Applied one", "applied", "auto", null);
    legacy.close();
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "-e",
      `const { db } = await import(${JSON.stringify(new URL("../src/db.ts", import.meta.url).href)});
       console.log(JSON.stringify(db.prepare("SELECT id, eligibility, eligibility_source, eligibility_reason, applied_at IS NOT NULL AS applied FROM listings ORDER BY id").all()));`],
      { env: { ...process.env, APPLY_DB: dbFile }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), [
      { id: "a", eligibility: "not-evaluated", eligibility_source: null, eligibility_reason: null, applied: 1 },
      { id: "e", eligibility: "eligible", eligibility_source: "you", eligibility_reason: null, applied: 0 },
      { id: "n", eligibility: "not-evaluated", eligibility_source: null, eligibility_reason: "unreadable", applied: 0 },
      { id: "v", eligibility: "review", eligibility_source: "search", eligibility_reason: "hybrid", applied: 0 },
      { id: "x", eligibility: "not-eligible", eligibility_source: "you", eligibility_reason: null, applied: 0 },
    ]);
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
