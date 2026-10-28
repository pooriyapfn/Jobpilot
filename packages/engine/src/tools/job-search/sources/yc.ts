// Y Combinator companies currently hiring (community mirror of YC's directory).
// https://github.com/yc-oss/api — updated daily, no auth.

import { YC_ONLY_REMOTE_FRIENDLY } from "../config.ts";
import type { CompanyRef } from "./company-boards.ts";

const YC_HIRING_URL = "https://yc-oss.github.io/api/companies/hiring.json";

interface YcCompany {
  name: string;
  website?: string;
  isHiring?: boolean;
  regions?: string[];
  status?: string;
}

export async function fetchYcCompanies(): Promise<CompanyRef[]> {
  const res = await fetch(YC_HIRING_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`YC list ${res.status}`);
  const all = (await res.json()) as YcCompany[];

  return all
    .filter((c) => c.isHiring && c.status !== "Inactive")
    .filter(
      (c) =>
        !YC_ONLY_REMOTE_FRIENDLY ||
        (c.regions ?? []).some((r) => r === "Remote" || r === "Partly Remote")
    )
    .map((c) => ({ name: c.name, website: c.website, source: "yc" }));
}
