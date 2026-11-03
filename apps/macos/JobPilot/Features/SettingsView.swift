import SwiftUI

/// Connection and configuration status, with the few actions that help. Secret values are never shown.
struct SettingsView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section("Engine") {
                LabeledContent("Status") { status }
                if let info = store.info {
                    LabeledContent("Version", value: info.version)
                    LabeledContent("Data folder") {
                        HStack {
                            Text(info.home).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                            Button("Open") { NSWorkspace.shared.open(URL(fileURLWithPath: info.home)) }
                        }
                    }
                }
                Button("Restart Engine") { Task { await store.restart() } }
            }
            Section("Connections") {
                keyRow("Brave Search key", present: store.info?.hasBraveKey)
                keyRow("OpenRouter key", present: store.info?.hasOpenrouterKey)
                LabeledContent("Chrome") {
                    if store.info?.chromeReachable == true {
                        Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        HStack {
                            Label("Not running", systemImage: "circle").foregroundStyle(.secondary)
                            Button(store.startingChrome ? "Starting…" : "Start Chrome") { Task { await store.startChrome() } }
                                .disabled(store.startingChrome || store.engine.state != .running)
                        }
                    }
                }
                if let country = store.info?.candidateCountry {
                    LabeledContent("Your country", value: country)
                }
                Text("Keys are read from .env.local in the data folder. JobPilot never displays them.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 520, height: 480)
    }

    @ViewBuilder private var status: some View {
        switch store.engine.state {
        case .running: Label("Running", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .starting, .stopped: Label("Starting…", systemImage: "circle.dotted").foregroundStyle(.orange)
        case let .failed(message): Label(message, systemImage: "xmark.octagon.fill").foregroundStyle(.red).lineLimit(2)
        }
    }

    private func keyRow(_ title: String, present: Bool?) -> some View {
        LabeledContent(title) {
            switch present {
            case true?: Label("Configured", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            case false?: Label("Missing", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            case nil: Text("—").foregroundStyle(.secondary)
            }
        }
    }
}
