import SwiftUI

/// Find jobs: search → verify → enrich, started only by an explicit click and watched to completion.
struct FindJobsSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var run = PipelineRun.findJobs()

    var body: some View {
        PipelineSheetFrame(run: run, title: "Find jobs", close: { dismiss() }) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Searches job boards, checks that postings are live and recent, then keeps the ones you're eligible for from your location.")
                if store.info?.hasBraveKey == false { requirement("Add BRAVE_API_KEY to .env.local in your data folder to search.") }
                if store.info?.hasOpenrouterKey == false { requirement("Add OPENROUTER_API_KEY to .env.local in your data folder for the eligibility check.") }
            }
        } primary: {
            Button("Start Search") { store.run(run) }
                .disabled(store.info?.hasBraveKey == false)
        } afterSuccess: {
            Button("Show Jobs") { store.section = .jobs; dismiss() }
            Button("Prepare Eligible Jobs…") { dismiss(); Task { @MainActor in store.sheet = .prepare } }
        }
        .environment(store)
        .onChange(of: run.phase) { if run.phase == .running { store.errorMessage = nil } }
    }

    private func requirement(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).font(.callout)
    }
}

/// Prepare: tailor resumes and draft answers for new eligible jobs. Uses paid model calls, so it asks first.
struct PrepareSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var run: PipelineRun?
    @State private var jobs: [EligibleJob]?
    @State private var loadError: String?
    @State private var limit = 10

    private var newJobs: [EligibleJob] { (jobs ?? []).filter { $0.applicationStatus == nil } }

    var body: some View {
        PipelineSheetFrame(run: run ?? .prepare(limit: nil), title: "Prepare eligible jobs", close: { dismiss() }) {
            intro
        } primary: {
            Button("Prepare \(min(limit, newJobs.count)) Job\(min(limit, newJobs.count) == 1 ? "" : "s")") {
                let run = PipelineRun.prepare(limit: limit)
                self.run = run
                store.run(run)
            }
            .disabled(newJobs.isEmpty || store.info?.hasOpenrouterKey == false)
        } afterSuccess: {
            Button("Show Ready to Review") { store.section = .applications(.ready); dismiss() }
        }
        .task { await load() }
    }

    @ViewBuilder private var intro: some View {
        if let loadError {
            Label(loadError, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
        } else if let jobs {
            VStack(alignment: .leading, spacing: 10) {
                let known = jobs.count - newJobs.count
                Text(summary(total: jobs.count, new: newJobs.count, known: known))
                if !newJobs.isEmpty {
                    Stepper(value: $limit, in: 1...newJobs.count) { Text("Prepare up to \(limit)") }
                    Text("Each job uses your OpenRouter key for resume tailoring and form answers, which costs money.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                if store.info?.hasOpenrouterKey == false {
                    Label("Add OPENROUTER_API_KEY to .env.local in your data folder first.", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange).font(.callout)
                }
            }
        } else {
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Checking eligible jobs…") }
        }
    }

    private func summary(total: Int, new: Int, known: Int) -> String {
        if total == 0 { return "No eligible jobs yet. Run Find jobs first." }
        if new == 0 { return "All \(total) eligible jobs already have an application." }
        return "\(new) new eligible job\(new == 1 ? "" : "s")" + (known > 0 ? ", \(known) already prepared or reviewed." : ".")
    }

    private func load() async {
        do {
            jobs = try await store.eligibleJobs()
            limit = max(1, min(10, newJobs.count))
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// Shared layout: intro → progress → result, with Cancel / Retry / Done in the footer.
private struct PipelineSheetFrame<Intro: View, Primary: View, After: View>: View {
    @Environment(AppStore.self) private var store
    let run: PipelineRun
    let title: String
    let close: () -> Void
    @ViewBuilder let intro: Intro
    @ViewBuilder let primary: Primary
    @ViewBuilder let afterSuccess: After

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.title2.weight(.semibold))
            switch run.phase {
            case .ready: intro
            case .running, .finished: progress
            }
            Spacer(minLength: 0)
            footer
        }
        .padding(24)
        .frame(width: 480, height: 360)
        .interactiveDismissDisabled(run.phase == .running)
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(run.steps) { step in
                HStack(spacing: 8) {
                    icon(step.state).frame(width: 18)
                    Text(step.title)
                    Spacer()
                }
            }
            if run.phase == .running, !run.logTail.isEmpty {
                Text(run.logTail.suffix(3).joined(separator: "\n"))
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(3).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
            }
            if let failure = run.failure {
                Text(failure).font(.callout).foregroundStyle(.red).textSelection(.enabled).lineLimit(4)
            } else if run.wasCancelled {
                Text("Cancelled. Nothing after this step was run.").font(.callout).foregroundStyle(.secondary)
            } else if run.phase == .finished {
                Text("Done.").font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func icon(_ state: PipelineRun.StepState) -> some View {
        switch state {
        case .pending: Image(systemName: "circle").foregroundStyle(.tertiary)
        case .running: ProgressView().controlSize(.small)
        case .succeeded: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        case .cancelled: Image(systemName: "minus.circle.fill").foregroundStyle(.secondary)
        }
    }

    private var footer: some View {
        HStack {
            Spacer()
            switch run.phase {
            case .ready:
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                primary.keyboardShortcut(.defaultAction)
            case .running:
                Button("Cancel Run") { store.cancel(run) }
            case .finished:
                if run.succeeded {
                    afterSuccess
                } else {
                    Button("Try Again") { store.run(run) }
                }
                Button("Done", action: close).keyboardShortcut(.defaultAction)
            }
        }
    }
}
