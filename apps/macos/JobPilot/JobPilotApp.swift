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
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Running as a bare SwiftPM executable (no .app bundle yet): behave like a normal app.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    @MainActor func applicationWillTerminate(_ notification: Notification) {
        AppStore.shared.shutdown()
    }
}
