import { z } from "zod";
import type { JDAnalysis } from "./JDAnalysis.ts";
import { MODELS, type LLMJson } from "./LLM.ts";

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

export const assessFit = async (
  jdAnalysis: JDAnalysis,
  mainResume: string,
  rules: string,
  callLLMJson: LLMJson,
): Promise<FitClassification> => {
  const prompt = `
    You assess whether a candidate's resume is a fit for a job, using strict rules.

    CLASSIFICATION RULES (from the candidate's own rules.md):
    - STRONG_FIT: most important requirements are directly supported by the resume.
    - POSSIBLE_FIT: meaningful transferable evidence; gaps are not fundamental.
    - SKIP: a fundamental requirement is unmet. SKIP applies when ANY of these is true:
        * A required technology, language, or framework has no evidence in the resume
          (e.g., JD requires Rust, resume has no Rust).
        * The role is a fundamentally different discipline (e.g., Product Management
          when the candidate is a Software Engineer).
        * A required domain is completely absent (e.g., requires 6+ yrs data engineering
          with ADF/Fabric/T-SQL when the candidate has none of those).
        * A hard location or work-authorization requirement cannot be met.
        * The seniority or experience requirement clearly exceeds what the resume shows.

    IMPORTANT — read requirements exactly as written. Do not strengthen "X or Y" into
    "X and Y" (e.g., "Bachelor's or Master's degree ... or equivalent practical experience"
    means ANY ONE of those branches is sufficient — it is not a requirement for both a
    Bachelor's and a Master's). If a requirement has an "or equivalent practical/professional
    experience" clause, treat strong relevant experience in the resume as satisfying it.

    IMPORTANT — absence of explicit documentation is NOT the same as absence of skill.
    If the candidate demonstrates deep adjacent experience (e.g., production cloud infra,
    K8s, CI/CD, incident response), skills like IAM, rollbacks, or SLOs are likely
    practiced but undocumented. In that case, prefer POSSIBLE_FIT over SKIP.
    Reserve SKIP for gaps that are clearly fundamental and cannot be reasonably inferred
    from the candidate's documented experience.

    IMPORTANT — adjacent tools in the same category are interchangeable for SKIP purposes.
    If the JD names one framework/tool and the resume shows a sibling (e.g., Flask vs FastAPI,
    Terraform vs AWS CDK, GitLab CI vs GitHub Actions/CI/CD, Lambda/API Gateway vs other AWS
    services, OpenAPI/Swagger vs REST API design), that is a transferable match, not a hard gap.
    List it under "gaps" if useful but do not SKIP on it alone.

    Be strict only on hard gaps: a technology or domain that does not appear anywhere in
    the resume AND cannot be reasonably inferred from documented experience is a SKIP
    signal if it is truly essential to the role (not just listed as a nice-to-have).

    JOB ANALYSIS (extracted from JD):
    ${JSON.stringify(jdAnalysis, null, 2)}

    CANDIDATE RESUME:
    ${mainResume}

    OUTPUT STYLE — short and scannable, the reader skims this in a list:
    - "gaps": one entry per unmet requirement, at most 4, most important first.
      "type" must be exactly one of: ${GAP_TYPES.join(", ")}.
      "detail" is one short phrase, 10 words or fewer, naming the specific thing
      (e.g. "Go required, none on resume", "8+ years required, resume shows 7",
      "Must be based in the US", "Fintech/payments domain not shown").
    - "reasons": at most 3 strengths that support the classification, each 10 words or
      fewer. No sentences strung together with semicolons; no repeating the gaps.
    - Use "Location" for any country, timezone or on-site requirement, and "Language"
      for programming languages (spoken languages also go under "Language").

    Return ONLY valid JSON:
    {
      "classification": "STRONG_FIT" | "POSSIBLE_FIT" | "SKIP",
      "gaps": [{ "type": string, "detail": string }],   // unmet requirements (empty if STRONG_FIT)
      "reasons": string[]                                // supporting strengths
    }
  `;

  return callLLMJson(prompt, FitClassificationSchema, {
    name: "fit_assessment",
    model: MODELS.review,
  });
};
