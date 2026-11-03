import SwiftUI

/// Paste a job URL: the engine reads the page, takes the title, company and date, checks eligibility, and adds it to the repository.
struct AddLinkSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var adding = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Add link manually").font(.title2.weight(.semibold))
            Text("Paste the address of a job posting. JobPilot reads the page, checks it the way a search result is checked, and adds it to your jobs.")
                .foregroundStyle(.secondary)
            TextField("https://…", text: $link)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .disabled(adding)
                .onSubmit(add)
                .autocorrectionDisabled()
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
            Spacer(minLength: 0)
            HStack {
                if adding { ProgressView().controlSize(.small); Text("Reading the posting…").foregroundStyle(.secondary) }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(adding)
                Button("Add Job", action: add)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(adding || link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 480, height: 250)
        .interactiveDismissDisabled(adding)
        .onAppear { focused = true; prefillFromClipboard() }
    }

    /// A copied web link is probably the one you came to add.
    private func prefillFromClipboard() {
        guard link.isEmpty, let text = NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased()), url.host != nil else { return }
        link = text
    }

    private func add() {
        let text = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !adding, !text.isEmpty else { return }
        adding = true
        error = nil
        Task {
            do {
                try await store.addLink(text)
                dismiss()
            } catch {
                self.error = error.localizedDescription
                adding = false
            }
        }
    }
}
