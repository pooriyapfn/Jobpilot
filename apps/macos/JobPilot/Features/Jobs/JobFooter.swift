import SwiftUI

/// Chrome status, unsaved answers, and the one dominant next step (or why there isn't one). You review and submit in Chrome.
struct JobFooter: View {
    @Environment(AppStore.self) private var store
    let id: String
    let context: DetailContext
    let unresolved: Int
    let review: () -> Void

    @State private var confirm: Confirm?
    private enum Confirm: Identifiable { case delete, applied; var id: Self { self } }

    private var app: ApplicationSummary? { store.applicationsByID[id] }
    private var job: JobListing? { store.listing(for: id) }

    var body: some View {
        let step = JobFlow.next(job: job, app: app, unresolvedAnswers: unresolved, context: context)
        let chromeUp = store.info?.chromeReachable ?? false
        HStack(alignment: .center, spacing: 14) {
            if context == .jobs, let job { jobActions(job) }
            if showsChrome(step) { chromeStatus(up: chromeUp) }
            Spacer(minLength: 8)
            if let app, store.draft(for: app).isDirty { saveCluster(app) }
            nextStep(step, chromeUp: chromeUp)
        }
        .padding(.horizontal, 24).padding(.vertical, 12)
        .background(.bar)
        .confirmationDialog(confirm == .delete ? "Delete “\(job?.title ?? "")”?" : "Mark “\(job?.title ?? "")” as applied?",
                            isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible, presenting: confirm) { kind in
            switch kind {
            case .delete: Button("Delete", role: .destructive) { Task { await store.removeJob(id, scope: .listing) } }
            case .applied: Button("Mark as Applied") { Task { await store.markApplied(id) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: { kind in
            Text(kind == .delete ? "It leaves your jobs list and searches won't add it back. Any application and tailored resume are kept."
                                 : "Records today as the date you applied. Use this only if you really applied.")
        }
    }

    /// Delete and Applied: always there, whatever the next step is.
    private func jobActions(_ job: JobListing) -> some View {
        HStack(spacing: 8) {
            Button("Delete", systemImage: "trash") { confirm = .delete }
            if job.applicationState == .submitted {
                Label("Applied", systemImage: "checkmark.seal.fill").font(.callout).foregroundStyle(.purple)
            } else {
                Button("Applied", systemImage: "checkmark.seal") { confirm = .applied }
                    .help("You already applied, here or by hand")
            }
        }
        .controlSize(.large)
        .disabled(job.isBusy)
    }

    private func showsChrome(_ step: JobNextStep) -> Bool {
        if case .action(.fillInChrome) = step { return true }
        return app?.canApply == true && (job?.eligibility ?? .eligible) == .eligible
    }

    private func chromeStatus(up: Bool) -> some View {
        HStack(spacing: 6) {
            Circle().fill(up ? Color.green : Color.orange).frame(width: 8, height: 8).accessibilityHidden(true)
            Text(up ? "Chrome connected" : "Chrome not running").font(.callout)
            if !up {
                Button(store.startingChrome ? "Starting…" : "Start Chrome") { Task { await store.startChrome() } }
                    .buttonStyle(.link).font(.callout)
                    .disabled(store.startingChrome)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func saveCluster(_ app: ApplicationSummary) -> some View {
        HStack(spacing: 8) {
            Text("Unsaved edits").font(.caption).foregroundStyle(.secondary)
            Button(store.saving.contains(app.id) ? "Saving…" : "Save answers") { Task { await store.saveDraft(app) } }
                .keyboardShortcut("s")
                .disabled(store.saving.contains(app.id))
                .help("Saved answers are remembered for future jobs")
        }
    }

    @ViewBuilder private func nextStep(_ step: JobNextStep, chromeUp: Bool) -> some View {
        switch step {
        case let .working(text):
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(text).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                markSubmittedButton
            }
        case let .unavailable(reason):
            HStack(spacing: 10) {
                Text(reason).font(.callout).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.trailing)
                markSubmittedButton
            }
        case let .action(action):
            let blocked = JobFlow.disabledReason(for: action, chromeUp: chromeUp, hasKey: store.info?.hasOpenrouterKey ?? true)
            let note = blocked ?? caption(for: action)
            HStack(spacing: 10) {
                if !note.isEmpty {
                    Image(systemName: blocked != nil ? "exclamationmark.triangle.fill" : "info.circle")
                        .foregroundStyle(blocked != nil ? .orange : .secondary)
                        .help(note)
                        .accessibilityLabel(note)
                }
                Button { perform(action) } label: {
                    HStack(spacing: 5) {
                        Text(label(for: action))
                        if action == .fillInChrome { Image(systemName: "arrow.up.right").imageScale(.small) }
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(blocked != nil || isBusyNow(action))
                .help(note.isEmpty ? help(for: action) : note)
            }
        }
    }

    /// Filling finished in Chrome only counts once a submit was confirmed. If it can't tell, you say so.
    @ViewBuilder private var markSubmittedButton: some View {
        if let app, app.canMarkSubmitted {
            Button("Mark submitted") { Task { await store.setStatus(app, .submitted) } }
                .help("Only after you've pressed Submit in Chrome")
        }
    }

    private func isBusyNow(_ action: JobAction) -> Bool {
        switch action {
        case .fillInChrome: store.filling.contains(id) || store.saving.contains(id)
        default: false
        }
    }

    private func label(for action: JobAction) -> String {
        action == .fillInChrome && store.filling.contains(id) ? "Starting…" : action.title
    }

    private func perform(_ action: JobAction) {
        switch action {
        case .analyze, .reassess: Task { await store.assessJob(id) }
        case .generateResume: Task { await store.generateResume(id) }
        case .reviewAnswers: review()
        case .fillInChrome: if let app { Task { await store.fill(app) } }
        case .viewApplication: store.viewApplication(id)
        }
    }

    private func help(for action: JobAction) -> String {
        switch action {
        case .analyze: "Read the posting and check whether it's remote and open to your location"
        case .reassess: "Look at the posting again and update the eligibility check"
        case .generateResume: app == nil ? "Tailor your resume, scan the form and draft answers. Uses your OpenRouter key." : "Write a tailored resume for this job. Uses your OpenRouter key."
        case .reviewAnswers: "Some drafted answers need your review before filling"
        case .fillInChrome: "Opens the form filled in your Chrome. You press Submit."
        case .viewApplication: "Show this job in Applications"
        }
    }

    private func caption(for action: JobAction) -> String {
        switch action {
        case .analyze: "Not checked yet."
        case .reassess:
            switch job?.eligibility {
            case .notEligible: "Marked not eligible."
            default: "Needs a look before you prepare."
            }
        case .generateResume:
            job?.matchFit == "SKIP" ? "The fit check said this isn't a match. This writes one anyway."
                : (app == nil ? "Also drafts the form answers." : "Writes a tailored resume.")
        case .reviewAnswers: "Check the highlighted answers first."
        case .fillInChrome: "You review and submit."
        case .viewApplication: "You applied to this job."
        }
    }
}
