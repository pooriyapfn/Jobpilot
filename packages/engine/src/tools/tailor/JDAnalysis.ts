import { z } from "zod";
import { MODELS, type LLMJson } from "./LLM.ts";

export const JDAnalysisSchema = z.object({
  title: z.string(),
  company: z.string(),
  mustHave: z.array(z.string()),
  niceToHave: z.array(z.string()),
  technologies: z.array(z.string()),
  responsibilities: z.array(z.string()),
  senioritySignals: z.array(z.string()),
  domainSignals: z.array(z.string()),
  keywords: z.array(z.string()),
});

export type JDAnalysis = z.infer<typeof JDAnalysisSchema>;

type AnalyzeJD = (jd: string, callLLMJson: LLMJson) => Promise<JDAnalysis>;

export const analyzeJD: AnalyzeJD = async (jd, callLLMJson) => {
  const prompt = `
    You analyze software engineering job descriptions.
    Extract the hiring signals needed to tailor a resume.
    Do not infer requirements that are not present.

    "title" is the job title (e.g. "Product Engineer"). "company" is the
    hiring company's name (e.g. "Colonist"), as short as it's normally
    written, no legal suffixes like "Inc." unless the JD uses them.

    Every array item MUST be a short keyword or phrase (1-4 words), never a
    full sentence. These items are matched literally against resume text,
    so break sentences down into the individual skills, tools, and signals
    they contain.

    Example: "Strong grasp of Git, code reviews, and collaborative workflows"
    becomes ["Git", "code reviews", "collaborative workflows"], not one
    combined string.

    "senioritySignals" is special: it must contain GENERIC seniority
    indicators that a candidate's own resume would plausibly use, not
    restated JD action phrases. Do not copy verbs from "What You'll Do"
    or "Requirements" (e.g. never "evolve architecture", "mentor peers",
    "architect multi-platform systems" — those belong in
    "responsibilities"). Instead infer the seniority LEVEL implied by the
    JD and express it as terms resumes commonly use, such as: "years of
    experience", "senior", "lead", "staff", "led a team", "mentored",
    "owned architecture", "cross-functional", "end-to-end ownership".
    Only include signals actually implied by the JD's tone and
    requirements.

    JOB DESCRIPTION:

    ${jd}


    return ONLY valid JSON matching this shape:
    {
    "title": string,
    "company": string,
    "mustHave": string[],
    "niceToHave": string[],
    "technologies": string[],
    "responsibilities": string[],
    "senioritySignals": string[],
    "domainSignals": string[],
    "keywords": string[]
    }`;

  return callLLMJson(prompt, JDAnalysisSchema, {
    name: "jd_analysis",
    model: MODELS.extraction,
  });
};
