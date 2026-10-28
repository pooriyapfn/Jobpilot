import { agents } from "../../../agents.config.ts";
import type { EligibilityResult, VerifiedJob } from "./types.ts";

const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 3_000;

const SYSTEM_PROMPT = `You are a strict job eligibility classifier. The candidate is a senior software/AI engineer in Istanbul, Turkey. They cannot relocate and have no work authorization outside Turkey — they need EOR or contractor arrangements.

IMPORTANT: Apply a FAIL-CLOSED approach. Missing restriction is NOT evidence of eligibility.

RESTRICTED — mark if any of these appear:
- Explicit country requirement: "Remote - US", "Remote (India)", "Brazil only", "must be based in Austria", "[country] only"
- Authorization requirement: "authorized to work in the US/UK/EU", "work authorization", "security clearance"
- Physical presence required: "on-site", "primarily on-site", "must relocate", "in-office", "hybrid"
- Location restricted to specific non-Turkey country or region (US, UK, EU, Canada, India, Brazil, LATAM, APAC, etc.)
- Any phrasing meaning "you must live in [specific country]"

ELIGIBLE — mark ONLY if:
- Explicitly worldwide, global, anywhere, or "work from anywhere"
- Explicitly Turkey-inclusive (EMEA without Turkey exclusion, or Turkey/Turkiye mentioned)
- The job listing explicitly states broad geographic eligibility

UNCERTAIN — mark if:
- "Remote" alone with no geographic scope specified (this is NOT eligible — just "remote" says nothing about which countries)
- Cannot determine geographic eligibility from available text
- Ambiguous signals (e.g. "Europe" without specifying which countries)

Confidence: use 0.9+ for clear cases, 0.6-0.8 for ambiguous.
Clamp confidence to range [0.0, 1.0].
Return ONLY valid JSON: {"status":"eligible"|"restricted"|"uncertain","evidence":"<one sentence>","confidence":0.0-1.0}`;

export async function checkEligibility(
  job: VerifiedJob,
  model: string = agents.eligibility
): Promise<EligibilityResult> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const userContent = [
    `Title: ${job.title}`,
    `Company: ${job.company ?? "unknown"}`,
    `ATS Location: ${(job.jobLocation ?? []).join(", ") || "not specified"}`,
    `Displayed Location: ${job.displayedLocation ?? "not specified"}`,
    `Work Mode: ${job.workMode ?? "unknown"}`,
    `Remote: ${job.remote ?? "unknown"}`,
    `Geographic Scope (pre-classified): ${job.geographicScope ?? "unknown"}`,
    `Description excerpt:`,
    (job.description ?? "").slice(0, 2000),
    `Visible page text (first 1000 chars):`,
    (job.visibleText ?? "").slice(0, 1000),
    job.extraSnippets?.length ? `\nSearch snippets:\n${job.extraSnippets.join("\n")}` : "",
  ].join("\n");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0,
      max_tokens: 200,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const raw = data.choices[0]?.message?.content?.trim() ?? "";

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : raw;
    const parsed = JSON.parse(cleaned) as EligibilityResult;
    if (!["eligible", "restricted", "uncertain"].includes(parsed.status)) {
      return { status: "uncertain", evidence: "Invalid LLM response", confidence: 0 };
    }
    // Clamp confidence to [0, 1]
    parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    return parsed;
  } catch {
    return { status: "uncertain", evidence: `Parse error: ${raw.slice(0, 100)}`, confidence: 0 };
  }
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
