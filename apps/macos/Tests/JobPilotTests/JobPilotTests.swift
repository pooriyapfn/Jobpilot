import Foundation
import SQLite3
import Testing
@testable import JobPilot

// MARK: fixtures

private let applicationJSON = """
{
  "id": "a1", "url": "https://jobs.example.com/1", "applyUrl": "https://jobs.example.com/1/apply",
  "title": "Backend Engineer", "company": "Acme", "jd": "Build things.", "status": "prepared",
  "fit": "STRONG_FIT", "atsScore": 91, "resumePath": "/tmp/r.docx",
  "fields": [
    {"id": "email", "selector": "#email", "label": "Email", "type": "text", "required": true},
    {"id": "how", "selector": "#how", "label": "How did you hear?", "type": "select", "required": false, "options": ["LinkedIn", "Other"]},
    {"id": "cv", "selector": "#cv", "label": "Resume", "type": "file", "required": true}
  ],
  "answers": {"email": {"value": "jane@example.com", "confident": true}, "how": {"value": "Other", "confident": false}},
  "updatedAt": "2026-10-28T12:00:00.000Z"
}
"""

private func summary(_ json: String = applicationJSON) throws -> ApplicationSummary {
    try JSONDecoder().decode(ApplicationSummary.self, from: Data(json.utf8)) // extra "jd" key is ignored
}

// MARK: pure logic

@Suite("Models")
struct ModelTests {
    @Test func decodesEngineJSON() throws {
        let app = try summary()
        #expect(app.status == .prepared)
        #expect(app.fields.count == 3)
        #expect(app.fields[1].options == ["LinkedIn", "Other"])
        #expect(app.atsText == "91")
        #expect(app.answers["how"]?.confident == false)
    }

    @Test func needsYouIgnoresFilesAndCountsUnsure() throws {
        let app = try summary()
        #expect(app.needsYou == 1) // "how" is unsure; "cv" is a file; "email" is fine
    }

    @Test func applyAvailability() throws {
        var app = try summary()
        #expect(app.canApply && !app.canMarkSubmitted)
        app.status = .filling
        #expect(!app.canApply && app.canMarkSubmitted && app.canSkip)
        app.status = .submitted
        #expect(!app.canApply && !app.canSkip)
    }

    @Test func unknownStatusFailsLoudly() {
        let bad = applicationJSON.replacingOccurrences(of: "\"prepared\"", with: "\"nope\"")
        #expect(throws: DecodingError.self) { try summary(bad) }
    }
}

@Suite("AnswerDraft")
struct DraftTests {
    @Test func tracksOnlyChangedFields() throws {
        var draft = AnswerDraft(app: try summary())
        #expect(!draft.isDirty)
        #expect(draft.values["cv"] == nil) // file fields aren't editable
        draft.values["email"] = "new@example.com"
        #expect(draft.edits == ["email": "new@example.com"])
        draft.markSaved()
        #expect(!draft.isDirty)
    }

    @Test func rebaseAdoptsNewAnswersOnlyWhenClean() throws {
        var app = try summary()
        var draft = AnswerDraft(app: app)
        app.answers["email"] = Answer(value: "server@example.com", confident: true)
        draft.rebase(onto: app)
        #expect(draft.values["email"] == "server@example.com")

        draft.values["how"] = "LinkedIn"
        app.answers["email"] = Answer(value: "again@example.com", confident: true)
        draft.rebase(onto: app)
        #expect(draft.values["how"] == "LinkedIn") // your edit survives
        #expect(draft.values["email"] == "again@example.com") // untouched fields follow the engine, not mistaken for edits
        #expect(draft.edits == ["how": "LinkedIn"])
    }
}

@Suite("LineReader")
struct LineReaderTests {
    @Test func splitsLinesAcrossChunksAndFlushesTheRest() {
        let buffer = LineReader.Buffer()
        #expect(buffer.append(Data("one\ntw".utf8)) == ["one"])
        #expect(buffer.append(Data("o\nthree\n".utf8)) == ["two", "three"])
        #expect(buffer.append(Data("tail".utf8)) == [])
        #expect(buffer.flush() == "tail")
        #expect(buffer.flush() == nil)
    }

