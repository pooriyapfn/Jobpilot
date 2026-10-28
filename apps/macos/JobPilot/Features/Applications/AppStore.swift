import Foundation
import Observation

/// App-wide state: the engine, the applications it reports, and the actions you take on them.
@MainActor @Observable
final class AppStore {
    static let shared = AppStore()

    let engine = EngineProcess()
    private(set) var applications: [ApplicationSummary] = []
    private(set) var info: EngineInfo?
    var selection: ApplicationSummary.ID?
    var errorMessage: String?

    private var client: EngineClient?
    private var poller: Task<Void, Never>?

    var selected: ApplicationSummary? { applications.first { $0.id == selection } }

    func start() async {
        await engine.start()
        guard let c = engine.connection else { return }
        client = EngineClient(baseURL: c.baseURL, token: c.token)
        await refresh()
        poller?.cancel()
        poller = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                await self?.refresh()
            }
        }
    }

    func restart() async {
        poller?.cancel()
        engine.stop()
        await start()
    }

    func shutdown() {
        poller?.cancel()
        engine.stop()
    }

    func refresh() async {
        guard let client else { return }
        do {
            async let apps = client.applications()
            async let info = client.info()
            (applications, self.info) = try await (apps, info)
        } catch {
            // A failed poll is only worth a banner if the engine itself is still supposed to be up.
            if engine.state == .running { errorMessage = error.localizedDescription }
        }
    }

    func apply(_ app: ApplicationSummary) async { await act { try await $0.apply(app.id) } }
    func setStatus(_ app: ApplicationSummary, _ status: Status) async { await act { try await $0.setStatus(app.id, status) } }
    func startChrome() async { await act { _ = try await $0.startJob(.chrome) } }

    func saveAnswers(_ app: ApplicationSummary, _ edits: [String: String]) async -> Bool {
        await act { try await $0.saveAnswers(app.id, edits) }
    }

    @discardableResult
    private func act(_ work: (EngineClient) async throws -> Void) async -> Bool {
        guard let client else { return false }
        do {
            try await work(client)
            errorMessage = nil
            await refresh()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}
