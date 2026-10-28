import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ErrorResponse } from "@jobpilot/contracts";
import { ZodError } from "zod";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<unknown>;
};

// Return a value → sent as JSON. Return undefined after writing to `res` yourself (SSE, files).
export type Route = {
  method: string;
  pattern: string; // "/api/jobs/:id/events"
  auth?: false; // default: token required whenever the server has one
  handler: (ctx: Ctx) => unknown | Promise<unknown>;
};

const MAX_BODY = 2 * 1024 * 1024;

export const json = (res: ServerResponse, body: unknown, code = 200) =>
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
};

const compile = (pattern: string) => {
  const names: string[] = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)")) + "$");
  return { re, names };
};

const authorized = (req: IncomingMessage, token: string) => {
  const given = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && timingSafeEqual(given, want);
};

const errorMessage = (e: unknown): { status: number; message: string } => {
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  if (e instanceof ZodError) return { status: 400, message: e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") };
  return { status: 500, message: e instanceof Error ? e.message : String(e) };
};

export const makeDispatcher = (routes: Route[], token?: string) => {
  const compiled = routes.map((r) => ({ ...r, ...compile(r.pattern) }));
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let pathMatched = false;
      for (const r of compiled) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        if (token && r.auth !== false && !authorized(req, token)) throw new HttpError(401, "missing or wrong token");
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]));
        const result = await r.handler({ req, res, url, params, body: () => readBody(req) });
        if (res.headersSent) return;
        return result === undefined ? res.writeHead(204).end() : json(res, result);
      }
      throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "method not allowed" : "not found");
    } catch (e) {
      const { status, message } = errorMessage(e);
      if (res.headersSent) return void res.end();
      json(res, { error: message } satisfies ErrorResponse, status);
    }
  };
};
