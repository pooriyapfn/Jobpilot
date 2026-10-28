import { z } from "zod";
import { Application, Status } from "./application.ts";
import { def } from "./registry.ts";

// Dashboard API (packages/engine/src/server/server.ts)

// GET /api/apps — the table doesn't need the job description text.
export const ApplicationSummary = def("ApplicationSummary", Application.omit({ jd: true }));
export type ApplicationSummary = z.infer<typeof ApplicationSummary>;

// POST /api/answers/:id — edits keyed by FormField.id
export const SaveAnswersRequest = def("SaveAnswersRequest", z.object({ answers: z.record(z.string(), z.string()) }));
export type SaveAnswersRequest = z.infer<typeof SaveAnswersRequest>;

// POST /api/status/:id
export const SetStatusRequest = def("SetStatusRequest", z.object({ status: Status }));
export type SetStatusRequest = z.infer<typeof SetStatusRequest>;

// POST /api/apply/:id, /api/answers/:id, /api/status/:id
export const OkResponse = def("OkResponse", z.object({ ok: z.boolean() }));
export type OkResponse = z.infer<typeof OkResponse>;

// Any non-2xx response
export const ErrorResponse = def("ErrorResponse", z.object({ error: z.string() }));
export type ErrorResponse = z.infer<typeof ErrorResponse>;
