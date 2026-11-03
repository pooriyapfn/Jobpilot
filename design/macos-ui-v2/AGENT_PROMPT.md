Implement the approved native macOS UI redesign for JobPilot in this repo.

First inspect `design/macos-ui-v2/reference.png`, then read `design/macos-ui-v2/BUILD_SPEC.md` and the existing macOS app/engine code. Work inside the existing SwiftUI macOS 15+ app at `apps/macos`; preserve its engine lifecycle, authenticated loopback API, generated contracts, answer memory, and application workflow.

Build a focused native three-pane workspace:

- Sidebar: All applications, Ready to review, Needs your input, Submitted, My profile, Base resume, Settings.
- Middle: compact searchable application list with real counts, stable selection, and quiet uncertainty indicators.
- Detail: company/role, qualitative fit and ATS keyword score, Resume / Answers / Job posting tabs, real resume preview/export, and a compact Fill in Chrome footer.

Match the reference's restraint: system typography/colors, native titlebar/toolbar, blue selection and standard controls, light separators, neutral document canvas, minimal chrome. Remove the large metrics/pipeline layout. Keep document review central.

Use real engine data. All names, candidate details, counts, and scores in the image are illustrative. Do not hardcode them. Implement the written filter rules and make every visible navigation/action functional.

Pay particular attention to these integration details:

1. Resume output is DOCX; it is not an existing PDF. Verify native DOCX preview with real files and implement a working Open/Quick Look fallback when inline rendering fails.
2. Keep unsaved answer drafts across polling/tab changes and prevent silent loss during navigation.
3. Abort Fill in Chrome if saving edits fails. Persist explicit confirmation of an unchanged uncertain answer correctly; the current server skips unchanged values.
4. `ApplicationSummary` omits the saved job description; add a narrow authenticated detail API/contract if required for Job posting.
5. Job start responses do not imply completion. Observe actual search/verify/enrich/prepare progress and failure; keep these actions explicit.
6. My profile and Base resume can use simple native markdown editors backed by the existing knowledge API. The canonical resume and experience bank are different files.
7. The user reviews and presses Submit in Chrome. Never auto-submit or equate filling with submission.

Follow the implementation order and acceptance checklist in `BUILD_SPEC.md`. Use your judgment for component names and native platform details. Make small, maintainable changes; avoid adding a UI framework or rewriting the backend. If schemas change, regenerate contracts rather than editing generated files.

Run `npm run macos:test`. If engine/contracts change, also run `npm run typecheck`, `npm test`, and `npm run contracts:check`. Add focused checks for meaningful new logic, inspect the running app visually, and report what changed, validation performed, screenshots, and any remaining limitations. Continue through implementation and verification rather than stopping at a plan.
