# Implementation specification

## 1. Outcome

Replace the current full-width application table and optional inspector with the approved native three-pane workspace. Keep JobPilot's real engine-driven workflow and answer editing behavior. Make the default experience useful for reviewing prepared applications, without dashboard clutter.

Priority order: correct data and actions → native macOS behavior → visual fidelity to `reference.png` → small polish details. Use normal SwiftUI/AppKit controls where they serve the design. The screenshot is a visual target, not a demand to hand-draw standard Mac controls.

## 2. Window and layout

Use a resizable native window with the system titlebar, traffic lights, toolbar, and sidebar toggle. Do not draw replacement traffic lights or embed a web dashboard.

| Region | Suggested starting size | Content |
| --- | --- | --- |
| Sidebar | 210 pt; adjustable roughly 180–260 pt | Application filters, Library, Settings. |
| Application list | 340 pt; adjustable roughly 280–400 pt | Compact searchable queue. |
| Detail | Remaining width; aim for 600+ pt | Job header, tabs, document/answers/posting, action footer. |

Start around 1360 × 900 pt. At approximately 1080 × 700 pt, allow sidebar collapse and internal document scrolling; keep the main action and answer controls usable. These values are starting points, not fixed pixel requirements. Prefer `NavigationSplitView` with standard split dividers and preserved column widths.

Toolbar: modest `Applications` title, search field, refresh action, and a compact `Find jobs` control with an action menu. Avoid the prior concept's oversized page title, slogan, big metric strip, pipeline stepper, and breadcrumb.

## 3. Visual language

- SF system typography; regular body controls around 13–14 pt, selected job title around 20–22 pt.
- Semantic system backgrounds, separators, label colors, and accent color. Default accent: system blue.
- Sidebar material should resemble a native Mac sidebar; list is a quiet surface; document canvas is a subtle gray.
- Standard blue selection/focus treatment, restrained thin monochrome SF Symbols, small native buttons.
- Amber indicates answers requiring attention; green connection status is small and labeled in text.
- Avoid large colored avatars, decorative cards, gradients, heavy shadows, and oversized pills.
- Give the white document page a subtle shadow; let the surrounding application chrome remain flat.
- Support the system appearance and increased contrast. A resume page may remain paper-white in dark appearance, with readable document text.

## 4. Sidebar and count rules

Sidebar structure:

```text
JobPilot

Applications
  All applications       count
  Ready to review        count
  Needs your input       count
  Submitted              count

Library
  My profile
  Base resume

Settings
```

Use these exact filter definitions for the first implementation:

| Filter | Included data |
| --- | --- |
| All applications | Every `ApplicationSummary` returned by the engine, including non-ready states. |
| Ready to review | `status == prepared`. |
| Needs your input | Prepared applications where `needsYou > 0`; this is a subset of Ready to review. |
| Submitted | `status == submitted`. |

Counts are computed from engine data before applying the toolbar search. They are not added together as disjoint totals. The mockup's 30 total / 12 ready / 3 needing input / 18 submitted are illustrative.

Retain `ApplicationSummary.needsYou` semantics: exclude file fields; count missing, empty, or unconfident answers. Do not show uncertain answers as reviewed just because their field is visible.

Default to Ready to review when it has entries; otherwise show All applications. Do not invent new persisted statuses. Manual, blocked, error, filling, closed, skipped, and not-a-fit applications remain accessible in All applications with honest state labels and relevant actions.

## 5. Application list

Each row has company, role, and one short secondary line: `Ready`, `1 answer to review`, or the applicable state. Keep attention icons small and pair them with text. No table headers or per-row logo decoration are needed.

Sort newest `updatedAt` first, with a stable tie-breaker. Search company and title case-insensitively within the active filter. Use the application ID for selection; preserve it through polling, sorting, and search when still visible. Clear selection and show a useful detail placeholder when it is no longer visible. Do not jump between rows on every poll.

Use native keyboard navigation, visible focus, and an unobtrusive result count footer. Long company names and titles should truncate or wrap gracefully. Loading, empty results, and failures need explicit states.

## 6. Selected application

Header: company, role, qualitative fit when available, and `ATS keyword score N/100` when available. Show missing values gracefully. ATS is a keyword score, not a hiring probability. Include actions to open the real posting URL and access secondary application actions.

Tabs: `Resume`, `Answers`, `Job posting`. Default to Resume on a new selection. Answers has a small count/indicator when attention is required. A slim `1 answer needs your review` notice includes a Review action that selects Answers and focuses or scrolls to the first unresolved field. Hide the notice when no input is needed.

Keep the job header, tab bar, and action footer stable while the selected tab's content scrolls.

### Resume tab

Show the actual tailored artifact referenced by `resumePath`, its actual filename, a modest export action, and a document preview. Fit-to-width can be the default. Only show zoom controls if implemented.