    @Test func deliversAShortLineWithoutWaitingForMoreOutput() async throws {
        // Regression: AsyncBytes held the engine's one-line ready message back until the pipe closed.
        let pipe = Pipe()
        let line = await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
            LineReader.attach(to: pipe.fileHandleForReading) { cont.resume(returning: $0) } onEnd: {}
            pipe.fileHandleForWriting.write(Data("{\"ready\":true}\n".utf8)) // pipe stays open
        }
        #expect(line == "{\"ready\":true}")
        try pipe.fileHandleForWriting.close()
    }
}

// MARK: the real engine

private func engineAvailable() -> Bool {
    (try? EngineLocator.resolve(token: "probe")) != nil
}

private func insert(_ json: String, status: String, into dbPath: String) throws {
    var db: OpaquePointer?
    guard sqlite3_open(dbPath, &db) == SQLITE_OK else { throw CocoaError(.fileReadUnknown) }
    defer { sqlite3_close(db) }
    let sql = "INSERT INTO applications (id, status, data, updated_at) VALUES ('a1', '\(status)', ?, '2026-10-28T12:00:00.000Z')"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw CocoaError(.fileWriteUnknown) }
    defer { sqlite3_finalize(stmt) }
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    sqlite3_bind_text(stmt, 1, json, -1, transient)
    guard sqlite3_step(stmt) == SQLITE_DONE else { throw CocoaError(.fileWriteUnknown) }
}

@Suite("Engine integration", .serialized, .enabled(if: engineAvailable()))
@MainActor
struct EngineIntegrationTests {
    @Test func launchesEngineAndTalksToIt() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "jobpilot-swift-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        setenv("JOBPILOT_HOME", home.path, 1)
        defer { unsetenv("JOBPILOT_HOME"); try? FileManager.default.removeItem(at: home) }

        let engine = EngineProcess()
        await engine.start()
        defer { engine.stop() }
        #expect(engine.state == .running)
        let conn = try #require(engine.connection)

        let client = EngineClient(baseURL: conn.baseURL, token: conn.token)
        let info = try await client.info()
        #expect(info.apiVersion == Contracts.apiVersion)
        #expect(info.home.hasSuffix(home.lastPathComponent))
        #expect(try await client.applications().isEmpty)

        // wrong token → 401 surfaced as a typed error
        let wrong = EngineClient(baseURL: conn.baseURL, token: "wrong")
        await #expect(throws: EngineClient.Failure.self) { try await wrong.info() }

        // a prepared application, written the way the engine writes them
        try insert(applicationJSON, status: "prepared", into: home.appending(path: "data/agent.db").path)
        let apps = try await client.applications()
        #expect(apps.map(\.id) == ["a1"])
        #expect(apps.first?.needsYou == 1)

        // edit + save an answer, then change status
        try await client.saveAnswers("a1", ["how": "LinkedIn"])
        let saved = try await client.applications()
        #expect(saved.first?.answers["how"] == Answer(value: "LinkedIn", confident: true))
        try await client.setStatus("a1", .skipped)
        #expect(try await client.applications().first?.status == .skipped)

        engine.stop()
        #expect(engine.state == .stopped)
    }

    @Test func storeDrivesTheSameFlow() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "jobpilot-swift-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        setenv("JOBPILOT_HOME", home.path, 1)
        defer { unsetenv("JOBPILOT_HOME"); try? FileManager.default.removeItem(at: home) }

        let store = AppStore()
        await store.start()
        defer { store.shutdown() }
        #expect(store.engine.state == .running)
        try insert(applicationJSON, status: "prepared", into: home.appending(path: "data/agent.db").path)
        await store.refresh()
        let app = try #require(store.applications.first)
        #expect(await store.saveAnswers(app, ["email": "x@example.com"]))
        #expect(store.applications.first?.answers["email"]?.value == "x@example.com")
        await store.setStatus(app, .skipped)
        #expect(store.applications.first?.status == .skipped)
        await store.apply(store.applications[0]) // unknown-to-Chrome path: engine accepts, runs in background
        #expect(store.errorMessage == nil)
    }
}
