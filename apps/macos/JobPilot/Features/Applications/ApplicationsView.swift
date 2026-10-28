import SwiftUI

struct ApplicationsView: View {
    @Environment(AppStore.self) private var store
    @State private var sortOrder = [KeyPathComparator(\ApplicationSummary.updatedAt, order: .reverse)]

    var body: some View {
        @Bindable var store = store
        let rows = store.applications.sorted(using: sortOrder)
        VStack(spacing: 0) {
            Banners()
            if rows.isEmpty {
                ContentUnavailableView(
                    "Nothing prepared yet",
                    systemImage: "tray",
                    description: Text("Run the pipeline from the terminal for now:\nnpm run prepare-jobs")
                )
            } else {
                Table(rows, selection: $store.selection, sortOrder: $sortOrder) {
                    TableColumn("Company", value: \.company)
                    TableColumn("Role", value: \.title)
                    TableColumn("Fit", value: \.fitText).width(min: 60, ideal: 90)
                    TableColumn("ATS", value: \.atsSortKey) { Text($0.atsText) }.width(50)
                    TableColumn("Needs you") { app in
                        if app.needsYou > 0 { Text("\(app.needsYou)").foregroundStyle(.orange) } else { Text("—").foregroundStyle(.secondary) }
                    }.width(70)
                    TableColumn("Status", value: \.status.rawValue) { StatusPill(status: $0.status) }.width(min: 80, ideal: 100)
                }
            }
        }
        .inspector(isPresented: Binding(get: { store.selected != nil }, set: { if !$0 { store.selection = nil } })) {
            if let app = store.selected {
                ApplicationDetail(app: app)
                    .id(app.id)
                    .inspectorColumnWidth(min: 360, ideal: 460, max: 700)
            }
        }
    }
}

/// Engine / Chrome / error messages above the table.
private struct Banners: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            if let error = store.errorMessage {
                banner(error, systemImage: "exclamationmark.triangle.fill", tint: .red) {
                    Button("Dismiss") { store.errorMessage = nil }
                }
            }
            if store.info?.chromeReachable == false {
                banner("The job Chrome isn't running — it's needed to fill forms.", systemImage: "globe", tint: .orange) {
                    Button("Start Chrome") { Task { await store.startChrome() } }
                }
            }
        }
    }

    private func banner(_ text: String, systemImage: String, tint: Color, @ViewBuilder trailing: () -> some View) -> some View {
        HStack {
            Label(text, systemImage: systemImage).foregroundStyle(tint)
            Spacer()
            trailing()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(tint.opacity(0.10))
    }
}
