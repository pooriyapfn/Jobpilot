import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Group {
            switch store.engine.state {
            case .running:
                ApplicationsView()
            case .stopped, .starting:
                ProgressView("Starting engine…")
            case let .failed(message):
                EngineFailedView(message: message)
            }
        }
        .frame(minWidth: 760, minHeight: 440)
        .toolbar {
            ToolbarItem(placement: .navigation) { EngineBadge() }
            ToolbarItem {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.refresh() } }
                    .keyboardShortcut("r")
                    .disabled(store.engine.state != .running)
            }
        }
        .navigationTitle("JobPilot")
    }
}

private struct EngineBadge: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        let (text, tint): (String, Color) = switch store.engine.state {
        case .running: ("Engine running", .green)
        case .starting, .stopped: ("Starting…", .orange)
        case .failed: ("Engine stopped", .red)
        }
        Label(text, systemImage: "circle.fill")
            .labelStyle(.titleAndIcon)
            .font(.caption)
            .foregroundStyle(tint)
    }
}

private struct EngineFailedView: View {
    @Environment(AppStore.self) private var store
    let message: String

    var body: some View {
        VStack(spacing: 12) {
            ContentUnavailableView {
                Label("The engine didn't start", systemImage: "exclamationmark.octagon")
            } description: {
                Text(message).textSelection(.enabled)
            } actions: {
                Button("Try again") { Task { await store.restart() } }
            }
            if !store.engine.logLines.isEmpty {
                ScrollView {
                    Text(store.engine.logLines.joined(separator: "\n"))
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 140)
                .padding(8)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
                .padding(.horizontal)
            }
        }
    }
}
