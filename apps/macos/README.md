# JobPilot for macOS

SwiftUI app (macOS 15+). It launches the engine (`packages/engine`, `engine serve`) as a child process, reads the ready line
(port + token), and talks to it over loopback HTTP with the types generated in `JobPilot/Contracts/Generated/Contracts.swift`.
The engine exits when the app does.

```
npm run macos:run      # = swift run --package-path apps/macos   (or open apps/macos in Xcode and press Run)
npm run macos:test     # unit tests + a real engine started in a temp JOBPILOT_HOME
```

Data comes from `$JOBPILOT_HOME`, default `~/Library/Application Support/JobPilot`. Dev lookup: node via a login shell
(`JOBPILOT_NODE` overrides), repo via `JOBPILOT_REPO` or by walking up from the working directory / source file.

```
JobPilot/
  JobPilotApp.swift            @main, activation, Settings scene, quit-with-unsaved-edits guard
  Engine/                      EngineLocator (node + script), EngineProcess (lifecycle), EngineClient (typed HTTP, jobs, knowledge)
  Features/
    RootView.swift             engine states
    WorkspaceView.swift        sidebar | list | detail split view, toolbar (search, refresh, Add Job menu)
    SidebarView.swift          filters + counts, Library, Settings
    Applications/              AppStore, ApplicationFilter, list, detail (Resume / Answers / Job posting), footer, AnswerDraft
    Library/                   My profile / Base resume / Experience bank markdown editors
    Jobs/                      jobs repository: list (status filter, sort), job detail, Add link sheet, I already applied / Not eligible / Delete
    Pipeline/                  Find jobs + Prepare sheets, PipelineRun (step-by-step job watcher)
    SettingsView.swift         engine / Chrome / key status (no secrets shown)
  Contracts/Generated/         generated — never edit (npm run contracts)
```

Design handoff: `design/macos-ui-v2/`. The resume preview is AppKit Quick Look (DOCX); it falls back to Open / Save a Copy when macOS can't render the file.

Not yet: Keychain-backed key editing; a signed `.app` with bundled Node (Phase 7).
