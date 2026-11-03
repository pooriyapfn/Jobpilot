import SwiftUI

/// The job description as saved: cleaned of markup, with headings, paragraphs and bullets, plus a link to the original.
/// Comes from the job's own record; an application whose job was removed falls back to the description saved with it.
struct PostingTabView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    let id: String
    let job: JobListing?
    let app: ApplicationSummary?

    var body: some View {
        content.task(id: id) { if job == nil { await store.loadDetail(id) } }
    }

    private enum Loaded { case loading, text(String), failed(String) }

    private var loaded: Loaded {
        if job != nil {
            switch store.listingDetails[id] {
            case nil, .loading: return .loading
            case let .failed(m): return .failed(m)
            case let .loaded(d): return .text(d.description)
            }
        }
        switch store.details[id] {
        case nil, .loading: return .loading
        case let .failed(m): return .failed(m)
        case let .loaded(d): return .text(d.jd)
        }
    }

    @ViewBuilder private var content: some View {
        switch loaded {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("Couldn't load the posting", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { job != nil ? await store.loadListingDetail(id, force: true) : await store.loadDetail(id) } }
                openButton
            }
        case let .text(text):
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ContentUnavailableView {
                    Label("No description saved", systemImage: "doc.plaintext")
                } description: {
                    Text("JobPilot couldn't read this posting. The original page has it.")
                } actions: { openButton }
            } else {
                ScrollView {
                    PostingText(text: text)
                        .frame(maxWidth: 720, alignment: .leading)
                        .padding(.horizontal, 24).padding(.vertical, 12)
                        .frame(maxWidth: .infinity)
                }
            }
        }
    }

    @ViewBuilder private var openButton: some View {
        if let url = job?.postingURL ?? app?.postingURL { Button("Open Job Posting") { openURL(url) } }
    }
}
