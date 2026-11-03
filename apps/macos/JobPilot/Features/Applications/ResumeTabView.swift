import QuickLookThumbnailing
import SwiftUI
import UniformTypeIdentifiers

/// The tailored resume the engine produced, shown as-is. Generating one is always an explicit click; a new one replaces the old
/// only when it is complete, so a failed regeneration leaves you with the resume you had.
struct ResumeTabView: View {
    @Environment(AppStore.self) private var store
    let id: String
    let job: JobListing?
    let app: ApplicationSummary?
    @State private var confirmRegenerate = false

    private enum Availability: Equatable {
        case checking, missing, unreadable, noInlinePreview, ready
    }

    @State private var availability = Availability.checking
    /// When the file last changed, so the preview reloads for a new resume but not for every answer you save.
    @State private var fileStamp: Date?

    private var busy: Bool { job?.isBusy ?? false }
    private var title: String { job?.title ?? app?.title ?? "" }
    private var company: String { job?.company ?? app?.company ?? "" }

    var body: some View {
        Group {
            if let url = app?.resumeURL {
                VStack(spacing: 0) {
                    fileBar(url)
                    Divider()
                    content(url).id(fileStamp)
                }
                // Regenerating rewrites the same file, so re-probe (and reload the preview) when the application changes.
                .task(id: "\(url.path)|\(app?.updatedAt ?? "")") {
                    fileStamp = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date
                    availability = await Self.probe(url)
                }
            } else {
                empty
            }
        }
        .confirmationDialog("Regenerate the tailored resume?", isPresented: $confirmRegenerate, titleVisibility: .visible) {
            Button("Regenerate Resume") { Task { await store.generateResume(id) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Writes a new resume from your base resume and this job's description, using your OpenRouter key. Your current resume stays in place until the new one is ready.")
        }
    }

    // MARK: no resume yet

    private var empty: some View {
        ContentUnavailableView {
            Label("No tailored resume yet", systemImage: "doc.badge.plus")
        } description: {
            Text(app == nil
                 ? "Generate a resume tailored to this job. JobPilot also scans the application form and drafts answers for you to review."
                 : "Generate a resume tailored to this job.")
        } actions: {
            generateButton
            if let reason = blockedReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
        }
    }

    private var generateButton: some View {
        Button {
            Task { await store.generateResume(id) }
        } label: {
            if busy { HStack(spacing: 6) { ProgressView().controlSize(.small); Text(job?.activityStep ?? "Working…") } }
            else { Text("Generate resume") }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(busy || blockedReason != nil)
    }

    private var blockedReason: String? {
        store.info?.hasOpenrouterKey == false ? "Add OPENROUTER_API_KEY to .env.local in your data folder first." : nil
    }

    // MARK: resume exists

    @ViewBuilder private func content(_ url: URL) -> some View {
        switch availability {
        case .checking:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            QuickLookPreview(url: url)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .missing:
            fallback(url, title: "The resume file is missing", symbol: "doc.badge.ellipsis",
                     text: "It was expected at \(url.path) but isn't there. It may have been moved or deleted.", canOpen: false, offerGenerate: true)
        case .unreadable:
            fallback(url, title: "The resume file can't be read", symbol: "lock.doc",
                     text: "JobPilot doesn't have permission to read \(url.lastPathComponent).", canOpen: false, offerGenerate: true)
        case .noInlinePreview:
            fallback(url, title: "No inline preview for this file", symbol: "doc.text",
                     text: "macOS couldn't render \(url.lastPathComponent) here. Open it in your word processor, or save a copy.", canOpen: true, offerGenerate: false)
        }
    }

    private func fileBar(_ url: URL) -> some View {
        let usable = availability != .missing && availability != .unreadable
        return HStack(spacing: 10) {
            Image(systemName: "doc.text").foregroundStyle(.secondary)
            Text(url.lastPathComponent).font(.callout).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            Spacer()
            if usable {
                // Secondary on purpose: the first resume is "Generate"; this replaces a good one.
                Button { confirmRegenerate = true } label: {
                    if busy { HStack(spacing: 5) { ProgressView().controlSize(.mini); Text("Working…") } }
                    else { Label("Regenerate", systemImage: "arrow.triangle.2.circlepath") }
                }
                .buttonStyle(.bordered).controlSize(.small)
                .disabled(busy || blockedReason != nil)
                .help(blockedReason ?? "Write a new tailored resume for this job")
            }
            Group {
                Button { NSWorkspace.shared.open(url) } label: { Image(systemName: "arrow.up.forward.app") }
                    .help("Open in the default app").accessibilityLabel("Open resume")
                Button { NSWorkspace.shared.activateFileViewerSelecting([url]) } label: { Image(systemName: "folder") }
                    .help("Reveal in Finder").accessibilityLabel("Reveal resume in Finder")
                Button { saveCopy(of: url) } label: { Image(systemName: "square.and.arrow.down") }
                    .help("Save a copy of the .docx…").accessibilityLabel("Save a copy of the resume")
            }
            .buttonStyle(.borderless)
            .disabled(!usable)
        }
        .padding(.horizontal, 24).padding(.vertical, 8)
    }

    private func fallback(_ url: URL, title: String, symbol: String, text: String, canOpen: Bool, offerGenerate: Bool) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(text).textSelection(.enabled)
        } actions: {
            if canOpen {
                Button("Open Resume") { NSWorkspace.shared.open(url) }
                Button("Save a Copy…") { saveCopy(of: url) }
            }
            if offerGenerate { generateButton }
        }
    }

    /// Native save panel; the .docx is copied byte for byte.
    private func saveCopy(of url: URL) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "docx") ?? .data]
        panel.nameFieldStringValue = "\(company) – \(title) resume.docx".replacingOccurrences(of: "/", with: "-")
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.copyItem(at: url, to: destination)
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    /// Whether the file exists, can be read, and whether macOS can render it inline.
    private static func probe(_ url: URL) async -> Availability {
        guard FileManager.default.fileExists(atPath: url.path) else { return .missing }
        guard FileManager.default.isReadableFile(atPath: url.path) else { return .unreadable }
        let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 96, height: 96), scale: 1, representationTypes: .thumbnail)
        do {
            _ = try await QLThumbnailGenerator.shared.generateBestRepresentation(for: request)
            return .ready
        } catch {
            return .noInlinePreview
        }
    }
}
