import Foundation

/// Typed HTTP client for the engine API (packages/contracts). Bodies and responses are the generated types.
struct EngineClient: Sendable {
    let baseURL: URL
    let token: String
    var session: URLSession = .shared

    enum Failure: LocalizedError {
        case server(status: Int, message: String)
        case malformed(String)

        var isConflict: Bool { if case .server(409, _) = self { true } else { false } }
        var isNotFound: Bool { if case .server(404, _) = self { true } else { false } }

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

    /// The full application, including the saved job description (the list payload leaves it out).
    func application(_ id: String) async throws -> Application { try await send("GET", "/api/apps/\(id)") }

    // MARK: jobs repository

    func listings() async throws -> [JobListing] { try await send("GET", "/api/listings") }
    func listing(_ id: String) async throws -> JobListingDetail { try await send("GET", "/api/listings/\(id)") }

    /// Reads the page behind a pasted link and adds it. Can take a while: the engine fetches and checks the posting first.
    func addListing(_ url: String) async throws -> JobListing {
        try await perform("POST", "/api/listings", body: JSONEncoder().encode(AddListingRequest(url: url)), timeout: 60)
    }

    func setEligibility(_ id: String, _ eligibility: Eligibility) async throws {
        let _: OkResponse = try await send("POST", "/api/listings/\(id)/eligibility", body: SetEligibilityRequest(eligibility: eligibility))
    }

    func markApplied(_ id: String) async throws {
        let _: OkResponse = try await send("POST", "/api/listings/\(id)/applied", body: Empty())
    }

    func setNote(_ id: String, _ note: String) async throws {
        let _: OkResponse = try await send("POST", "/api/listings/\(id)/note", body: SetNoteRequest(note: note))
    }

    func removeListing(_ id: String, scope: RemoveScope) async throws {
        let _: OkResponse = try await perform("DELETE", "/api/listings/\(id)", query: [URLQueryItem(name: "scope", value: scope.rawValue)], body: nil)
    }

    /// Reads the posting again and updates its eligibility. Returns at once; the listing's `activity` reports progress.
    func assessListing(_ id: String) async throws {
        let _: OkResponse = try await send("POST", "/api/listings/\(id)/assess", body: Empty())
    }

    /// Starts tailoring + form drafting for one job. Returns at once; the listing's `activity` reports progress.
    func prepareListing(_ id: String) async throws {
        let _: OkResponse = try await send("POST", "/api/listings/\(id)/prepare", body: Empty())
    }

    /// `force`: write the resume even though the fit check said this job isn't a match.
    func regenerateResume(_ id: String, force: Bool = false) async throws {
        let _: OkResponse = try await perform("POST", "/api/listings/\(id)/regenerate-resume", query: force ? [URLQueryItem(name: "force", value: "1")] : [], body: try JSONEncoder().encode(Empty()))
    }

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

    func jobs() async throws -> [JobInfo] { try await send("GET", "/api/jobs") }
    func job(_ id: String) async throws -> JobInfo { try await send("GET", "/api/jobs/\(id)") }

    @discardableResult
    func cancelJob(_ id: String) async throws -> JobInfo { try await send("POST", "/api/jobs/\(id)/cancel", body: Empty()) }

    /// Log lines of a job, replayed from the start and followed live until the job ends.
    func logLines(job id: String) -> AsyncThrowingStream<JobEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: baseURL.appending(path: "/api/jobs/\(id)/events"))
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    request.timeoutInterval = 3600
                    let (bytes, response) = try await session.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.malformed("job events") }
                    for try await line in bytes.lines where line.hasPrefix("data: ") {
                        if let event = try? JSONDecoder().decode(JobEvent.self, from: Data(line.dropFirst(6).utf8)) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func knowledgeFiles() async throws -> [KnowledgeFile] { try await send("GET", "/api/knowledge") }

    func knowledge(_ path: String) async throws -> KnowledgeDocument {
        try await perform("GET", "/api/knowledge/file", query: [URLQueryItem(name: "path", value: path)], body: nil)
    }

    func saveKnowledge(_ path: String, content: String) async throws {
        let _: OkResponse = try await perform(
            "PUT", "/api/knowledge/file", query: [URLQueryItem(name: "path", value: path)],
            body: JSONEncoder().encode(SaveKnowledgeRequest(content: content))
        )
    }

    private struct Empty: Encodable {}

    private func send<T: Decodable>(_ method: String, _ path: String) async throws -> T {
        try await perform(method, path, body: nil)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: some Encodable) async throws -> T {
        try await perform(method, path, body: JSONEncoder().encode(body))
    }

    private func perform<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data?, timeout: TimeInterval? = nil) async throws -> T {
        var url = baseURL.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let timeout { request.timeoutInterval = timeout }
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
