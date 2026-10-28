import { z } from "zod";
import type { JDAnalysis } from "./JDAnalysis.ts";
import { MODELS, type LLMJson } from "./LLM.ts";

export const ExperienceSchema = z.object({
  title: z.string(),
  description: z.string(),
});

export const ExperiencesSchema = z.array(ExperienceSchema);

const ExperiencesResponseSchema = z.object({
  experiences: ExperiencesSchema,
});

export type Experience = z.infer<typeof ExperienceSchema>;
export type Experiences = z.infer<typeof ExperiencesSchema>;

export const getRelevantExperiences = async (
  jd: JDAnalysis,
  rawExperiences: string,
  callLLMJson: LLMJson,
): Promise<Experiences> => {
  const prompt = `
    Select experiences from the candidate's history that best match this job.
    Prefer must-have skills, technologies, and responsibilities.

    Retrieval rules:
    - Do not invent experience.
    - Do not rewrite, paraphrase, or emphasize anything.
    - Copy title and description verbatim from CANDIDATE EXPERIENCES.
    - Prefer fewer, higher-overlap items over stretching weak matches.

    JOB ANALYSIS:
    ${JSON.stringify(jd, null, 2)}

    CANDIDATE EXPERIENCES:
    ${rawExperiences}

    Return ONLY valid JSON matching this shape:
    { "experiences": [ { "title": string, "description": string } ] }
  `;

  const { experiences } = await callLLMJson(prompt, ExperiencesResponseSchema, {
    name: "relevant_experiences",
    model: MODELS.extraction,
  });

  return experiences;
};
