# JobPilot

Finds remote jobs, tailors a resume per job, prepares application answers, then fills each form in **your** Chrome. You always press Submit yourself.

One project, three tools:
- **job-search** (`packages/engine/src/tools/job-search`) — Brave + job boards → verify → eligibility → `data/job-search/eligible-jobs.json`
- **tailor** (`packages/engine/src/tools/tailor`) — `runResumeTailor` (fit gate + tailored resume + ATS loop) and the OpenRouter LLM client
- **apply** (`packages/engine/src/{agent,browser,server}`) — prepare, fill, dashboard, learning memory

## Quick start

```
npm install
cp .env.local.example .env.local                                             # OPENROUTER_API_KEY, BRAVE_API_KEY
for f in knowledge/*.example.md knowledge/resume/*.example.md; do cp -n "$f" "${f%.example.md}.md"; done   # then edit
npm start                                                                    # interactive CLI (apps/cli)
```

## Where your data lives (`JOBPILOT_HOME`)

`knowledge/`, `data/` and `.env.local` are read from `$JOBPILOT_HOME`. Unset, that is the repo root (dev default, gitignored).
To use the macOS location (absolute path, no `~`):

```
export JOBPILOT_HOME="$HOME/Library/Application Support/JobPilot"
npm start
```

The `setup-scheduler` launchd job records the value too. Code always runs from the repo checkout; only data moves.

## Contracts (engine ↔ macOS app)

The types that cross the boundary (Application, FormField, Answer, Status, API request/response bodies) are zod schemas in `packages/contracts/src`.
Register a new one with `def("Name", z.object(...))`, then:

```
npm run contracts          # writes packages/contracts/schema/*.json and apps/macos/JobPilot/Contracts/Generated/Contracts.swift
npm run contracts:check    # fails if the committed files are stale (also part of npm test)
```

The engine validates request bodies with the same schemas (invalid → HTTP 400). Never edit the generated files.

## Engine API (`engine serve`)

The macOS app launches the engine as a child process and talks to it over HTTP on loopback:

```
npm run serve                      # = packages/engine/src/bin.ts serve [--port N] [--exit-on-stdin-close]
```

- **Startup:** the engine prints ONE line on stdout, `{"port":51234,"token":"…","apiVersion":1}` (`EngineReady`); logs go to stderr. Token = `$JOBPILOT_TOKEN` or random. With `--exit-on-stdin-close` it quits when the app (owner of its stdin) exits.
- **Auth:** every request needs `Authorization: Bearer <token>`. Binds `127.0.0.1` only.
- **Routes** (payloads are the contracts in `packages/contracts/src`):

| | |
|---|---|
| `GET /api/info` | version, home, key presence, candidate country, job-Chrome reachable |
| `GET /api/apps` · `GET /api/eligible-jobs` | prepared applications · jobs from the last search (+ application status) |
| `POST /api/apply/:id` · `/api/answers/:id` · `/api/status/:id` | fill in Chrome · save edited answers · set status |
| `GET /resume/:id` | tailored resume (.docx) |
| `GET /api/jobs` · `POST /api/jobs` `{task, limit?}` | pipeline runs; tasks: `search verify enrich prepare fill chrome`; one running job per task (409) |
| `GET /api/jobs/:id` · `POST /api/jobs/:id/cancel` | status · stop (SIGINT, then SIGKILL after 5 s) |
| `GET /api/jobs/:id/events` | Server-Sent Events: replay + live lines, ends with the final status; resume with `Last-Event-ID` |
| `GET /api/knowledge` · `GET`/`PUT /api/knowledge/file?path=` | read/write the markdown the agents use (`.md`/`.txt`, inside `knowledge/`, ≤ 1 MB) |

`npm run dashboard` still starts the old dev dashboard (no token, port 4000, same routes).
Jobs run the existing scripts as child processes with the engine's own node flags and env.

## Candidate location

Geo filtering uses `CANDIDATE_COUNTRY` / `CANDIDATE_CITY` / `CANDIDATE_REGIONS` (see `.env.local.example`). Your own country is never
treated as restricted; jobs naming it count as eligible. A job open to a region you're in (EMEA, MENA, LATAM, APAC, … — derived from your
country, or set with `CANDIDATE_REGIONS`) is eligible; one limited to other regions is restricted. "Europe" stays for the AI check unless
your country is clearly inside it. With no country set, regional jobs go to the AI check. JSON-LD `applicantLocationRequirements` beats
the office `jobLocation` for remote jobs.

## Search sources

Each search looks back to the previous search (plus a day of overlap, 1–7 days; `last-run.json`), so frequent manual runs stay cheap.

