import SwiftUI

@main
struct JobPilotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    private let store = AppStore.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .task { await store.start() }
        }
        .defaultSize(width: 1360, height: 900)

        Settings {
            SettingsView().environment(store)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Running as a bare SwiftPM executable (no .app bundle yet): behave like a normal app.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Unsaved edits are never dropped silently on quit.
    @MainActor func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard AppStore.shared.hasUnsavedChanges else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "You have unsaved changes"
        alert.informativeText = "Answers or documents you edited haven't been saved. Quitting now discards them."
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Quit Anyway")
        return alert.runModal() == .alertSecondButtonReturn ? .terminateNow : .terminateCancel
    }

    @MainActor func applicationWillTerminate(_ notification: Notification) {
        AppStore.shared.shutdown()
    }
}
