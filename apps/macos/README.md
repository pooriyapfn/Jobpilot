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
  JobPilotApp.swift            @main, activation, shutdown
  Engine/                      EngineLocator (node + script), EngineProcess (lifecycle), EngineClient (typed HTTP)
  Features/
    RootView.swift             engine states, toolbar
    Applications/              AppStore, table, detail inspector, AnswerEditor, AnswerDraft
  Contracts/Generated/         generated — never edit (npm run contracts)
```

Not yet: pipeline runs from the UI, knowledge editor, Keychain settings (Phase 6); a signed `.app` with bundled Node (Phase 7).