| Source | What |
|---|---|
| `brave` | web search: role, startup and location queries (`searchQueries()` in `config.ts`) |
| `watchlist` / `yc` / `funding` | company names → their Greenhouse/Lever/Ashby/Workable board |
| `hn` | latest HN "Who is hiring" thread |
| `google` | Google Jobs via SerpApi (`SERPAPI_KEY`) — reaches agency and small-company sites with JSON-LD |
| `sites` | non-ATS career pages (`watched-sites.json`): verify adds a site after finding a real remote job on it; seeds in `WATCHED_SITE_SEEDS` |
| `remoteok` | RemoteOK public API (credit + link back to Remote OK: kept as `via:` on each job) |
| `himalayas` | Himalayas search API, filtered to jobs open to `CANDIDATE_COUNTRY` (else worldwide only) |
| `wellfound` | Brave's index of Wellfound job pages (no public API; Wellfound pages are never scraped for discovery) |
| `known` | every board found before (`ats-slugs.json`) is polled again until it has had no relevant role for 60 days |

Aggregator listings (RemoteOK, Himalayas, Wellfound) are matched to the same job on the company's own Greenhouse/Lever/Ashby/
Workable board, which has the full application form; the employer's posting then decides remote/date/location. Unmatched
listings keep the aggregator page plus its API data (`listing`); prepare hands those to your Chrome, where "Apply" leads to the
employer (Himalayas has a bot check, RemoteOK's Apply redirect and Wellfound's own form need a real browser session).

`npm run search -- --only=google,sites` runs a subset. After `npm run verify`, `stats.json` → `yield` and `yield-history.jsonl` show which
queries and sources produce candidates.

## Commands

```
npm start / npm run cli     interactive menu: find → prepare → fill → review
# job-search
npm run search              Brave + job boards → data/job-search/jobs.json
npm run verify              fetch pages, freshness, location, closed postings
npm run enrich              LLM eligibility check → eligible-jobs.json
npm run report              markdown report → data/job-search/reports/
npm run jobs-dashboard      job-search DB dashboard (port 3000)
npm run tailor-batch        tailor resumes for all eligible jobs → data/tailor/output/
npm run setup-scheduler     launchd: search+verify+enrich every 12h  (npm run unschedule to remove)
# tailor
npm run tailor [-- --force] one resume for data/tailor/job_description.md → data/tailor/output/
# apply
npm run prepare-jobs        per new job (headless): find form → tailor resume → answer fields → data/agent.db
npm run chrome              Chrome with remote debugging (profile ~/.chrome-jobs) — log in to sites once
npm run fill [-- --limit N] open ready jobs as filled tabs in that Chrome; you review + submit
npm run dashboard           http://localhost:4000 — review/edit answers, click Apply, edits are learned
npm run serve               engine HTTP API for the Mac app (see Engine API)
npm run macos:run           the Mac app (starts the engine itself)  ·  npm run macos:test
# dev
npm test  ·  npm run typecheck
```

## LLM models

All agents call OpenRouter. Configure every model in one place: **`packages/engine/agents.config.ts`**

| agent | key | used by |
|---|---|---|
| tailor | `tailor.extraction` / `tailor.tailoring` / `tailor.review` | JD analysis + experience selection / resume writing / fit + ATS feedback |
| job-search | `eligibility` | uncertain-location eligibility check |
| apply | `answer` | application form answers |

Each can be overridden by env var (see `.env.local.example`).

## Knowledge (markdown intelligence)

```
knowledge/
  profile.md  preferences.md  answers.md  style.md   answer agent notes (every top-level .md is read)
  resume/     main_resume.md (canonical CV) · base_resume.md (experience bank) · rules.md (tailoring rules)
  notes/      personal notes, not read by agents
```

Answer agent trusts, in order: `knowledge/*.md` → learned answers (`memory` table in `data/agent.db`) → tailored resume + `knowledge/resume/`.

## Data

```
data/
  agent.db          applications + learned answers
  resumes/          resumes tailored by prepare-jobs (<id>.{md,docx})
  job-search/       search pipeline output: jobs.db, eligible-jobs.json, excluded-companies.json, ats-slugs.json, reports/
  tailor/           job_description.md (single-run input)
  tailor/output/    archive of all tailored resumes
```

## Layout

npm workspaces monorepo. All npm scripts run from the repo root.

```
apps/
  cli/        src/index.ts            interactive menu (@jobpilot/cli)
  macos/                              SwiftUI app (see apps/macos/README.md); JobPilot/Contracts/Generated/ is generated
packages/
  engine/     (@jobpilot/engine)
    agents.config.ts                  LLM model per agent
    src/
      config.ts  types.ts  db.ts      paths + apply DB
      tools/
        job-search/                   stand-alone search pipeline (+ jobs.ts: ready jobs for the apply agent)
        tailor/                       resume tailor workflow (+ tailor.ts: wrapper for the apply agent)
      browser/   session.ts  apply-page.ts  form.ts  submit.ts
      agent/     knowledge.ts  memory.ts  answer.ts  prepare.ts  apply.ts  fill.ts
      server/    server.ts (startServer) routes.ts jobs.ts knowledge.ts http.ts page.ts
      bin.ts                          `engine serve` entry
  contracts/  (@jobpilot/contracts)   zod schemas → schema/*.json → Swift (apps/macos/.../Contracts.swift)
scripts/                              run-pipeline.sh
knowledge/  data/  .env.local         your personal data (or under $JOBPILOT_HOME) — gitignored, only *.example files are tracked
```
