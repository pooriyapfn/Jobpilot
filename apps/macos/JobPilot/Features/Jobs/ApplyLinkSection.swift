import SwiftUI

/// The page with the real application form, for postings whose own link only redirects (job boards, aggregators).
/// Saving it scans the form and drafts answers there. The posting's own link stays, so both are used to spot duplicates.
struct ApplyLinkSection: View {
    @Environment(AppStore.self) private var store
    let job: JobListing
    @State private var text = ""

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasKey: Bool { store.info?.hasOpenrouterKey ?? true }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Application link").font(.headline)
            Text("If the posting sends you to another site, paste the page with the form here. JobPilot scans it and drafts the answers. The original link is kept to catch duplicates.")
                .font(.callout).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                TextField("https://…", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
                    .onSubmit(scan)
                Button(job.applyUrl == nil ? "Scan form" : "Rescan", action: scan)
                    .buttonStyle(.borderedProminent)
                    .disabled(trimmed.isEmpty || job.isBusy || !hasKey)
                    .help(hasKey ? "Reads the form at this link and drafts answers. Uses your OpenRouter key." : "Add OPENROUTER_API_KEY to .env.local in your data folder.")
                if job.applyUrl != nil {
                    Button("Remove") { Task { await store.setApplyLink(job.id, "") ; text = "" } }
                        .disabled(job.isBusy)
                        .help("Forget this link. The application and answers stay.")
                }
            }
            if let url = job.postingURL {
                HStack(spacing: 6) {
                    Text("Original link").font(.caption).foregroundStyle(.secondary)
                    Link(job.url, destination: url).font(.caption).lineLimit(1).truncationMode(.middle)
                }
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
        .onAppear { text = job.applyUrl ?? "" }
        .onChange(of: job.id) { text = job.applyUrl ?? "" }
    }

    private func scan() {
        guard !trimmed.isEmpty, !job.isBusy, hasKey else { return }
        Task { await store.setApplyLink(job.id, trimmed) }
    }
}
