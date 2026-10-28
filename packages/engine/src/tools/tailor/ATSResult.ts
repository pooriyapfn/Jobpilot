import { z } from "zod";
import type { JDAnalysis } from "./JDAnalysis.ts";
import { MODELS, type LLMJson } from "./LLM.ts";
import { scoreTerms, weightedScore } from "./keywordScore.ts";
import type { Experiences } from "./ReleventExperience.ts";

export const ATSFeedbackSchema = z.object({
  weakSections: z.array(z.string()),
  unsupportedClaims: z.array(z.string()),
  recommendations: z.array(z.string()),
  explanation: z.array(z.string()),
});

export type ATSFeedback = z.infer<typeof ATSFeedbackSchema>;

export type ATSResult = ATSFeedback & {
  score: number;
  keywordScore: number;
  experienceMatchScore: number;
  seniorityMatchScore: number;
  skillsMatchScore: number;
  missingKeywords: string[];
};

export const scoreResume = (
  resume: string,
  jd: JDAnalysis,
): Pick<
  ATSResult,
  | "score"
  | "keywordScore"
  | "experienceMatchScore"
  | "seniorityMatchScore"
  | "skillsMatchScore"
  | "missingKeywords"
> => {
  const keyword = scoreTerms(resume, [...jd.keywords, ...jd.mustHave]);
  const experience = scoreTerms(resume, jd.mustHave);
  const seniority = scoreTerms(resume, jd.senioritySignals);
  const skills = scoreTerms(resume, jd.technologies);

  return {
    keywordScore: keyword.score,
    experienceMatchScore: experience.score,
    seniorityMatchScore: seniority.score,
    skillsMatchScore: skills.score,
    missingKeywords: keyword.missing,
    score: weightedScore([
      { score: experience.score, weight: 0.4 },
      { score: keyword.score, weight: 0.3 },
      { score: skills.score, weight: 0.2 },
      { score: seniority.score, weight: 0.1 },
    ]),
  };
};

export const checkATS = async (
  resume: string,
  jd: JDAnalysis,
  sourceExperience: Experiences,
  callLLMJson: LLMJson,
): Promise<ATSResult> => {
  const numeric = scoreResume(resume, jd);

  const prompt = `
    You review a tailored resume for qualitative issues only.
    Do not assign numeric scores. Coverage scoring is done separately.

    Rules:
    - Do not reward fabricated experience.
    - Flag claims unsupported by the verified source excerpts.
    - Recommend phrasing or structure changes only when the source supports them.

    JOB ANALYSIS:
    ${JSON.stringify(jd, null, 2)}

    CANDIDATE RESUME:
    ${resume}

    VERIFIED EXPERIENCE (verbatim excerpts):
    ${JSON.stringify(sourceExperience, null, 2)}

    Return ONLY valid JSON matching this shape:
    {
      "weakSections": string[],
      "unsupportedClaims": string[],
      "recommendations": string[],
      "explanation": string[]
    }
  `;

  const feedback = await callLLMJson(prompt, ATSFeedbackSchema, {
    name: "ats_feedback",
    model: MODELS.review,
  });

  return { ...numeric, ...feedback };
};
