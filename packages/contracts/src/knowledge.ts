import { z } from "zod";
import { def } from "./registry.ts";

// Markdown the agents read: profile, preferences, answers, style, resume/*, notes/*.
// Paths are relative to <JOBPILOT_HOME>/knowledge, only .md / .txt, `*.example.md` templates are not listed.

// GET /api/knowledge → KnowledgeFile[]
export const KnowledgeFile = def(
  "KnowledgeFile",
  z.object({
    path: z.string(), // e.g. "resume/main_resume.md"
    size: z.number().int(),
    modifiedAt: z.string(), // ISO 8601
  }),
);
export type KnowledgeFile = z.infer<typeof KnowledgeFile>;

// GET /api/knowledge/file?path=…
export const KnowledgeDocument = def("KnowledgeDocument", z.object({ path: z.string(), content: z.string() }));
export type KnowledgeDocument = z.infer<typeof KnowledgeDocument>;

// PUT /api/knowledge/file?path=… (creates the file if missing; max 1 MB)
export const SaveKnowledgeRequest = def("SaveKnowledgeRequest", z.object({ content: z.string() }));
export type SaveKnowledgeRequest = z.infer<typeof SaveKnowledgeRequest>;
