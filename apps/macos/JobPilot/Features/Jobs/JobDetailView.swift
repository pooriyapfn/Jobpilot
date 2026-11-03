import SwiftUI

enum DetailTab: String, CaseIterable, Identifiable {
    case details = "Details", resume = "Resume", answers = "Answers", posting = "Job posting", notes = "Notes"
    var id: String { rawValue }
}

private enum PendingConfirm: Identifiable {
    case markApplied, removeFromJobs, deleteEverything
    var id: Self { self }
}

/// One selected job: identity, independent statuses, assessment, then Resume / Answers / Job posting / Notes and the next step.
/// Works for a job with no application yet, and for an application whose job was removed from the list.
struct JobDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    let id: String
    let context: DetailContext
    @State private var tab = DetailTab.details
    @State private var focusField: String?
    @State private var pending: PendingConfirm?

    private var app: ApplicationSummary? { store.applicationsByID[id] }
    private var job: JobListing? { store.listing(for: id) }

    var body: some View {
        let unresolved = unresolvedFields
        VStack(spacing: 0) {
            header
            VStack(spacing: 10) {
                notices(unresolved: unresolved)
                DetailTabBar(selection: $tab, attention: unresolved.count, hasNote: job?.userNote != nil)
            }
            .padding(.horizontal, 24).padding(.bottom, 12)

            tabContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()
            JobFooter(id: id, context: context, unresolved: unresolved.count) {
                tab = .answers
                focusField = unresolved.first?.id
            }
        }
        .background(.background)
        .task(id: "\(id)|\(job?.updatedAt ?? "")") { if job != nil { await store.loadListingDetail(id, force: true) } }
        .confirmationDialog(dialogTitle, isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible, presenting: pending) { kind in
            switch kind {
            case .markApplied: Button("Mark as Applied") { Task { await store.markApplied(id) } }
            case .removeFromJobs: Button("Remove from Jobs") { Task { await store.removeJob(id, scope: .listing) } }
            case .deleteEverything: Button("Delete Job and Application", role: .destructive) { Task { await store.removeJob(id, scope: .everything) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: { kind in
            Text(dialogMessage(kind))
        }
    }

    // MARK: pieces

    private var unresolvedFields: [FormField] {
        guard let app, app.canApply else { return [] }
        return store.draft(for: app).unresolved(in: app)
    }

    private var title: String { job?.title ?? app?.title ?? "" }
    private var company: String { job?.company ?? app?.company ?? "" }
    private var postingURL: URL? { job?.postingURL ?? app?.postingURL }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(company).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
                Text(title).font(.system(size: 22, weight: .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                if let job {
                    // Independent facts, side by side: eligibility, application, preparation, match.
                    HStack(spacing: 6) {
                        ApplicationStateBadge(state: job.applicationState)
                        if job.resumeReady { StatusChip(text: "Resume ready", symbol: "doc.text", tint: .blue, prominent: false) }
                        if let match = job.matchLabel { StatusChip(text: match, symbol: "scope", tint: job.matchFit == "SKIP" ? .secondary : .teal, prominent: false) }
                    }
                    .padding(.top, 2)
                    HStack(spacing: 14) {
                        JobDatesLine(listing: job)
                        if let location = job.location, !location.isEmpty {
                            Label(location, systemImage: "mappin.and.ellipse").font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                } else if let app {
                    HStack(spacing: 6) {
                        StatusPill(status: app.status)
                        Text(app.fitLabel ?? "Not scored yet").font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                }
                if let note = app?.note, !note.isEmpty, job?.matchFit != "SKIP" {
                    Label(note, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                if let url = postingURL {
                    Button { openURL(url) } label: { Label("Open in Browser", systemImage: "safari") }
                        .buttonStyle(.bordered)
                        .help("Open the job posting in your browser")
                }
                moreMenu.buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 12)
    }

    private var moreMenu: some View {
        Menu {
            if let url = postingURL {
                Button("Open Job Posting", systemImage: "safari") { openURL(url) }
                Button("Copy Link", systemImage: "link") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url.absoluteString, forType: .string)
                }
            }
            if let file = app?.resumeURL, FileManager.default.fileExists(atPath: file.path) {
                Button("Show Resume in Finder", systemImage: "folder") { NSWorkspace.shared.activateFileViewerSelecting([file]) }
            }
            if let job {
                Divider()
                Button("Reassess Eligibility", systemImage: "arrow.clockwise") { Task { await store.assessJob(job.id) } }
                if job.eligibility != .eligible { Button("Mark as Eligible", systemImage: "checkmark.circle") { Task { await store.setEligibility(job.id, .eligible) } } }
                if job.eligibility != .notEligible { Button("Mark as Not Eligible", systemImage: "xmark.circle") { Task { await store.setEligibility(job.id, .notEligible) } } }
                if job.applicationState != .submitted { Button("Mark as Already Applied…", systemImage: "checkmark.seal") { pending = .markApplied } }
            }
            if let app, app.canMarkSubmitted || app.canSkip {
                Divider()
                if app.canMarkSubmitted { Button("Mark Submitted", systemImage: "checkmark.circle") { Task { await store.setStatus(app, .submitted) } } }
                if app.canSkip { Button("Skip This Job", systemImage: "forward") { Task { await store.setStatus(app, .skipped) } } }
            }
            if context == .jobs, job != nil {
                Divider()
                Button("Remove from Jobs…", systemImage: "minus.circle") { pending = .removeFromJobs }
                if app != nil { Button("Delete Job and Application…", systemImage: "trash", role: .destructive) { pending = .deleteEverything } }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(job?.isBusy ?? false)
        .help("More actions")
        .accessibilityLabel("More actions")
    }

    @ViewBuilder private func notices(unresolved: [FormField]) -> some View {
        if let job { JobActivityNotice(listing: job) }
        if !unresolved.isEmpty { reviewNotice(count: unresolved.count, first: unresolved[0].id) }
        if let error = store.saveErrors[id], let app { saveErrorNotice(error, app: app) }
    }

    @ViewBuilder private var tabContent: some View {
        switch tab {
        case .details:
            if let job { DetailsTabView(job: job, app: app) } else {
                ContentUnavailableView("No details", systemImage: "info.circle",
                                       description: Text("This application was removed from Jobs, so it has no assessment."))
            }
        case .resume: ResumeTabView(id: id, job: job, app: app)
        case .answers:
            if let app { AnswersTabView(app: app, focusField: $focusField) } else {
                ContentUnavailableView {
                    Label("No answers yet", systemImage: "text.bubble")
                } description: {
                    Text("Generating the resume also scans the application form and drafts answers for you to review.")
                }
            }
        case .posting: PostingTabView(id: id, job: job, app: app)
        case .notes:
            if let job { NotesTabView(job: job) } else {
                ContentUnavailableView("Notes live with the job", systemImage: "note.text",
                                       description: Text("This application was removed from Jobs, so it has no notes."))
            }
        }
    }

    // MARK: dialogs

    private var dialogTitle: String {
        switch pending {
        case .markApplied: "Mark “\(title)” as already applied?"
        case .removeFromJobs: "Remove “\(title)” from Jobs?"
        case .deleteEverything: "Delete “\(title)” and its application?"
        case nil: ""
        }
    }

    private func dialogMessage(_ kind: PendingConfirm) -> String {
        switch kind {
        case .markApplied: "Records today as the date you applied and moves the application to Submitted. Use this only if you really applied."
        case .removeFromJobs: "It leaves your jobs list. Its application, tailored resume and history are kept, and searches won't add it back."
        case .deleteEverything: "Permanently deletes the application, the drafted answers and the tailored resume files. This can't be undone, and searches won't add the job back."
        }
    }

    // MARK: notices

    private func reviewNotice(count: Int, first: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
            Text(count == 1 ? "1 answer needs your review" : "\(count) answers need your review").font(.callout)
            Spacer()
            Button("Review") { tab = .answers; focusField = first }.buttonStyle(.link)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
    }

    private func saveErrorNotice(_ message: String, app: ApplicationSummary) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            Text("Couldn't save your answers: \(message)").font(.callout).lineLimit(2).textSelection(.enabled)
            Spacer()
            Button("Try Again") { Task { await store.saveDraft(app) } }.buttonStyle(.link)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Color.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: assessment: eligibility and match, kept apart, with the detail one disclosure away

private struct DetailsTabView: View {
    @Environment(AppStore.self) private var store
    let job: JobListing
    let app: ApplicationSummary?

    private var detail: JobListingDetail? {
        if case let .loaded(d)? = store.listingDetails[job.id] { d } else { nil }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                section("Eligibility", "Hard requirements: is the job remote and open to your location.") {
                    Text(job.eligibilityReason ?? job.eligibility.meaning).textSelection(.enabled)
                    if let source = job.eligibilitySource {
                        Text("Set by \(source.label)\(job.evaluatedDate.map { " on \(JobDate.compact($0))" } ?? "").").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let match = job.matchLabel {
                    section("Match", "How well your profile fits this role. It never changes eligibility.") {
                        Text([match, app?.atsScore.map { "ATS keyword score \(Int($0.rounded()))/100" }].compactMap { $0 }.joined(separator: " · ")).fontWeight(.medium)
                        if let notes = detail?.matchNotes, !notes.isEmpty { Text(notes).textSelection(.enabled) }
                    }
                }
            }
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24).padding(.vertical, 8)
        }
    }

    private func section(_ title: String, _ caption: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            Text(caption).font(.caption).foregroundStyle(.secondary)
            content()
        }
    }
}

// MARK: activity: what the engine is doing, as it reports it, and what went wrong

struct JobActivityNotice: View {
    @Environment(AppStore.self) private var store
    let listing: JobListing

    var body: some View {
        if let activity = listing.activity {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                VStack(alignment: .leading, spacing: 1) {
                    Text(activity.title).font(.callout.weight(.medium))
                    Text(listing.activityStep ?? activity.defaultStep).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(Color.accentColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityElement(children: .combine)
        } else if let error = store.activityError(for: listing) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                Text(error).font(.callout).lineLimit(5).textSelection(.enabled)
                Spacer()
                Button("Dismiss") { store.dismissActivityError(listing) }.buttonStyle(.link)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(Color.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

// MARK: tabs

private struct DetailTabBar: View {
    @Binding var selection: DetailTab
    let attention: Int
    let hasNote: Bool

    var body: some View {
        HStack(spacing: 2) {
            ForEach(DetailTab.allCases) { tab in
                Button { selection = tab } label: {
                    HStack(spacing: 5) {
                        Text(tab.rawValue)
                        if tab == .answers, attention > 0 {
                            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange).imageScale(.small)
                            Text("\(attention)").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        if tab == .notes, hasNote { Circle().fill(.secondary).frame(width: 5, height: 5) }
                    }
                    .font(.system(size: 13, weight: selection == tab ? .medium : .regular))
                    .frame(maxWidth: .infinity, minHeight: 24)
                    .background {
                        if selection == tab {
                            RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .controlBackgroundColor))
                                .shadow(color: .black.opacity(0.15), radius: 1, y: 0.5)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == tab ? [.isSelected] : [])
                .accessibilityLabel(label(for: tab))
            }
        }
        .padding(2)
        .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private func label(for tab: DetailTab) -> String {
        if tab == .answers, attention > 0 { return "Answers, \(attention) need review" }
        if tab == .notes, hasNote { return "Notes, has a note" }
        return tab.rawValue
    }
}
