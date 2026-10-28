import type { JDAnalysis } from "./JDAnalysis.ts";
import { MODELS, type LLM } from "./LLM.ts";
import type { Experiences } from "./ReleventExperience.ts";
import type { ATSResult } from "./ATSResult.ts";

type TailorResumeArgs = {
  baseResume: string;
  rules: string;
  jdAnalysis: JDAnalysis;
  relventExperiences: Experiences;
  feedback?: ATSResult;
};

export const tailorResume = async (
  args: TailorResumeArgs,
  callLLM: LLM,
): Promise<string> => {
  const fixedBulletAnchors = [
    "Took 310 Copilot from concept to production",
    "Deployed **14 computational-biology models**",
    "Owned infrastructure for **three ML training",
    "Progressed to become the primary engineer",
  ];

  const prompt = `
    You are a resume tailoring system.

    ══════════════════════════════════════════════════════
    HARD CONSTRAINTS — these are non-negotiable and override all other instructions.
    Violating any of these is a critical error.
    ══════════════════════════════════════════════════════

    A. PROFILE SECTION: The body of the ## PROFILE section must remain 100% verbatim.
       You may append ONE sentence at the very end — nowhere else.
       Do not change, rephrase, reorder, or remove a single word of the existing profile body.

    B. FIXED BULLETS: The following bullets must appear in the output WORD-FOR-WORD,
       exactly as they appear in the base resume. Do not modify, shorten, rephrase, or omit them:
       ${fixedBulletAnchors.map((a) => `       - "${a}..."`).join("\n")}

    C. Never invent experience, technologies, years of experience, or claims unsupported by the sources.
    D. Return only the finished resume in Markdown — no commentary, no preamble.

    ══════════════════════════════════════════════════════

    RULES
    ======
    ${args.rules}

    JOB ANALYSIS
    =============
    ${JSON.stringify(args.jdAnalysis, null, 2)}

    BASE RESUME
    ===========
    ${args.baseResume}


    RELEVANT VERIFIED EXPERIENCE
    ============================
    ${args.relventExperiences
      .map(
        (exp) => `
        ### ${exp.title}: \n
        ${exp.description}
        `,
      )
      .join("\n")}


      ${
        args.feedback
          ? `
    FEEDBACK FROM PREVIOUS ROUND — improve the resume based on this, but ONLY where supported by the verified experience above.
    Hard constraints A and B above are NOT overridden by this feedback.

    Missing keywords to incorporate (only where truthfully supported):
    ${args.feedback.missingKeywords.join(", ")}

    Weak sections to strengthen:
    ${args.feedback.weakSections.join(", ")}

    Recommendations:
    ${args.feedback.recommendations.join("\n    ")}

    Additional context:
    ${JSON.stringify({ unsupportedClaims: args.feedback.unsupportedClaims, explanation: args.feedback.explanation }, null, 2)}
        `
          : `Create the tailored resume.`
      }
  `;
  const result = await callLLM(prompt, MODELS.tailoring);
  return result;
};
