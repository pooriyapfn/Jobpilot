// Engine entry point:  engine serve [--port N] [--exit-on-stdin-close]
//
// Starts the HTTP API on 127.0.0.1 and prints ONE line on stdout:
//   {"port":51234,"token":"…","apiVersion":1}
// Everything else the engine logs goes to stderr. Token: $JOBPILOT_TOKEN if set, else random.
import { randomBytes } from "node:crypto";
import { API_VERSION, EngineReady } from "@jobpilot/contracts";
import { startServer } from "./server/server.ts";

const [command, ...args] = process.argv.slice(2);

if (command !== "serve") {
  console.error("usage: engine serve [--port N] [--exit-on-stdin-close]");
  process.exit(command ? 2 : 0);
}

console.log = console.error; // stdout is reserved for the ready line

const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const port = Number(flag("--port") ?? process.env.JOBPILOT_PORT ?? 0);
const token = process.env.JOBPILOT_TOKEN || randomBytes(32).toString("hex");

const server = await startServer({ port, token });
process.stdout.write(JSON.stringify(EngineReady.parse({ port: server.port, token, apiVersion: API_VERSION })) + "\n");

const shutdown = () => server.close().finally(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (args.includes("--exit-on-stdin-close")) {
  // The app owns our stdin pipe: when it exits or crashes, so do we.
  process.stdin.resume();
  process.stdin.on("end", shutdown);
}
