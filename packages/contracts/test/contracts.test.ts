import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Application, SaveAnswersRequest, SetStatusRequest, ApplicationSummary } from "../src/index.ts";
import { build } from "../scripts/generate.ts";
import { existsSync, readFileSync } from "node:fs";
import { generateSwift } from "../scripts/swift.ts";

const app = {
  id: "a1", url: "https://x.test/job", applyUrl: "https://x.test/apply", title: "Engineer", company: "Acme", jd: "...",
  status: "skip-fit", fields: [{ id: "email", selector: "#email", label: "Email", type: "text", required: true }],
  answers: { email: { value: "jane@example.com", confident: true } }, updatedAt: "2026-10-28T00:00:00.000Z",
};

describe("zod contracts", () => {
  it("accepts a valid Application and rejects an unknown status", () => {
    assert.ok(Application.safeParse(app).success);
    assert.ok(!Application.safeParse({ ...app, status: "nope" }).success);
  });
  it("ApplicationSummary drops jd", () => {
    assert.ok(!("jd" in ApplicationSummary.parse(app)));
  });
  it("request bodies are validated", () => {
    assert.ok(SaveAnswersRequest.safeParse({ answers: { a: "b" } }).success);
    assert.ok(!SaveAnswersRequest.safeParse({}).success);
    assert.ok(!SetStatusRequest.safeParse({ status: "bogus" }).success);
  });
});

describe("generated files", () => {
  it("committed schema/*.json and Contracts.swift are up to date (run `npm run contracts`)", () => {
    for (const [path, content] of build()) {
      assert.ok(existsSync(path), `missing ${path}`);
      assert.equal(readFileSync(path, "utf8"), content, `stale ${path}`);
    }
  });
  it("swift generator rejects unsupported schema features", () => {
    assert.throws(() => generateSwift({ X: { type: "object", properties: { a: { anyOf: [] } } } as never }), /unsupported/);
    assert.throws(() => generateSwift({ X: { type: "object", properties: { a: { type: "object", properties: {} } } } as never }), /inline object/);
  });
});
