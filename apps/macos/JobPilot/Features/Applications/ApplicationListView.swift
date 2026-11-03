import SwiftUI

/// The middle pane: a compact, searchable queue for the current sidebar filter.
struct ApplicationListView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store
        let rows = store.visibleApplications
        let hasSearch = !store.searchText.trimmingCharacters(in: .whitespaces).isEmpty
        List(selection: $store.selection) {
            ForEach(rows) { ApplicationRow(app: $0) }
        }
        .listStyle(.inset)
        .overlay { emptyState(rows: rows, hasSearch: hasSearch) }
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer(count: rows.count) }
        .accessibilityLabel("Applications")
    }

    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(store.currentFilter.title).font(.title3.weight(.semibold))
                Text("\(store.count(store.currentFilter))")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7).padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            if let error = store.errorMessage {
                ErrorBanner(text: error) { store.errorMessage = nil }
            }
        }
        .background(.background)
    }

    private func footer(count: Int) -> some View {
        HStack {
            Text(count == 1 ? "1 application" : "\(count) applications")
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.bar)
    }

    @ViewBuilder private func emptyState(rows: [ApplicationSummary], hasSearch: Bool) -> some View {
        if !store.hasLoaded {
            ProgressView("Loading applications…")
        } else if rows.isEmpty {
            if store.applications.isEmpty {
                ContentUnavailableView {
                    Label("No applications yet", systemImage: "tray")
                } description: {
                    Text("Find jobs, then prepare the ones that fit. Each gets a tailored resume and drafted answers.")
                } actions: {
                    Button("Find jobs…") { store.sheet = .findJobs }
                    Button("Prepare eligible jobs…") { store.sheet = .prepare }
                }
            } else if hasSearch {
                ContentUnavailableView {
                    Label("No matches", systemImage: "magnifyingglass")
                } description: {
                    Text("Nothing in \(store.currentFilter.title) matches “\(store.searchText)”.")
                } actions: {
                    Button("Clear Search") { store.searchText = "" }
                }
            } else {
                ContentUnavailableView {
                    Label("Nothing here", systemImage: store.currentFilter.symbol)
                } description: {
                    Text("No applications are in \(store.currentFilter.title).")
                } actions: {
                    if store.currentFilter != .all {
                        Button("Show All Applications") { store.section = .applications(.all) }
                    }
                }
            }
        }
    }
}

private struct ApplicationRow: View {
    let app: ApplicationSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(app.company).font(.system(size: 13, weight: .semibold)).lineLimit(1)
            Text(app.title).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: 5) {
                Image(systemName: app.needsAttention ? "exclamationmark.circle.fill" : "circle.fill")
                    .font(.system(size: app.needsAttention ? 9 : 6))
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                Text(app.listStatusText).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .padding(.top, 1)
        }
        .padding(.vertical, 4)
        .tag(app.id)
        .accessibilityElement(children: .combine)
    }

    private var tint: Color {
        if app.needsAttention { return .orange }
        return app.status == .prepared ? .green.opacity(0.6) : app.status.tint
    }
}

struct ErrorBanner: View {
    let text: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            Text(text).font(.caption).lineLimit(3).textSelection(.enabled)
            Spacer(minLength: 4)
            Button("Dismiss", action: dismiss).buttonStyle(.link).font(.caption)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(Color.red.opacity(0.10))
    }
}
