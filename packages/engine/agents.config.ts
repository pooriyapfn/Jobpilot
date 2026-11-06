// One place to configure every LLM-powered agent in apply-agent.
// All calls go through OpenRouter (OPENROUTER_API_KEY in .env.local), so any
// OpenRouter model id works here. Each entry can also be overridden by env var.

const env = process.env;

export const agents = {
  // Resume tailor (src/tools/tailor)
  tailor: {
    // Structured JSON extraction (JD analysis, experience selection) — cheap,
    // high volume, low creativity. Use a "flash"-class model, not a reasoning
    // model: reasoning models burn tokens/latency on plain extraction.
    extraction: env.TAILOR_EXTRACTION_MODEL ?? "openai/gpt-5.6-luna",
    // The resume-writing pass — quality-critical, worth paying more for.
    tailoring: env.TAILOR_WRITING_MODEL ?? "openai/gpt-5.6-luna",
    // Fit assessment + qualitative ATS feedback — decent judgment, not top-tier.
    review: env.TAILOR_REVIEW_MODEL ?? "openai/gpt-5.6-luna",
  },

  // Job search (src/tools/job-search/eligibility.ts) — yes/no on whether
  // uncertain-location jobs are open to the candidate's country (CANDIDATE_COUNTRY).
  // Uses a Decisions-API model (JEV), not a chat model: ~$0.04/Mtok, no output tokens.
  eligibility: env.ELIGIBILITY_MODEL ?? "typesafe/jev-1.14",

  // Apply agent (src/agent/answer.ts) — answers application form fields.
  answer: env.ANSWER_MODEL ?? "openai/gpt-5.6-luna",
} as const;
