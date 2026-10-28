import { z } from "zod";
import { Status } from "./application.ts";
import { def } from "./registry.ts";

// Bump when a route or payload changes incompatibly; the app checks it against EngineInfo.apiVersion.
export const API_VERSION = 1;

// First (and only) line `engine serve` writes to stdout once it is listening.
// Everything else goes to stderr. The app reads this line to learn the port.
export const EngineReady = def(
  "EngineReady",
  z.object({
    port: z.number().int(),
    token: z.string(), // send as `Authorization: Bearer <token>` on every request
    apiVersion: z.number().int(),
  }),
);
export type EngineReady = z.infer<typeof EngineReady>;

// GET /api/info
export const EngineInfo = def(
  "EngineInfo",
  z.object({
    apiVersion: z.number().int(),
    version: z.string(),
    home: z.string(), // JOBPILOT_HOME
    hasOpenrouterKey: z.boolean(),
    hasBraveKey: z.boolean(),
    candidateCountry: z.string().optional(),
    chromeReachable: z.boolean(), // job Chrome with remote debugging is running
  }),
);
export type EngineInfo = z.infer<typeof EngineInfo>;

// GET /api/eligible-jobs — output of search → verify → enrich, newest run
export const EligibleJob = def(
  "EligibleJob",
  z.object({
    id: z.string(), // same id as the Application it becomes
    url: z.string(),
    title: z.string(),
    company: z.string(),
    applicationStatus: Status.optional(), // set once prepared
  }),
);
export type EligibleJob = z.infer<typeof EligibleJob>;
