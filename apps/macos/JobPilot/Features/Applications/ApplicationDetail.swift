import SwiftUI

struct ApplicationDetail: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    let app: ApplicationSummary
    @State private var draft: AnswerDraft
    @State private var saving = false

    init(app: ApplicationSummary) {
        self.app = app
        _draft = State(initialValue: AnswerDraft(app: app))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if let note = app.note, !note.isEmpty {
                        Label(note, systemImage: "info.circle")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    Divider()
                    AnswerEditor(app: app, draft: $draft)
                }
                .padding()
            }
            Divider()
            actions.padding(12)
        }
        .onChange(of: app.updatedAt) { draft.rebase(onto: app) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(app.title).font(.title3.weight(.semibold))
                Spacer()
                StatusPill(status: app.status)
            }
            Text(app.company).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                if let url = app.postingURL {
                    Button("Open posting", systemImage: "safari") { openURL(url) }
                }
                if let url = app.resumeURL {
                    Button("Open resume", systemImage: "doc.text") { NSWorkspace.shared.open(url) }
                }
            }
            .buttonStyle(.link)
            .font(.callout)
        }
    }

    private var actions: some View {
        HStack {
            Button("Save answers") { Task { await save() } }
                .keyboardShortcut("s")
                .disabled(!draft.isDirty || saving)
            if draft.isDirty {
                Text("Saved answers are remembered for future jobs.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if app.canMarkSubmitted {
                Button("Mark submitted") { Task { await store.setStatus(app, .submitted) } }
            }
            if app.canSkip {
                Button("Skip") { Task { await store.setStatus(app, .skipped) } }
            }
            if app.canApply {
                Button("Apply in Chrome", systemImage: "paperplane.fill") { Task { await applyNow() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.info?.chromeReachable == false)
                    .help(store.info?.chromeReachable == false ? "Start the job Chrome first" : "Opens the form filled in your Chrome. You press Submit.")
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        if await store.saveAnswers(app, draft.edits) { draft.markSaved() }
    }

    /// Unsaved edits go to the engine first, so the form is filled with what you see.
    private func applyNow() async {
        if draft.isDirty { await save() }
        await store.apply(app)
    }
}
