// Review dashboard: http://localhost:4000
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SaveAnswersRequest, SetStatusRequest, type ApplicationSummary, type ErrorResponse, type OkResponse } from "@jobpilot/contracts";
import { ZodError } from "zod";
import { config } from "../config.ts";
import { getApp, listApps, saveApp, setStatus } from "../db.ts";
import { applyJob } from "../agent/apply.ts";
import { remember } from "../agent/memory.ts";
import { page } from "./page.ts";

const json = (res: ServerResponse, body: unknown, code = 200) =>
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

const readBody = async (req: IncomingMessage) => {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
};

// Without the JD text — the table doesn't need it.
const summaries = (): ApplicationSummary[] => listApps().map(({ jd: _jd, ...app }) => app);

const ok = (res: ServerResponse, ok = true) => json(res, { ok } satisfies OkResponse);

// You edited answers in the dashboard: save them and remember them.
const saveAnswers = (id: string, edits: Record<string, string>) => {
  const app = getApp(id);
  if (!app) return false;
  for (const f of app.fields) {
    const value = edits[f.id];
    if (value === undefined || value === app.answers[f.id]?.value) continue;
    app.answers[f.id] = { value, confident: true };
    remember(f.label, value);
  }
  saveApp(app);
  return true;
};

const routes: Record<string, (req: IncomingMessage, res: ServerResponse, id: string) => unknown> = {
  "GET /": (_q, res) => res.writeHead(200, { "content-type": "text/html" }).end(page),
  "GET /api/apps": (_q, res) => json(res, summaries()),
  "POST /api/apply": (_q, res, id) => {
    applyJob(id).catch((e) => setStatus(id, "error", String(e.message ?? e)));
    ok(res);
  },
  "POST /api/answers": async (req, res, id) => ok(res, saveAnswers(id, SaveAnswersRequest.parse(await readBody(req)).answers)),
  "POST /api/status": async (req, res, id) => {
    setStatus(id, SetStatusRequest.parse(await readBody(req)).status);
    ok(res);
  },
  "GET /resume": (_q, res, id) => {
    const path = getApp(id)?.resumePath;
    if (!path) return json(res, { error: "no resume" }, 404);
    res.writeHead(200, { "content-disposition": `attachment; filename="resume-${id}.docx"` });
    createReadStream(path).pipe(res);
  },
};

createServer(async (req, res) => {
  const [, base = "", sub = "", id = ""] = (req.url ?? "/").split("?")[0]!.split("/");
  const path = base === "api" ? `/api/${sub}` : `/${base}`;
  const handler = routes[`${req.method} ${path}`];
  try {
    if (handler) await handler(req, res, base === "api" ? id : sub);
    else json(res, { error: "not found" } satisfies ErrorResponse, 404);
  } catch (e) {
    json(res, { error: String(e) } satisfies ErrorResponse, e instanceof ZodError ? 400 : 500);
  }
}).listen(config.port, () => console.log(`Dashboard → http://localhost:${config.port}`));
