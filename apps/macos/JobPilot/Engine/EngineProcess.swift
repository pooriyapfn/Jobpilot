import Foundation
import Observation

private func diag(_ message: String) {
    FileHandle.standardError.write(Data("[engine] \(message)\n".utf8))
}

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
            // The watchdog may have given up (and killed the engine) while we were waiting.
            guard state == .starting else { throw EngineError.exitedEarly }
            guard ready.apiVersion == Contracts.apiVersion else {
                throw EngineError.apiMismatch(engine: ready.apiVersion, app: Contracts.apiVersion)
            }
            connection = Connection(baseURL: URL(string: "http://127.0.0.1:\(ready.port)")!, token: ready.token)
            state = .running
            diag("running on port \(ready.port)")
        } catch {
            stop()
            state = .failed(error.localizedDescription)
        }
    }

    func stop() {
        diag("stop() called, state=\(state)")
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

        // stderr → log buffer
        LineReader.attach(to: err.fileHandleForReading) { [weak self] line in
            Task { @MainActor in self?.appendLog(line) }
        } onEnd: {}

        // A hung start (bad node, port clash…) must not leave the UI spinning forever.
        let watchdog = Task { [weak self] in
            try await Task.sleep(for: .seconds(30))
            self?.failIfStarting("The engine didn't report ready within 30 s.")
        }
        defer { watchdog.cancel() }

        // stdout: the first line is the ready line; the engine writes nothing else there.
        return try await withCheckedThrowingContinuation { cont in
            let once = Once()
            LineReader.attach(to: out.fileHandleForReading) { line in
                guard once.claim() else { return diag("unexpected stdout: \(line)") }
                do {
                    cont.resume(returning: try JSONDecoder().decode(EngineReady.self, from: Data(line.utf8)))
                } catch {
                    cont.resume(throwing: EngineError.badReadyLine(line))
                }
            } onEnd: {
                if once.claim() { cont.resume(throwing: EngineError.exitedEarly) }
            }
        }
    }

    private func appendLog(_ line: String) {
        logLines.append(line)
        if logLines.count > 500 { logLines.removeFirst(logLines.count - 500) }
    }

    private func failIfStarting(_ message: String) {
        diag("watchdog fired, state=\(state)")
        guard state == .starting else { return }
        process?.terminate()
        state = .failed(message)
    }

    private func didExit(code: Int32) {
        diag("engine exited code=\(code) stopping=\(stopping) state=\(state)")
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
    case badReadyLine(String)
    case apiMismatch(engine: Int, app: Int)

    var errorDescription: String? {
        switch self {
        case .exitedEarly: "The engine exited before it was ready."
        case let .badReadyLine(line): "The engine's first output wasn't the ready line: \(line.prefix(200))"
        case let .apiMismatch(engine, app): "Engine API v\(engine) doesn't match this app (v\(app)). Update both."
        }
    }
}

/// Splits a pipe's output into lines. Uses readabilityHandler (not AsyncBytes): it keeps delivering
/// when the process also runs an AppKit event loop.
enum LineReader {
    static func attach(to handle: FileHandle, onLine: @escaping @Sendable (String) -> Void, onEnd: @escaping @Sendable () -> Void) {
        let buffer = Buffer()
        handle.readabilityHandler = { h in
            let data = h.availableData
            if data.isEmpty { // EOF
                h.readabilityHandler = nil
                if let rest = buffer.flush() { onLine(rest) }
                onEnd()
                return
            }
            for line in buffer.append(data) { onLine(line) }
        }
    }

    final class Buffer: @unchecked Sendable {
        private var data = Data()
        private let lock = NSLock()

        func append(_ chunk: Data) -> [String] {
            lock.lock(); defer { lock.unlock() }
            data.append(chunk)
            var lines: [String] = []
            while let nl = data.firstIndex(of: 0x0A) {
                lines.append(String(decoding: data[data.startIndex..<nl], as: UTF8.self))
                data = Data(data[data.index(after: nl)...])
            }
            return lines
        }

        func flush() -> String? {
            lock.lock(); defer { lock.unlock() }
            defer { data = Data() }
            return data.isEmpty ? nil : String(decoding: data, as: UTF8.self)
        }
    }
}

private final class Once: @unchecked Sendable {
    private var taken = false
    private let lock = NSLock()
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if taken { return false }
        taken = true
        return true
    }
}
