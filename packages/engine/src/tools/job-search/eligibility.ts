import { agents } from "../../../agents.config.ts";
import { candidate } from "./candidate.ts";
import type { EligibilityResult, VerifiedJob } from "./types.ts";

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;

// JEV answers one yes/no (Noul) question per job as a probability — no prose to parse.
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const YES_THRESHOLD = 0.5;

const buildQuestion = (): string => {
  const { country, city, regions } = candidate();
  const home = country ?? "the candidate's country";
  const where = country ? [city, country].filter(Boolean).join(", ") : undefined;
  const who = where
    ? `The candidate is a remote software/AI engineer in ${where}. They cannot relocate and have no work authorization outside ${country}; they work as a contractor or through an EOR.`
    : "The candidate is a remote software/AI engineer. They cannot relocate and have no work authorization abroad; they work as a contractor or through an EOR.";
  const openRegions = regions.length
    ? ` Regions that include ${home}: ${regions.join(", ")}. A post naming one of these (alone or alongside others) counts as open.`
    : "";
  return `${who} Is this job a remote role the candidate can take from ${home}? Answer yes only if the post is open to Europe/EU/EEA (region-level, no country list), is worldwide/global/anywhere, or names ${home} or a region that includes it.${openRegions} Answer no if it requires a specific other country or region (US, UK, Canada, India, LATAM, APAC, ...), a country list without ${home}, on-site/hybrid/relocation, or work authorization in a specific country. "Remote" alone with no geographic scope is no. If unsure, answer no.`;
};

export async function checkEligibility(
  job: VerifiedJob,
  model: string = agents.eligibility
): Promise<EligibilityResult> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const state = {
    title: job.title,
    company: job.company ?? "unknown",
    ats_location: (job.jobLocation ?? []).join(", ") || "not specified",
    displayed_location: job.displayedLocation ?? "not specified",
    work_mode: job.workMode ?? "unknown",
    remote: String(job.remote ?? "unknown"),
    geographic_scope_preclassified: job.geographicScope ?? "unknown",
    description_excerpt: (job.description ?? "").slice(0, 2000),
    visible_page_text: (job.visibleText ?? "").slice(0, 1000),
    search_snippets: job.extraSnippets ?? [],
  };

  const response = await fetch(DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      state,
      questions: { eligible: { type: "noul", instructions: buildQuestion() } },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    answers?: { eligible?: { type?: string; noul?: number } };
  };
  const p = data.answers?.eligible?.noul;
  if (typeof p !== "number" || !Number.isFinite(p)) {
    return { status: "uncertain", evidence: "Invalid JEV response", confidence: 0 };
  }

  const yes = p >= YES_THRESHOLD;
  const confidence = Math.max(0, Math.min(1, yes ? p : 1 - p));
  const where = candidate().country ?? "your location";
  return {
    status: yes ? "eligible" : "restricted",
    evidence: `${yes ? `Open to ${where}` : `Not open to ${where}`} (${Math.round(confidence * 100)}% sure)`,
    confidence,
  };
}

export async function checkEligibilityBatch(
  jobs: VerifiedJob[],
  model?: string,
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, EligibilityResult>> {
  const results = new Map<string, EligibilityResult>();

  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((j) => checkEligibility(j, model))
    );

    for (let k = 0; k < batch.length; k++) {
      const job = batch[k]!;
      const result = settled[k]!;
      if (result.status === "fulfilled") {
        results.set(job.url, result.value);
      } else {
        results.set(job.url, {
          status: "uncertain",
          evidence: `Error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          confidence: 0,
        });
      }
    }

    onProgress?.(Math.min(i + BATCH_SIZE, jobs.length), jobs.length);

    if (i + BATCH_SIZE < jobs.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return results;
}
