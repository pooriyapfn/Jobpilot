import SwiftUI

/// The form fields the agent drafted. Edits live in the store, so they survive polling, tab changes and navigation.
struct AnswersTabView: View {
    @Environment(AppStore.self) private var store
    let app: ApplicationSummary
    var job: JobListing?
    @Binding var focusField: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let job { ApplyLinkSection(job: job) }
                    AnswerEditor(app: app, draft: draftBinding, focusField: $focusField)
                }
                    .frame(maxWidth: 720, alignment: .leading)
                    .padding(.horizontal, 24).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .onChange(of: focusField) { scroll(proxy) }
            .task { scroll(proxy) } // arrived here through "Review"
        }
    }

    private func scroll(_ proxy: ScrollViewProxy) {
        guard let id = focusField else { return }
        withAnimation { proxy.scrollTo(id, anchor: .center) }
    }

    private var draftBinding: Binding<AnswerDraft> {
        Binding(get: { store.draft(for: app) }, set: { store.drafts[app.id] = $0 })
    }
}
