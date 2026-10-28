// Agent memory: answers learned from your dashboard edits and from what you typed before submitting.
// Every answer prompt includes it, so a question answered once is answered the same way next time.
// (Facts about you live in knowledge/*.md.)
import { db } from "../db.ts";

export type Memory = { question: string; answer: string; kind: "fact" | "answer" };

const keyOf = (question: string) =>
  question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const remember = (question: string, answer: string, kind: Memory["kind"] = "answer"): void => {
  const key = keyOf(question);
  if (!key || !answer.trim()) return;
  db.prepare(
    `INSERT INTO memory (key, question, answer, kind, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at`,
  ).run(key, question.trim(), answer.trim(), kind, new Date().toISOString());
};

export const recall = (): Memory[] =>
  db.prepare("SELECT question, answer, kind FROM memory WHERE kind = 'answer' ORDER BY updated_at DESC").all() as Memory[];

export const formatMemory = (memories = recall()): string =>
  memories.map((m) => `- ${m.question}: ${m.answer}`).join("\n") || "(empty)";
