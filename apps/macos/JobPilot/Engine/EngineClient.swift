import Foundation

/// Typed HTTP client for the engine API (packages/contracts). Bodies and responses are the generated types.
struct EngineClient: Sendable {
    let baseURL: URL
    let token: String
    var session: URLSession = .shared

    enum Failure: LocalizedError {
        case server(status: Int, message: String)
        case malformed(String)

        var errorDescription: String? {
            switch self {
            case let .server(status, message): "\(message) (\(status))"
            case let .malformed(what): "Unexpected response from the engine: \(what)"
            }
        }
    }

    func info() async throws -> EngineInfo { try await send("GET", "/api/info") }
    func applications() async throws -> [ApplicationSummary] { try await send("GET", "/api/apps") }
    func eligibleJobs() async throws -> [EligibleJob] { try await send("GET", "/api/eligible-jobs") }

    func apply(_ id: String) async throws {
        let _: OkResponse = try await send("POST", "/api/apply/\(id)", body: Empty())
    }

    func saveAnswers(_ id: String, _ answers: [String: String]) async throws {
        let _: OkResponse = try await send("POST", "/api/answers/\(id)", body: SaveAnswersRequest(answers: answers))
    }

    func setStatus(_ id: String, _ status: Status) async throws {
        let _: OkResponse = try await send("POST", "/api/status/\(id)", body: SetStatusRequest(status: status))
    }

    @discardableResult
    func startJob(_ task: JobTask, limit: Int? = nil) async throws -> JobInfo {
        try await send("POST", "/api/jobs", body: StartJobRequest(task: task, limit: limit))
    }

    private struct Empty: Encodable {}

    private func send<T: Decodable>(_ method: String, _ path: String) async throws -> T {
        try await perform(method, path, body: nil)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: some Encodable) async throws -> T {
        try await perform(method, path, body: JSONEncoder().encode(body))
    }

    private func perform<T: Decodable>(_ method: String, _ path: String, body: Data?) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.malformed("not HTTP") }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw Failure.server(status: http.statusCode, message: message)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw Failure.malformed("\(T.self): \(error.localizedDescription)")
        }
    }
}
