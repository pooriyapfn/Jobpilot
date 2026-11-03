import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Group {
            switch store.engine.state {
            case .running:
                WorkspaceView()
            case .stopped, .starting:
                ProgressView("Starting engine…")
            case let .failed(message):
                EngineFailedView(message: message)
            }
        }
        .navigationTitle("JobPilot")
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
