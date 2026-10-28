// zod schemas → schema/*.json → apps/macos/.../Contracts.swift
// `--check` writes nothing and fails if the committed files are out of date.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { API_VERSION, registry } from "../src/index.ts";
import { generateSwift } from "./swift.ts";

const pkg = resolve(fileURLToPath(import.meta.url), "../..");
const schemaDir = resolve(pkg, "schema");
const swiftFile = resolve(pkg, "../../apps/macos/JobPilot/Contracts/Generated/Contracts.swift");

export function build() {
  const { schemas } = z.toJSONSchema(registry, { target: "draft-7", uri: (id) => `${id}.schema.json` });
  const files = new Map<string, string>();
  for (const [id, schema] of Object.entries(schemas)) files.set(resolve(schemaDir, `${id}.schema.json`), JSON.stringify(schema, null, 2) + "\n");
  files.set(swiftFile, generateSwift(schemas as never, API_VERSION));
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = build();
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);
  if (process.argv.includes("--check")) {
    const stale = [...files].filter(([p, c]) => read(p) !== c).map(([p]) => p);
    const extra = existsSync(schemaDir) ? readdirSync(schemaDir).map((f) => resolve(schemaDir, f)).filter((p) => !files.has(p)) : [];
    if (stale.length || extra.length) {
      console.error(`Contracts out of date — run \`npm run contracts\`:\n${[...stale, ...extra].map((p) => `  ${p}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`Contracts up to date (${files.size} files)`);
  } else {
    mkdirSync(schemaDir, { recursive: true });
    for (const f of readdirSync(schemaDir)) rmSync(resolve(schemaDir, f)); // drop schemas that no longer exist
    for (const [p, c] of files) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c);
      console.log(`wrote ${p.replace(resolve(pkg, "../..") + "/", "")}`);
    }
  }
}
