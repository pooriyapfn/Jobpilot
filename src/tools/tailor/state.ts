import type { ATSResult } from "./ATSResult.ts";
import type { JDAnalysis } from "./JDAnalysis.ts";
import type { Experiences } from "./ReleventExperience.ts";

export type ResumeWorkflowState = {
  jobDescription: string;

  rules: string;
  baseResume: string;

  relevantExperience: Experiences;

  jdAnalysis?: JDAnalysis;

  currentResume?: string;

  ats?: ATSResult;

  iteration: number;

  status:
    | "analyzing"
    | "retrieving"
    | "tailoring"
    | "checking"
    | "completed"
    | "failed";
};