Current output is DOCX, not PDF. The engine provides `resumePath`, `/resume/:id` streams the DOCX, and the existing app opens local files with `NSWorkspace`. The inline paper view in the mockup is a new UI requirement, not an existing PDF endpoint.

Use a native preview integration capable of DOCX, such as an AppKit Quick Look view bridged into SwiftUI, and verify its behavior with real generated files on supported macOS. `PDFKit` alone cannot display a DOCX. Do not assume a PDF already exists or introduce a cloud converter. If inline rendering is unsupported or fails, show the real file with working Open/Quick Look and Save a Copy actions, plus a short explanation. Do not show a fabricated resume or silently substitute a different artifact.

Handle absent, deleted, and unreadable files. Export should use a native save panel and preserve the DOCX. No resume regeneration should happen simply by selecting a row.

### Answers tab

Reuse the current field-type behavior and `AnswerDraft` merge semantics. Textareas remain multiline; selects/radios expose their options; checkboxes stay boolean; required fields remain identified. Highlight unresolved fields subtly.

Provide Save answers with dirty/saving/error feedback. Preserve unsaved edits across engine polls and tab switches. When switching to another application or Library view, retain drafts by application ID or offer a native Save/Discard/Cancel decision; never silently discard them.

Before Fill in Chrome, persist edits successfully. Abort filling on save failure and keep edits intact. The existing `applyNow()` awaits `save()` but does not inspect its success: fix that behavior when integrating the redesigned action.

Allow users to explicitly confirm an already-correct uncertain value. The current server save handler skips unchanged values; confirming such a value therefore needs a narrow, explicit backend/API behavior rather than just clearing the warning in local state. Preserve answer memory semantics and test this case if changing the route/contract.

### Job posting tab

Show the actual saved job description, when available, as readable selectable text, plus Open original posting. `ApplicationSummary` omits `jd`; the underlying `Application` has it. Add a small authenticated detail endpoint and generated contract if needed to retrieve it by ID. Avoid returning all full descriptions in the list payload.

If saved text is empty/unavailable, show that state and a working link to the posting. Do not invent posting content or rely on scraping external pages every time the tab opens.

## 7. Fill and status actions

The detail footer has a small Chrome connection indicator, one standard `Fill in Chrome` primary button, and quiet `You review and submit.` helper text.

- Get Chrome state from `EngineInfo.chromeReachable`.
- If disconnected, provide Start Chrome via the existing `chrome` job; refresh connection state afterward. Explain the disabled fill action.
- Reuse `canApply`, `canMarkSubmitted`, and `canSkip` state rules rather than making every row fillable.
- Submit edits successfully before calling `/api/apply/:id`.
- Prevent duplicate fill requests while initiation is in flight and respect the subsequent `filling` state.
- A successful apply request starts work; it does not prove the form was submitted. Keep polling for actual state/error changes.
- When supported by status, expose `Mark submitted` and `Skip` as secondary actions, such as the header menu.
- Never auto-submit forms, and never mark an application submitted just because the user clicked Fill.

## 8. Supporting navigation and toolbar

Keep the main screen minimal, but make its visible controls functional:

- **Find jobs:** invoke the existing search → verify → enrich sequence in order, after an explicit user action. Verify each task succeeded before starting the next. Use a small native progress sheet or inline progress area; support error/retry/cancel. Avoid a permanent pipeline dashboard.
- **Preparation:** expose `Prepare eligible jobs…` in the toolbar menu. Fetch `/api/eligible-jobs`, distinguish already-known applications from new jobs, offer a batch limit, then start the existing prepare task. Refresh applications after completion. Do not silently trigger paid model calls on launch or preview.
- **My profile:** a modest native editor for `knowledge/profile.md`, with load/save/error/dirty handling, using the existing knowledge API. This file is markdown, so a simple labeled text editor is preferable to a speculative form schema.
- **Base resume:** edit/open the actual canonical `knowledge/resume/main_resume.md`; label it clearly. The experience bank `resume/base_resume.md` is a separate source, so expose it separately if needed rather than confusing the two.
- **Settings:** a compact native settings window exposing existing connection/configuration status and useful actions such as Open data folder or Restart engine. Do not add API-key editing unless storage and engine reload behavior are actually implemented; never display secret values.

Extend `EngineClient` for knowledge read/write and job status/cancel/events as needed. Existing start-job support does not itself observe completion. Poll `/api/jobs/:id` or consume its event stream; handle HTTP 409 for a task already running. Preserve authentication and loopback transport.

## 9. Existing code and API map

Paths below are relative to the `jobpilot/` repo root. Inspect the current files before modifying them.

