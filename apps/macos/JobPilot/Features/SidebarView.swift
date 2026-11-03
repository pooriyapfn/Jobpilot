import SwiftUI

struct SidebarView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        List(selection: selection) {
            Section("Jobs") {
                row("Jobs", symbol: "briefcase", count: store.listings.count, attention: false)
                    .tag(SidebarSection.jobs)
            }
            Section("Applications") {
                ForEach(ApplicationFilter.allCases) { filter in
                    row(filter.title, symbol: filter.symbol, count: store.count(filter), attention: filter == .needsInput)
                        .tag(SidebarSection.applications(filter))
                }
            }
            Section("Library") {
                ForEach([LibraryDoc.profile, .baseResume]) { doc in
                    Label(doc.title, systemImage: doc.symbol)
                        .badge(store.editors[doc]?.isDirty == true ? Text("Edited") : nil)
                        .tag(SidebarSection.library(doc))
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) {
            Text("JobPilot")
                .font(.title3.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.bottom, 4)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button { openSettings() } label: {
                Label("Settings", systemImage: "gearshape")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
    }

    private var selection: Binding<SidebarSection?> {
        Binding(get: { store.section }, set: { if let new = $0 { store.section = new } })
    }

    private func row(_ title: String, symbol: String, count: Int, attention: Bool) -> some View {
        HStack(spacing: 6) {
            Label(title, systemImage: symbol)
            Spacer(minLength: 4)
            if attention, count > 0 {
                Circle().fill(.orange).frame(width: 7, height: 7).accessibilityHidden(true)
            }
            Text("\(count)").monospacedDigit().foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(count)")
    }
}
