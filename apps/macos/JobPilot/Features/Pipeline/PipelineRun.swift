import Foundation
import Observation

/// A short sequence of engine jobs (search → verify → enrich, or prepare) that runs one step at a time.
/// A started job is not a finished job: each step is watched until it reports success before the next begins.
@MainActor @Observable
final class PipelineRun {
    enum StepState: Equatable {
        case pending, running, succeeded, cancelled
        case failed(String)
    }

    struct Step: Identifiable, Equatable {
        let task: JobTask
        let title: String
        var state: StepState = .pending
        var id: JobTask { task }
    }

    enum Phase: Equatable { case ready, running, finished }

    let title: String
    private(set) var steps: [Step]
    private(set) var phase: Phase = .ready
    private(set) var logTail: [String] = []

    private let limit: Int?
    private var currentJob: String?
    private var runner: Task<Void, Never>?
    private var logger: Task<Void, Never>?

    init(title: String, steps: [(JobTask, String)], limit: Int? = nil) {
        self.title = title
        self.steps = steps.map { Step(task: $0.0, title: $0.1) }
        self.limit = limit
    }

    static func findJobs() -> PipelineRun {
        PipelineRun(title: "Find jobs", steps: [
            (.search, "Search job boards"),
            (.verify, "Check postings are live and recent"),
            (.enrich, "Check eligibility from your location"),
        ])
    }

    static func prepare(limit: Int?) -> PipelineRun {
        PipelineRun(title: "Prepare applications", steps: [(.prepare, "Tailor resumes and draft answers")], limit: limit)
    }

    var succeeded: Bool { steps.allSatisfy { $0.state == .succeeded } }
    var failure: String? { steps.lazy.compactMap { if case let .failed(m) = $0.state { m } else { nil } }.first }
    var wasCancelled: Bool { steps.contains { $0.state == .cancelled } }

    /// Starts (or resumes after a failure) from the first step that has not succeeded.
    func start(client: EngineClient, onFinish: @escaping @MainActor () async -> Void) {
        guard phase != .running else { return }
        for i in steps.indices where steps[i].state != .succeeded { steps[i].state = .pending }
        phase = .running
        runner = Task { [weak self] in
            await self?.run(client: client)
            await onFinish()
        }
    }

    func cancel(client: EngineClient) {
        guard phase == .running, let id = currentJob else { return }
        Task { _ = try? await client.cancelJob(id) } // the polling loop sees "cancelled" and stops the sequence
    }

    private func run(client: EngineClient) async {
        defer { phase = .finished; logger?.cancel() }
        for i in steps.indices where steps[i].state != .succeeded {
            steps[i].state = .running
            logTail = []
            let outcome = await runStep(steps[i].task, client: client)
            steps[i].state = outcome
            if outcome != .succeeded { return }
        }
    }

    private func runStep(_ task: JobTask, client: EngineClient) async -> StepState {
        let job: JobInfo
        do {
            job = try await client.startJob(task, limit: task == .prepare ? limit : nil)
        } catch let error as EngineClient.Failure where error.isConflict {
            // Already running (started elsewhere): follow that run instead of starting another.
            guard let running = try? await client.jobs().first(where: { $0.task == task && $0.status == .running }) else {
                return .failed(error.localizedDescription)
            }
            job = running
        } catch {
            return .failed(error.localizedDescription)
        }
        currentJob = job.id
        logger?.cancel()
        logger = Task { [weak self] in
            do {
                for try await event in client.logLines(job: job.id) where event.kind == .log && !event.text.isEmpty {
                    self?.append(event.text)
                }
            } catch {} // the log tail is a nicety; status polling is authoritative
        }
        while true {
            do {
                let info = try await client.job(job.id)
                switch info.status {
                case .running: break
                case .succeeded: return .succeeded
                case .cancelled: return .cancelled
                case .failed:
                    let code = info.exitCode.map { " (exit code \($0))" } ?? ""
                    let last = logTail.last.map { ": \($0)" } ?? ""
                    return .failed("\(task.rawValue) failed\(code)\(last)")
                }
            } catch {
                return .failed("Lost contact with the engine: \(error.localizedDescription)")
            }
            try? await Task.sleep(for: .milliseconds(700))
        }
    }

    private func append(_ line: String) {
        logTail.append(line)
        if logTail.count > 6 { logTail.removeFirst(logTail.count - 6) }
    }
}
