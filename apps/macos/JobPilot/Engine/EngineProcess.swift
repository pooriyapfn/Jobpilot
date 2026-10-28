import Foundation
import Observation

/// Owns the engine child process: starts it, reads the ready line, keeps its stderr, stops it.
@MainActor @Observable
final class EngineProcess {
    enum State: Equatable {
        case stopped
        case starting
        case running
        case failed(String)
    }

    struct Connection: Sendable {
        let baseURL: URL
        let token: String
    }

    private(set) var state: State = .stopped
    private(set) var connection: Connection?
    private(set) var logLines: [String] = []

    private var process: Process?
    private var stdin: Pipe?
    private var stopping = false

    func start() async {
        guard state != .starting, state != .running else { return }
        state = .starting
        connection = nil
        logLines = []
        stopping = false
        do {
            let token = Self.makeToken()
            let launch = try await Task.detached { try EngineLocator.resolve(token: token) }.value
            let ready = try await spawn(launch)
            guard ready.apiVersion == Contracts.apiVersion else {
                throw EngineError.apiMismatch(engine: ready.apiVersion, app: Contracts.apiVersion)
            }
            connection = Connection(baseURL: URL(string: "http://127.0.0.1:\(ready.port)")!, token: ready.token)
            state = .running
        } catch {
            stop()
            state = .failed(error.localizedDescription)
        }
    }

    func stop() {
        stopping = true
        try? stdin?.fileHandleForWriting.close() // the engine exits when its stdin closes
        process?.terminate()
        process = nil
        connection = nil
        if case .failed = state {} else { state = .stopped }
    }

    private func spawn(_ launch: EngineLaunch) async throws -> EngineReady {
        let proc = Process()
        proc.executableURL = launch.node
        proc.arguments = launch.arguments
        proc.currentDirectoryURL = launch.workingDirectory
        proc.environment = launch.environment
        let out = Pipe(), err = Pipe(), inPipe = Pipe()
        proc.standardOutput = out
        proc.standardError = err
        proc.standardInput = inPipe
        proc.terminationHandler = { [weak self] p in
            Task { @MainActor in self?.didExit(code: p.terminationStatus) }
        }
        try proc.run()
        process = proc
        stdin = inPipe

        Task.detached { [weak self] in
            do {
                for try await line in err.fileHandleForReading.bytes.lines {
                    await self?.appendLog(line)
                }
            } catch {}
        }
        // A hung start (bad node, port clash…) must not leave the UI spinning forever.
        let watchdog = Task { [weak self] in
            try await Task.sleep(for: .seconds(30))
            self?.failIfStarting("The engine didn't report ready within 30 s.")
        }
        defer { watchdog.cancel() }

        return try await withCheckedThrowingContinuation { cont in
            Task.detached {
                var answered = false
                do {
                    for try await line in out.fileHandleForReading.bytes.lines where !answered {
                        answered = true
                        cont.resume(returning: try JSONDecoder().decode(EngineReady.self, from: Data(line.utf8)))
                    }
                } catch {
                    if !answered { answered = true; cont.resume(throwing: error) }
                }
                if !answered { cont.resume(throwing: EngineError.exitedEarly) }
            }
        }
    }

    private func appendLog(_ line: String) {
        logLines.append(line)
        if logLines.count > 500 { logLines.removeFirst(logLines.count - 500) }
    }

    private func failIfStarting(_ message: String) {
        guard state == .starting else { return }
        process?.terminate()
        state = .failed(message)
    }

    private func didExit(code: Int32) {
        process = nil
        guard !stopping, state != .stopped else { return }
        let tail = logLines.suffix(4).joined(separator: "\n")
        connection = nil
        state = .failed("The engine stopped (exit code \(code)).\(tail.isEmpty ? "" : "\n" + tail)")
    }

    private static func makeToken() -> String {
        (0..<32).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max)) }.joined()
    }
}

enum EngineError: LocalizedError {
    case exitedEarly
    case apiMismatch(engine: Int, app: Int)

    var errorDescription: String? {
        switch self {
        case .exitedEarly: "The engine exited before it was ready."
        case let .apiMismatch(engine, app): "Engine API v\(engine) doesn't match this app (v\(app)). Update both."
        }
    }
}
