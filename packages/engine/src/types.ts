export type FieldType = "text" | "textarea" | "select" | "radio" | "checkbox" | "file";

export type FormField = {
  id: string;        // stable key: name || id
  selector: string;  // CSS selector (radio/checkbox: the group by name)
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
};

export type Answer = {
  value: string;
  confident: boolean; // false → needs your input, highlighted in the dashboard
};

export type Answers = Record<string, Answer>;

export type Status =
  | "prepared"   // ready for review
  | "manual"     // no fillable form found — open and apply by hand
  | "skip-fit"   // resume tailor's fit gate said SKIP
  | "closed"     // posting no longer exists
  | "blocked"    // bot wall or login needed — form is found when you click Apply (your Chrome)
  | "error"
  | "filling"
  | "submitted"
  | "skipped";   // tab closed without submitting

export type Application = {
  id: string;
  url: string;
  applyUrl: string;
  title: string;
  company: string;
  jd: string;
  status: Status;
  fit?: string;
  atsScore?: number;
  resumePath?: string;
  fields: FormField[];
  answers: Answers;
  note?: string;
  updatedAt: string;
};
