// Client for JEV (typesafe/jev-*) on OpenRouter's Decisions API. JEV isn't a chat
// model: it takes `state` plus typed questions and returns a probability per
// question (Noul = yes/no, Choice = one of a fixed set), so there is no text to parse.

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };

export async function askJev(
  model: string,
  state: unknown,
  questions: Record<string, JevQuestion>,
): Promise<Record<string, JevAnswer>> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const response = await fetch(DECISIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, state, questions }),
  });
  if (!response.ok) throw new Error(`OpenRouter error ${response.status}: ${await response.text()}`);

  const data = (await response.json()) as { answers?: Record<string, JevAnswer> };
  return data.answers ?? {};
}

/** Probability of "yes" for a Noul answer, or undefined if the answer is missing or malformed. */
export const noulYes = (answers: Record<string, JevAnswer>, id: string): number | undefined => {
  const a = answers[id];
  return a?.type === "noul" && Number.isFinite(a.noul) ? a.noul : undefined;
};