| File | Current responsibility / likely work |
| --- | --- |
| `apps/macos/JobPilot/JobPilotApp.swift` | Window scene and lifecycle; native settings/window changes. |
| `apps/macos/JobPilot/Features/RootView.swift` | Engine states and toolbar; workspace shell. |
| `apps/macos/JobPilot/Features/Applications/ApplicationsView.swift` | Current table/inspector; replace with list-based split workspace. |
| `apps/macos/JobPilot/Features/Applications/ApplicationDetail.swift` | Header, answer draft, save/fill/status actions; introduce detail tabs/footer. |
| `apps/macos/JobPilot/Features/Applications/AppStore.swift` | Shared observable state, engine, three-second polling; extend selection/filter/draft/run state. |
| `apps/macos/JobPilot/Features/Applications/ApplicationSummary+UI.swift` | `needsYou`, action eligibility, labels, file/posting URLs. |
| `apps/macos/JobPilot/Features/Applications/AnswerEditor.swift` | Existing field controls and uncertainty styling. |
| `apps/macos/JobPilot/Features/Applications/AnswerDraft.swift` | Dirty edits and poll-safe rebasing. |
| `apps/macos/JobPilot/Engine/EngineClient.swift` | Typed authenticated HTTP; add narrowly needed methods. |
| `packages/contracts/src/{application,api,engine,jobs,knowledge}.ts` | Source schemas for engine/app boundary. |
| `packages/engine/src/server/routes.ts` | Applications, answers, status, resume, pipeline, knowledge routes. |
| `packages/engine/src/server/knowledge.ts` | Safe knowledge-path resolution and atomic writes. |
| `apps/macos/Tests/JobPilotTests/JobPilotTests.swift` | Existing Swift tests. |

Available routes: `GET /api/info`, `GET /api/apps`, `GET /api/eligible-jobs`; `POST /api/apply/:id`, `/api/answers/:id`, `/api/status/:id`; `GET /resume/:id`; `GET/POST /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`, `GET /api/jobs/:id/events`; `GET /api/knowledge`, `GET/PUT /api/knowledge/file?path=…`.

Generated files under `apps/macos/JobPilot/Contracts/Generated/` and `packages/contracts/schema/` must be regenerated from source schemas. Preserve knowledge path validation and answer learning behavior. Keep new views small and cohesive; proposed view names are implementation choices.

## 10. States and accessibility

- Engine starting: restrained native progress; failed: useful error and Retry, with optional logs disclosure.
- No applications: brief explanation, Find jobs action, and preparation action when eligible jobs exist.
- No filter/search matches: contextual empty state; clear search/reset filter action.
- No selection: calm detail placeholder; never leave a stale job's primary action visible.
- Missing resume, missing scores, disconnected Chrome, save failure, job failure: inline actionable feedback.
- Standard keyboard list movement; Cmd-F search; Cmd-R refresh; Cmd-S saves the current dirty editor. Respect existing shortcuts and avoid conflicting handlers.
- VoiceOver labels for icon-only actions; communicate selection, attention, and connection status without color alone.
- Preserve meaningful focus and scroll position while polling. Avoid one network task per row or renderer reload on every poll.

## 11. Implementation order

1. Build the native shell, filters, search, list selection, and detail tabs against existing live data.
2. Integrate actual DOCX preview/export, answer editing, safe save-then-fill, and status actions.
3. Connect supporting Library/Settings views and explicit search/preparation actions.
4. Handle failure/empty states, resizing, keyboard use, accessibility, and appearance.
5. Compare the running app against `reference.png`; adjust hierarchy, density, and spacing.

## 12. Acceptance criteria

- [ ] App launches with its existing engine lifecycle; prepared applications appear from real data.
- [ ] Three panes, native toolbar, subtle sidebar/list selection, and document-focused detail resemble the reference.
- [ ] No oversized statistics, permanent pipeline strip, fake dataset, or decorative dashboard components in production.
- [ ] Filters/counts follow section 4; searching and polling preserve valid selection.
- [ ] Resume displays the real artifact, exports correctly, and handles unavailable preview/files gracefully.
- [ ] Review notice opens Answers; edits survive polling/tab changes and application navigation is safe.
- [ ] Failed answer save prevents filling; explicit confirmation of unchanged uncertain answers is persisted correctly.
- [ ] Posting tab shows stored description or a truthful unavailable state and original link.
- [ ] Fill uses Chrome status and existing action eligibility; submission remains a human action.
- [ ] Search/preparation progress reflects real task completion; failures and cancellation work.
- [ ] Profile, Base resume, Settings, refresh, links, and icon actions are functional.
- [ ] Layout remains usable at smaller sizes and with system appearance, keyboard, and VoiceOver.
- [ ] Run `npm run macos:test`; add focused tests for new filter/count logic and meaningful save/state regressions.
- [ ] If engine/contracts changed, run `npm run typecheck`, `npm test`, and `npm run contracts:check`.
- [ ] Inspect the running app visually; report checks performed, screenshots, and any remaining platform limitation.

Do not broaden into a web rewrite, AI chat, cover letters, email/calendar integration, interview analytics, or auto-submission. Those belong to other products or future work, not this handoff.
