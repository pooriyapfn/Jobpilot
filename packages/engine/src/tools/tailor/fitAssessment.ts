import { z } from "zod";
import type { JDAnalysis } from "./JDAnalysis.ts";
import { agents } from "../../../agents.config.ts";
import { askJev, noulYes, type JevAnswer, type JevQuestion } from "../jev.ts";

export const GAP_TYPES = [
  "Language", // programming language, e.g. Go, Rust
  "Framework", // framework, library or tool
  "Skill", // other technical or professional skill
  "Domain", // industry or problem area, e.g. fintech, data engineering
  "Seniority", // years of experience or level
  "Role", // a different discipline altogether
  "Location", // country, timezone or on-site requirement
  "Work authorization", // visa, citizenship, clearance
  "Education", // degree or certification
  "Other",
] as const;

export const FitClassificationSchema = z.object({
  classification: z.enum(["STRONG_FIT", "POSSIBLE_FIT", "SKIP"]),
  reasons: z.array(z.string()),
  gaps: z.array(z.object({ type: z.enum(GAP_TYPES), detail: z.string() })),
});

export type FitClassification = z.infer<typeof FitClassificationSchema>;

/** One short line per finding: gaps first ("✗ Language: no Go experience"), then strengths ("✓ ..."). */
export const fitLines = (fit: Pick<FitClassification, "gaps" | "reasons">): string[] => [
  ...fit.gaps.map((g) => `✗ ${g.type}: ${g.detail}`),
  ...fit.reasons.map((r) => `✓ ${r}`),
];

// Below this probability a SKIP verdict is downgraded to POSSIBLE_FIT: wrongly dropping a
// job costs more than reviewing one extra, and the old prompt also preferred POSSIBLE over SKIP when unsure.
const SKIP_MIN_PROBABILITY = 0.6;
const YES_THRESHOLD = 0.5;

// One yes/no question per gap type. JEV returns probabilities, not prose, so a gap's
// detail is a fixed phrase rather than the free-text specifics the old LLM wrote.
const GAP_QUESTIONS: Record<Exclude<(typeof GAP_TYPES)[number], "Other">, { ask: string; detail: string }> = {
  Language: { ask: "The job requires a programming (or spoken) language that does not appear anywhere in the resume.", detail: "Required language not on resume" },
  Framework: { ask: "The job requires an essential framework, library or tool with no evidence in the resume and no close sibling tool (e.g. Flask vs FastAPI).", detail: "Required framework or tool not on resume" },
  Skill: { ask: "The job requires an essential technical or professional skill that the resume does not show and that cannot be inferred from the documented experience.", detail: "Required skill not shown on resume" },
  Domain: { ask: "The job requires deep experience in an industry or problem domain that is completely absent from the resume.", detail: "Required domain not shown on resume" },
  Seniority: { ask: "The job's seniority or years-of-experience requirement clearly exceeds what the resume shows.", detail: "Seniority or experience requirement not met" },
  Role: { ask: "The job is a fundamentally different discipline from the candidate's (e.g. product management vs software engineering).", detail: "Different discipline from your background" },
  Location: { ask: "The job has a hard location, timezone or on-site requirement that the candidate cannot meet.", detail: "Location requirement not met" },
  "Work authorization": { ask: "The job requires visa, citizenship, work authorization or security clearance that the candidate lacks.", detail: "Work authorization required" },
  Education: { ask: "The job requires a degree or certification that the resume lacks and that is not replaceable by equivalent practical experience.", detail: "Required degree or certification missing" },
};

const STRENGTH_QUESTIONS = [
  { id: "strength_skills", ask: "The resume directly supports most of the job's important required technologies and skills.", reason: "Resume covers the key technologies" },
  { id: "strength_domain", ask: "The resume shows relevant experience in the job's domain or problem area.", reason: "Relevant domain experience" },
  { id: "strength_seniority", ask: "The resume's seniority and years of experience match what the job asks for.", reason: "Seniority matches" },
] as const;

const READING_RULES =
  "Read requirements exactly as written: \"X or Y\" means either is enough, and an \"or equivalent practical experience\" clause is satisfied by strong relevant experience. Missing documentation is not missing skill: deep adjacent experience implies skills that are likely practiced. Adjacent tools in the same category are interchangeable. Only count a gap if it is essential, not a nice-to-have.";

export const assessFit = async (
  jdAnalysis: JDAnalysis,
  mainResume: string,
  rules: string,
  model: string = agents.tailor.fit,
): Promise<FitClassification> => {
  const questions: Record<string, JevQuestion> = {
    fit: {
      type: "choice",
      instructions: `How well does the candidate's resume (state.resume) fit the job (state.job), under the candidate's own rules (state.rules)? ${READING_RULES}`,
      criteria: {
        STRONG_FIT: "Most of the job's important requirements are directly supported by the resume.",
        POSSIBLE_FIT: "There is meaningful transferable evidence; any gaps are not fundamental.",
        SKIP: "A fundamental requirement is unmet: an essential technology or domain is absent, the role is a different discipline, a hard location or work-authorization rule cannot be met, or the seniority requirement clearly exceeds the resume.",
      },
    },
  };
  for (const [type, q] of Object.entries(GAP_QUESTIONS)) {
    questions[`gap_${type}`] = { type: "noul", instructions: `Considering state.job and state.resume: ${q.ask} ${READING_RULES}` };
  }
  for (const q of STRENGTH_QUESTIONS) {
    questions[q.id] = { type: "noul", instructions: `Considering state.job and state.resume: ${q.ask}` };
  }

  const answers = await askJev(model, { job: jdAnalysis, resume: mainResume, rules }, questions);

  const fit: JevAnswer | undefined = answers["fit"];
  if (fit?.type !== "choice") throw new Error("Invalid JEV response: missing fit answer");

  let classification = fit.choice as FitClassification["classification"];
  if (!["STRONG_FIT", "POSSIBLE_FIT", "SKIP"].includes(classification)) {
    throw new Error(`Invalid JEV response: unknown fit "${fit.choice}"`);
  }
  if (classification === "SKIP" && (fit.probabilities["SKIP"] ?? 0) < SKIP_MIN_PROBABILITY) {
    classification = "POSSIBLE_FIT";
  }

  const gaps = Object.entries(GAP_QUESTIONS)
    .map(([type, q]) => ({ type: type as (typeof GAP_TYPES)[number], detail: q.detail, p: noulYes(answers, `gap_${type}`) ?? 0 }))
    .filter((g) => g.p >= YES_THRESHOLD)
    .sort((x, y) => y.p - x.p)
    .slice(0, 4)
    .map(({ type, detail }) => ({ type, detail }));

  const reasons = STRENGTH_QUESTIONS.filter((q) => (noulYes(answers, q.id) ?? 0) >= YES_THRESHOLD).map((q) => q.reason);

  return { classification, reasons, gaps: classification === "STRONG_FIT" ? [] : gaps };
};
