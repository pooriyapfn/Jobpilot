import { z } from "zod";

export function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = (fenced ? fenced[1] : trimmed).trim();

  const objStart = candidate.indexOf("{");
  const arrStart = candidate.indexOf("[");

  let start = -1;
  if (objStart === -1) start = arrStart;
  else if (arrStart === -1) start = objStart;
  else start = Math.min(objStart, arrStart);

  if (start === -1) {
    throw new Error("No JSON object or array found in LLM response");
  }

  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(closer);
  if (end <= start) {
    throw new Error("Incomplete JSON in LLM response");
  }

  return candidate.slice(start, end + 1);
}

export function parseJson<S extends z.ZodType>(
  raw: string,
  schema: S,
): z.infer<S> {
  const json = JSON.parse(extractJsonText(raw));
  return schema.parse(json);
}
