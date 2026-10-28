const ALIASES: Record<string, string[]> = {
  javascript: ["js", "javascript"],
  typescript: ["ts", "typescript"],
  kubernetes: ["k8s", "kubernetes"],
  postgresql: ["postgres", "postgresql"],
  nodejs: ["node", "nodejs", "node.js"],
  reactjs: ["react", "reactjs", "react.js"],
  cicd: ["ci/cd", "cicd", "ci cd"],
  relationaldatabases: [
    "relational databases",
    "postgres",
    "postgresql",
    "mysql",
    "sql server",
    "sqlite",
    "mariadb",
  ],
  sql: [
    "sql",
    "postgres",
    "postgresql",
    "mysql",
    "sql server",
    "sqlite",
    "mariadb",
    "bigquery",
  ],
};

export type TermScore = {
  score: number;
  matched: string[];
  missing: string[];
};

export const normalizeTerm = (value: string): string =>
  value
    .toLowerCase()
    .replace(/node\.js/g, "nodejs")
    .replace(/react\.js/g, "reactjs")
    .replace(/[^a-z0-9+#./\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const uniqueTerms = (terms: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const normalized = normalizeTerm(term);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(term);
  }
  return out;
};

const variantsFor = (term: string): string[] => {
  const normalized = normalizeTerm(term);
  const extras = ALIASES[normalized.replace(/\s+/g, "")] ?? [];
  return uniqueTerms([normalized, ...extras]);
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const termInText = (haystack: string, term: string): boolean => {
  const text = normalizeTerm(haystack);
  return variantsFor(term).some((variant) => {
    const v = normalizeTerm(variant);
    if (!v) return false;
    if (v.includes(" ") || v.includes("/") || v.includes(".")) {
      return text.includes(v);
    }
    const pattern = new RegExp(
      `(^|[^a-z0-9+#])${escapeRegExp(v)}([^a-z0-9+#]|$)`,
    );
    return pattern.test(text);
  });
};

export const scoreTerms = (text: string, terms: string[]): TermScore => {
  const unique = uniqueTerms(terms);
  if (unique.length === 0) {
    return { score: 100, matched: [], missing: [] };
  }

  const matched: string[] = [];
  const missing: string[] = [];
  for (const term of unique) {
    if (termInText(text, term)) matched.push(term);
    else missing.push(term);
  }

  return {
    score: Math.round((matched.length / unique.length) * 100),
    matched,
    missing,
  };
};

export const weightedScore = (parts: Array<{ score: number; weight: number }>): number => {
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  if (totalWeight === 0) return 0;
  const raw = parts.reduce((sum, part) => sum + part.score * part.weight, 0);
  return Math.round(raw / totalWeight);
};
