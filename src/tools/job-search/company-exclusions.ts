import { readFile, writeFile } from "fs/promises";

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export async function loadExcludedCompanies(path: string): Promise<Set<string>> {
  try {
    const raw = await readFile(path, "utf8");
    const arr = JSON.parse(raw) as string[];
    return new Set(arr.map(normalize).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function addExcludedCompanies(
  path: string,
  companies: string[]
): Promise<{ added: number; total: number }> {
  const existing = await loadExcludedCompanies(path);
  const before = existing.size;
  for (const c of companies) {
    const n = normalize(c);
    if (n) existing.add(n);
  }
  const sorted = Array.from(existing).sort();
  await writeFile(path, JSON.stringify(sorted, null, 2), "utf8");
  return { added: sorted.length - before, total: sorted.length };
}

export function isCompanyExcluded(
  company: string | undefined,
  excluded: Set<string>
): boolean {
  if (!company) return false;
  return excluded.has(normalize(company));
}
