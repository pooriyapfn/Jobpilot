import SwiftUI

/// Your own notes on a job. Kept apart from the posting and from the AI's assessment, saved only when you say so.
struct NotesTabView: View {
    @Environment(AppStore.self) private var store
    let job: JobListing

    var body: some View {
        let dirty = store.noteIsDirty(job)
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Your notes").font(.headline)
                Spacer()
                if let error = store.noteErrors[job.id] {
                    Label(error, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red).lineLimit(2)
                } else {
                    Text(dirty ? "Unsaved changes" : (job.userNote == nil ? "No note yet" : "Saved")).font(.caption).foregroundStyle(.secondary)
                }
                Button("Revert") { store.noteDrafts[job.id] = nil }.disabled(!dirty)
                Button(store.savingNotes.contains(job.id) ? "Saving…" : "Save Note") { Task { await store.saveNote(job) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!dirty || store.savingNotes.contains(job.id))
            }
            .controlSize(.small)
            TextEditor(text: Binding(get: { store.noteDraft(for: job) }, set: { store.noteDrafts[job.id] = $0 }))
                .font(.system(size: 13))
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                .overlay(alignment: .topLeading) {
                    if store.noteDraft(for: job).isEmpty {
                        Text("Recruiter's name, questions to ask, why you like it…").foregroundStyle(.tertiary).padding(.horizontal, 13).padding(.vertical, 8).allowsHitTesting(false)
                    }
                }
                .accessibilityLabel("Your notes about this job")
            Text("Only you see these. Searches and checks never change them.").font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 24).padding(.vertical, 12)
    }
}
