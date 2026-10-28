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
  macos/                              SwiftUI app (planned)
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
      server/    server.ts  page.ts
  contracts/                          shared schemas (planned)
scripts/                              run-pipeline.sh
knowledge/  data/  .env.local         your personal data — gitignored, only *.example files are tracked
```
