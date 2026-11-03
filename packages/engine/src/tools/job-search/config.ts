import { candidate } from "./candidate.ts";

export const SEARCH_QUERIES: string[] = [
  // AI family — general
  `"AI Engineer" remote`,
  `"Applied AI" engineer remote`,
  `"LLM" engineer remote`,
  `"Generative AI" engineer remote`,
  `"AI" "software engineer" remote`,
  `"AI" "product engineer" remote`,
  `"agentic" engineer remote`,
  `"agents" engineer remote`,
  // Software family — general
  `"Senior Software Engineer" remote`,
  `"Senior Full Stack Engineer" remote`,
  `"Product Engineer" remote`,
  `"Founding Engineer" remote`,
  `"Software Engineer" TypeScript remote`,
  `"Software Engineer" React Node remote`,
  // ATS site: searches — with and without "remote"
  `site:jobs.ashbyhq.com "AI Engineer"`,
  `site:jobs.ashbyhq.com "AI Engineer" remote`,
  `site:jobs.ashbyhq.com "Product Engineer"`,
  `site:jobs.ashbyhq.com "Product Engineer" remote`,
  `site:jobs.lever.co "AI Engineer"`,
  `site:jobs.lever.co "AI Engineer" remote`,
  `site:jobs.lever.co "Product Engineer"`,
  `site:jobs.lever.co "Product Engineer" remote`,
  `site:boards.greenhouse.io "AI Engineer"`,
  `site:boards.greenhouse.io "AI Engineer" remote`,
  `site:job-boards.greenhouse.io "AI Engineer"`,
  `site:job-boards.greenhouse.io "AI Engineer" remote`,
  `site:jobs.smartrecruiters.com "AI Engineer" remote`,
  `site:apply.workable.com "AI Engineer" remote`,
  // Startup titles and signals
  `"Member of Technical Staff" remote`,
  `"Forward Deployed Engineer" remote`,
  `"Design Engineer" remote startup`,
  `"Founding Engineer" seed OR "Series A" remote`,
  `"early-stage" startup "software engineer" remote`,
  `"YC" startup "engineer" remote hiring`,
  `site:jobs.ashbyhq.com "Member of Technical Staff"`,
  `site:jobs.ashbyhq.com "Founding Engineer"`,
  // Recruiting agencies posting for clients on their own sites (caught via JSON-LD)
  `"on behalf of" "our client" remote "software engineer"`,
  `"our client" "AI" remote engineer "fully remote"`,
];

/** SEARCH_QUERIES plus location queries for the candidate's country and open regions (from .env.local). */
export function searchQueries(): string[] {
  const { country, regions } = candidate();
  const places = [...(country ? [country] : []), ...regions];
  const located = places.flatMap((p) => [
    `"software engineer" remote "${p}"`,
    `"AI engineer" remote "${p}"`,
    `site:jobs.ashbyhq.com remote "${p}"`,
  ]);
  return [...SEARCH_QUERIES, ...located];
}

export const EXCLUDED_DOMAINS: string[] = [
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "wellfound.com",
  "ziprecruiter.com",
  "remoteok.com",
  "weworkremotely.com",
  "remoterocketship.com",
  "jobgether.com",
  "jooble.org",
  "himalayas.app",
  "usaremotejobs.app",
  "remotejobleads.com",
  "remoteitjobs.app",
  "resumebuilder.careers",
  "remoteleaf.com",
  "dice.com",
  "builtinnyc.com",
  "builtinsf.com",
  "builtinchicago.org",
  "builtinla.com",
  "builtinboston.com",
  "internshala.com",
  "welcometothejungle.com",
  "hnhiring.com",
  "crossover.com",
  "remotejobs.dedyn.io",
  "irelandjobs.app",
  "remote.com",
];

// Jobs stating a lower salary are rejected. Override with MIN_MONTHLY_SALARY_USD in .env.local (0 = off).
export const MIN_MONTHLY_SALARY_USD = Number(process.env.MIN_MONTHLY_SALARY_USD ?? 3000);

// ATS company slugs to block (e.g. jobs.lever.co/jobgether/*)
export const EXCLUDED_ATS_COMPANIES: string[] = [
  "jobgether",
];

export const ATS_DOMAINS: string[] = [
  "jobs.ashbyhq.com",
  "jobs.lever.co",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.smartrecruiters.com",
  "apply.workable.com",
];

// ── Extra sources (src/sources/) ─────────────────────────────────────────────

// Board-API job titles: must match INCLUDE and not EXCLUDE
export const ROLE_TITLE_INCLUDE = /engineer|developer|software|founding|technical staff|forward deployed|\bai\b|\bml\b/i;
// "Solutions Engineer" / forward-deployed roles at AI startups stay in; pure presales titles don't.
export const ROLE_TITLE_EXCLUDE =
  /\b(intern|internship|manager|director|vp|head of|sales|solutions (?:consultant|architect)|support|recruit\w*|account|mechanical|electrical|hardware|firmware|field|customer success|data scientist|research scientist|staff accountant)\b/i;

// Drop board jobs whose posting date is known and older than this (verify re-checks freshness)
export const SOURCE_MAX_AGE_DAYS = 7;

// YC: only companies tagged Remote / Partly Remote in YC's directory
export const YC_ONLY_REMOTE_FRIENDLY = true;

// Brave News queries to find freshly funded startups (headline → company name)
export const FUNDING_NEWS_QUERIES: string[] = [
  `startup raises seed round AI`,
  `startup raises Series A`,
  `startup raises Series B`,
  `raises million led by Andreessen Horowitz OR Sequoia OR Accel OR "Index Ventures" OR Lightspeed`,
  `remote-first startup raises funding`,
  `startup raises pre-seed`,
  `European startup raises seed OR "Series A"`,
];

// Hand-picked VC-backed startups to always check. Names are resolved to Greenhouse/Lever/Ashby
// slugs automatically (cached in output/ats-slugs.json); unresolved names are skipped.
export const VC_WATCHLIST: string[] = [
  "Vercel", "Supabase", "PostHog", "Linear", "Retool", "Replit", "Cohere", "Mistral",
  "Perplexity", "ElevenLabs", "Runway", "LangChain", "Pinecone", "Weaviate", "Modal",
  "Together AI", "Fireworks AI", "Baseten", "Hugging Face", "Harvey", "Glean", "Sierra",
  "Decagon", "Clay", "Ramp", "Deel", "Temporal", "Sentry", "Resend", "Cal.com", "Neon",
  "Cursor", "Anysphere", "Cognition", "Lovable", "Statsig", "Mercor", "Hex", "Dagster",
];

// Google Jobs via SerpApi (needs SERPAPI_KEY; skipped without it). One API call per query per run.
// Location words come from the candidate's country/regions (see googleJobsQueries in sources/google-jobs.ts).
export const GOOGLE_JOBS_QUERIES: string[] = [
  "software engineer remote",
  "AI engineer remote",
  "founding engineer remote",
];

// Career pages on non-ATS sites (agencies, small companies) whose jobs carry JSON-LD JobPosting.
// Verify adds more automatically (watched-sites.json); these are always checked.
export const WATCHED_SITE_SEEDS: string[] = ["https://argusrecruit.com/jobs/"];

// RSS feeds of funding announcements — headline → company name (same path as FUNDING_NEWS_QUERIES)
export const FUNDING_FEEDS: string[] = [
  "https://techcrunch.com/category/venture/feed/",
  "https://sifted.eu/feed",
  "https://news.crunchbase.com/feed/",
  "https://www.eu-startups.com/feed/",
  "https://tech.eu/feed/",
];
