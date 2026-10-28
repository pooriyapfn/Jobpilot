import { z } from "zod";
import { def } from "./registry.ts";

export const FieldType = def("FieldType", z.enum(["text", "textarea", "select", "radio", "checkbox", "file"]));
export type FieldType = z.infer<typeof FieldType>;

export const FormField = def(
  "FormField",
  z.object({
    id: z.string(), // stable key: name || id
    selector: z.string(), // CSS selector (radio/checkbox: the group by name)
    label: z.string(),
    type: FieldType,
    required: z.boolean(),
    options: z.array(z.string()).optional(),
  }),
);
export type FormField = z.infer<typeof FormField>;

export const Answer = def(
  "Answer",
  z.object({
    value: z.string(),
    confident: z.boolean(), // false → needs your input, highlighted in the dashboard
  }),
);
export type Answer = z.infer<typeof Answer>;

export const Answers = z.record(z.string(), Answer); // keyed by FormField.id
export type Answers = z.infer<typeof Answers>;

export const Status = def(
  "Status",
  z.enum([
    "prepared", // ready for review
    "manual", // no fillable form found — open and apply by hand
    "skip-fit", // resume tailor's fit gate said SKIP
    "closed", // posting no longer exists
    "blocked", // bot wall or login needed — form is found when you click Apply (your Chrome)
    "error",
    "filling",
    "submitted",
    "skipped", // tab closed without submitting
  ]),
);
export type Status = z.infer<typeof Status>;

export const Application = def(
  "Application",
  z.object({
    id: z.string(),
    url: z.string(),
    applyUrl: z.string(),
    title: z.string(),
    company: z.string(),
    jd: z.string(),
    status: Status,
    fit: z.string().optional(),
    atsScore: z.number().optional(),
    resumePath: z.string().optional(),
    fields: z.array(FormField),
    answers: Answers,
    note: z.string().optional(),
    updatedAt: z.string(), // ISO 8601
  }),
);
export type Application = z.infer<typeof Application>;
