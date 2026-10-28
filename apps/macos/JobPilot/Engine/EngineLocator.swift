import Foundation

/// How to start the engine: which node, which script, which data home.
struct EngineLaunch: Sendable {
    var node: URL
    var arguments: [String]
    var workingDirectory: URL
    var environment: [String: String]
}

enum EngineLocatorError: LocalizedError {
    case repoNotFound
    case nodeNotFound

    var errorDescription: String? {
        switch self {
        case .repoNotFound:
            "Can't find the jobpilot repo (packages/engine/src/bin.ts). Set JOBPILOT_REPO to its path."
        case .nodeNotFound:
            "Can't find Node 22+. Install it, or set JOBPILOT_NODE to the node binary."
        }
    }
}

/// Dev layout: node from your shell + the engine sources in the repo checkout.
/// (Phase 7 adds a bundled node + engine inside the .app and prefers it.)
enum EngineLocator {
    static let defaultHome = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/Application Support/JobPilot")

    static func resolve(environment env: [String: String] = ProcessInfo.processInfo.environment,
                        token: String) throws -> EngineLaunch {
        let home = env["JOBPILOT_HOME"].map { URL(fileURLWithPath: $0) } ?? defaultHome
        let repo = try findRepo(env: env)
        let node = try findNode(env: env)

        var childEnv = env
        childEnv["JOBPILOT_HOME"] = home.path
        childEnv["JOBPILOT_TOKEN"] = token
        return EngineLaunch(
            node: node,
            arguments: [
                "--experimental-strip-types",
                "--disable-warning=ExperimentalWarning",
                "--env-file-if-exists=\(home.appending(path: ".env.local").path)",
                "packages/engine/src/bin.ts", "serve", "--exit-on-stdin-close",
            ],
            workingDirectory: repo,
            environment: childEnv
        )
    }

    private static func findRepo(env: [String: String], file: String = #filePath) throws -> URL {
        let marker = "packages/engine/src/bin.ts"
        let fm = FileManager.default
        var candidates: [URL] = []
        if let p = env["JOBPILOT_REPO"] { candidates.append(URL(fileURLWithPath: p)) }
        // Walk up from the current directory, then from this source file (works when launched from Xcode).
        for start in [URL(fileURLWithPath: fm.currentDirectoryPath), URL(fileURLWithPath: file)] {
            var dir = start
            for _ in 0..<8 {
                candidates.append(dir)
                dir = dir.deletingLastPathComponent()
            }
        }
        if let hit = candidates.first(where: { fm.fileExists(atPath: $0.appending(path: marker).path) }) { return hit }
        throw EngineLocatorError.repoNotFound
    }

    private static func findNode(env: [String: String]) throws -> URL {
        let fm = FileManager.default
        if let p = env["JOBPILOT_NODE"], fm.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        // GUI apps get a minimal PATH, so ask a login shell (picks up nvm / Homebrew).
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        shell.standardOutput = out
        shell.standardError = FileHandle.nullDevice
        try? shell.run()
        shell.waitUntilExit()
        let path = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .split(whereSeparator: \.isNewline).last.map(String.init) ?? ""
        if fm.isExecutableFile(atPath: path) { return URL(fileURLWithPath: path) }
        for fallback in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where fm.isExecutableFile(atPath: fallback) {
            return URL(fileURLWithPath: fallback)
        }
        throw EngineLocatorError.nodeNotFound
    }
}
