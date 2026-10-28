# Resume Tailor

Tailors your resume to a specific job description using an LLM pipeline, scores the result against a deterministic keyword-based ATS check, and iterates until it hits a target score (or stops improving). Outputs a clean `.md` and an ATS-friendly `.docx`.

Part of apply-agent: lives in `src/tools/tailor/`, used by the apply agent (`tailor.ts`) and the job-search batch (`tailor-batch.ts`). All commands below run from the apply-agent root.

## How it works

1. **Analyze** the job description → extract must-have skills, keywords, seniority signals, technologies, and the company/title.
2. **Select** relevant items from your experience bank that match those signals.
3. **Tailor** your base resume using only verified experience — the LLM is instructed never to invent skills or claims.
4. **Score** the result with a deterministic keyword-matching ATS scorer (see `keywordScore.ts`/`ATSResult.ts` — this is not an LLM guess, it's a repeatable weighted term-overlap calculation) and get qualitative feedback.
5. **Repeat** up to `MAX_ITERATIONS` times, feeding the score/feedback back in, until the score hits `ATS_THRESHOLD` or stops improving.
6. **Export** the best round to `data/tailor/output/` as both Markdown and a single-column, table-free `.docx` (parsers choke on tables/columns/text boxes — this avoids all of that).

Different models are used for different steps, since they have very different cost/quality needs — set in `agents.config.ts` (engine package root) under `tailor`:
- **extraction** (JD analysis, experience selection): cheap, fast, non-reasoning model
- **tailoring**: the actual resume-writing pass — worth paying more for
- **review**: qualitative ATS feedback — mid-tier

Every run prints its total OpenRouter cost.

## Setup

1. `npm install` (apply-agent root)
2. Copy `.env.local.example` → `.env.local` and fill in your `OPENROUTER_API_KEY` (get one at [openrouter.ai](https://openrouter.ai)). Optionally set `CANDIDATE_NAME`.
3. Copy the `*.example.md` files and remove the `.example` part, then fill them in with your real content:
   - `data/tailor/job_description.md` — the job posting you're applying to
   - `knowledge/resume/main_resume.md` — your canonical resume (fixed wording/structure)
   - `knowledge/resume/base_resume.md` — a broader evidence bank of experience the tailoring step can pull from
   - `knowledge/resume/rules.md` — the constraints tailoring must follow (what's fixed vs. tailorable)

## Run

```
npm run tailor            # or: npm run tailor -- --force   (ignore SKIP fit)
```

Output lands in `data/tailor/output/<Your-Name>-<Job-Title>-<Company>-<Year>-<Month>.{md,docx}`.

## Config

See `config.ts` for `atsThreshold` and `maxIterations`, `agents.config.ts` for the per-step model tiers — all overridable via env vars (`ATS_THRESHOLD`, `MAX_ITERATIONS`) or by editing the file directly.

Set `DEBUG_LLM=1` for a raw per-request trace (prompt sizes, token usage, full error bodies) if something needs debugging.

## Privacy

`job_description.md`, `main_resume.md`, `base_resume.md`, `rules.md`, `output/`, and `.env.local` are gitignored — your personal data and API key never get committed. Only the `*.example.md` templates and structural config are tracked.
