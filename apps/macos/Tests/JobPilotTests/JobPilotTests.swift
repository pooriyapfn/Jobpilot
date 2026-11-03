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

private func app(_ id: String, _ company: String, _ title: String, _ status: Status, updated: String, unsure: Bool = false) throws -> ApplicationSummary {
    var a = try summary()
    a.id = id; a.company = company; a.title = title; a.status = status; a.updatedAt = updated
    a.answers["how"] = Answer(value: "Other", confident: !unsure)
    return a
}

@Suite("ApplicationFilter")
struct FilterTests {
    func sample() throws -> [ApplicationSummary] {
        [
            try app("a", "Northstar", "Senior Frontend Engineer", .prepared, updated: "2026-10-28T10:00:00Z", unsure: true),
            try app("b", "Arcwell", "Product Engineer", .prepared, updated: "2026-10-28T12:00:00Z"),
            try app("c", "Meridian", "Frontend Developer", .submitted, updated: "2026-10-27T09:00:00Z"),
            try app("d", "Cedar", "React Engineer", .blocked, updated: "2026-10-28T12:00:00Z", unsure: true),
        ]
    }

    @Test func countsFollowTheSpecAndNeedsInputIsASubsetOfReady() throws {
        let apps = try sample()
        #expect(ApplicationFilter.all.count(in: apps) == 4)
        #expect(ApplicationFilter.ready.count(in: apps) == 2)
        #expect(ApplicationFilter.needsInput.count(in: apps) == 1) // "d" needs you but isn't prepared
        #expect(ApplicationFilter.submitted.count(in: apps) == 1)
    }

    @Test func sortsNewestFirstWithAStableTieBreak() throws {
        let ids = ApplicationFilter.all.visible(in: try sample(), search: "").map(\.id)
        #expect(ids == ["d", "b", "a", "c"]) // b and d tie on time: id descending
    }

    @Test func searchIsCaseInsensitiveAcrossCompanyAndTitleAndWithinTheFilter() throws {
        let apps = try sample()
        #expect(ApplicationFilter.all.visible(in: apps, search: "FRONTEND").map(\.id).sorted() == ["a", "c"])
        #expect(ApplicationFilter.ready.visible(in: apps, search: "frontend").map(\.id) == ["a"])
        #expect(ApplicationFilter.all.visible(in: apps, search: "  arc ").map(\.id) == ["b"])
        #expect(ApplicationFilter.all.visible(in: apps, search: "zzz").isEmpty)
    }

    @MainActor @Test func selectionSurvivesOnlyWhileVisible() throws {
        let store = AppStore()
        store.section = .applications(.all)
        store.selection = "b"
        store.reconcileSelection() // nothing loaded: "b" isn't in the list
        #expect(store.selection == nil)
    }
}

// MARK: jobs repository

private func job(
    _ id: String, _ title: String, _ company: String, _ eligibility: Eligibility = .eligible,
    added: String, posted: String? = nil, updated: String? = nil, snippet: String = "", note: String? = nil,
    applied: String? = nil, resume: Bool = false, status: Status? = nil, activity: JobActivity? = nil, fit: String? = nil
) throws -> JobListing {
    var fields = [
        "\"id\": \"\(id)\"", "\"url\": \"https://x.test/\(id)\"", "\"title\": \"\(title)\"", "\"company\": \"\(company)\"",
        "\"eligibility\": \"\(eligibility.rawValue)\"", "\"addedAt\": \"\(added)\"", "\"updatedAt\": \"\(updated ?? added)\"",
        "\"snippet\": \"\(snippet)\"", "\"resumeReady\": \(resume)",
    ]
    if let posted { fields.append("\"datePosted\": \"\(posted)\"") }
    if let note { fields.append("\"userNote\": \"\(note)\"") }
    if let applied { fields.append("\"appliedAt\": \"\(applied)\"") }
    if let status { fields.append("\"applicationStatus\": \"\(status.rawValue)\"") }
    if let activity { fields.append("\"activity\": \"\(activity.rawValue)\"") }
    if let fit { fields.append("\"matchFit\": \"\(fit)\"") }
    return try JSONDecoder().decode(JobListing.self, from: Data(("{" + fields.joined(separator: ",") + "}").utf8))
}

@Suite("Jobs repository")
struct JobRepositoryTests {
    func sample() throws -> [JobListing] {
        [
            try job("a", "Software Engineer – Storage", "Supabase", .eligible, added: "2026-01-21T09:00:00.000Z", posted: "2026-01-20T00:00:00.000Z", updated: "2026-01-22T00:00:00.000Z", snippet: "Build and scale storage", resume: true, status: .prepared),
            try job("b", "Staff Backend Engineer", "Notabene", .review, added: "2026-01-20T09:00:00.000Z", posted: "2026-01-18T00:00:00.000Z", note: "Ask about the on-call rota"),
            try job("c", "Container Engineer", "Supabase", .eligible, added: "2026-01-19T09:00:00.000Z", posted: "2026-01-19T00:00:00.000Z", applied: "2026-01-23T00:00:00.000Z", status: .submitted),
            try job("d", "Senior Full-Stack Engineer", "TryHackMe", .notEligible, added: "2026-01-21T09:00:00.000Z", posted: "2026-01-25T00:00:00.000Z"),
            try job("e", "Platform Engineer", "Globex", .notEvaluated, added: "2026-01-18T09:00:00.000Z"),
        ]
    }

    func ids(_ jobs: [JobListing]) -> [String] { jobs.map(\.id) }

    @Test func decodesEngineJSONWithIndependentFacts() throws {
        let jobs = try sample()
        #expect(jobs[3].eligibility == .notEligible && jobs[3].applicationState == .notApplied)
        #expect(jobs[2].eligibility == .eligible && jobs[2].applicationState == .submitted)
        #expect(jobs[0].resumeReady && jobs[1].resumeReady == false)
        #expect(jobs[4].eligibility == .notEvaluated)
    }

    @Test func applicationStateComesFromTheApplicationNotFromEligibility() throws {
        #expect(try job("1", "t", "c", .notEligible, added: "2026-01-01T00:00:00Z", applied: "2026-01-02T00:00:00Z").applicationState == .submitted)
        #expect(try job("2", "t", "c", added: "2026-01-01T00:00:00Z", status: .filling).applicationState == .inProgress)
        #expect(try job("3", "t", "c", added: "2026-01-01T00:00:00Z", activity: .filling).applicationState == .inProgress)
        #expect(try job("4", "t", "c", added: "2026-01-01T00:00:00Z", status: .error).applicationState == .failed)
        #expect(try job("5", "t", "c", added: "2026-01-01T00:00:00Z", status: .prepared).applicationState == .notApplied)
        #expect(try job("6", "t", "c", added: "2026-01-01T00:00:00Z", status: .skipFit, fit: "SKIP").matchLabel == "Not a fit") // match isn't eligibility
    }

    @Test func parsesTimestampsWithAndWithoutMillisecondsAndPlainDays() {
        #expect(JobDate.parse("2026-10-28T12:00:00.000Z") == JobDate.parse("2026-10-28T12:00:00Z"))
        #expect(JobDate.parse("2026-10-28") != nil)
        #expect(JobDate.parse("garbage") == nil && JobDate.parse(nil) == nil)
    }

    @Test func compactDatesDropTheYearOnlyForThisYear() throws {
        let now = JobDate.parse("2026-11-02T00:00:00Z")!
        #expect(!JobDate.compact(JobDate.parse("2026-10-26T12:00:00Z")!, now: now).contains("2026"))
        #expect(JobDate.compact(JobDate.parse("2025-10-26T12:00:00Z")!, now: now).contains("2025"))
    }

    @Test func missingPostedDateSaysSoInsteadOfUsingTheAddedDate() throws {
        let jobs = try sample()
        #expect(jobs[0].datesText.hasPrefix("Posted ") && jobs[0].datesText.contains(" · Added "))
        #expect(jobs[4].datesText.hasPrefix("Posted date unknown"))
        #expect(jobs[4].postedDate == nil)
    }

    @Test func eligibilityLabelsAreTheFourSpecifiedOnes() {
        #expect(Eligibility.allCases.map(\.label) == ["Not evaluated", "Eligible", "Not eligible", "Needs review"])
        #expect(Set(Eligibility.allCases.map(\.symbol)).count == 4) // never colour alone
    }

    @Test func dateAddedSortsNewestFirstWithAStableTieBreak() throws {
        // a and d tie on time: id ascending inside a tie, whichever way the dates run
        #expect(ids(JobList.visible(try sample(), sort: .dateAdded, ascending: false, search: "")) == ["a", "d", "b", "c"])
        #expect(ids(JobList.visible(try sample(), sort: .dateAdded, ascending: true, search: "")) == ["c", "b", "a", "d"])
    }

    @Test func datePostedSortsBothWaysAndHidesUndated() throws {
        #expect(ids(JobList.visible(try sample(), sort: .datePosted, ascending: false, search: "")) == ["d", "a", "c", "b"])
        #expect(ids(JobList.visible(try sample(), sort: .datePosted, ascending: true, search: "")) == ["b", "c", "a", "d"])
    }

    @Test func lastUpdatedAndCompanySortDeterministically() throws {
        #expect(JobList.visible(try sample(), sort: .lastUpdated, ascending: false, search: "").first?.id == "a") // updated Jan 22
        #expect(ids(JobList.visible(try sample(), sort: .company, search: "")) == ["b", "a", "c", "d"]) // A-Z, ties by id
        #expect(ids(JobList.visible(try sample(), sort: .company, ascending: false, search: "")) == ["d", "a", "c", "b"])
    }

    @Test func eachFilterDimensionWorksAloneAndTheyCombine() throws {
        let jobs = try sample()
        let apps: [String: ApplicationSummary] = [:]   // no application has answers waiting
        func visible(_ f: JobFilters) -> [String] { ids(JobList.visible(jobs, applications: apps, filters: f, sort: .dateAdded, search: "")) }
        #expect(visible(JobFilters(eligibility: .eligible)) == ["a", "c"])
        #expect(visible(JobFilters(eligibility: .review)) == ["b"])
        #expect(visible(JobFilters(preparation: .resumeReady)) == ["a"])
        #expect(Set(visible(JobFilters(preparation: .needsResume))) == ["b", "c", "d"])
        #expect(visible(JobFilters(preparation: .answersToReview)) == [])
        #expect(visible(JobFilters(application: .submitted)) == ["c"])
        #expect(visible(JobFilters(eligibility: .eligible, application: .notApplied)) == ["a"])
        #expect(visible(JobFilters()).count == 4)
        #expect(JobFilters(eligibility: .eligible, application: .submitted).activeCount == 2)
    }

    @Test func answersToReviewUsesTheApplicationsRealAnswers() throws {
        var a = try summary()
        a.id = "a"
        let jobs = try sample()
        #expect(ids(JobList.visible(jobs, applications: ["a": a], filters: JobFilters(preparation: .answersToReview), sort: .dateAdded, search: "")) == ["a"])
    }

    @Test func searchCoversTitleCompanyNotesAndDescriptionAndClearsCleanly() throws {
        let jobs = try sample()
        func hit(_ q: String) -> [String] { ids(JobList.visible(jobs, sort: .dateAdded, search: q)).sorted() }
        #expect(hit("SUPABASE") == ["a", "c"])
        #expect(hit("storage") == ["a"])      // title and description
        #expect(hit("on-call") == ["b"])      // your note
        #expect(hit("  globex ") == [])
        #expect(hit("zzz").isEmpty)
        #expect(hit("").count == 4)
    }

    @MainActor @Test func jobSelectionSurvivesOnlyWhileVisible() {
        let store = AppStore()
        store.section = .jobs
        store.selection = "x"
        store.reconcileSelection() // nothing loaded: "x" isn't in the list
        #expect(store.selection == nil)
    }
}

@Suite("Next step")
struct JobFlowTests {
    func app(_ status: Status = .prepared, unsure: Bool = false) throws -> ApplicationSummary {
        var a = try summary()
        a.status = status
        if !unsure { a.answers["how"] = Answer(value: "Other", confident: true) }
        return a
    }

    func next(_ job: JobListing?, _ app: ApplicationSummary?, unresolved: Int = 0, _ context: DetailContext = .jobs) -> JobNextStep {
        JobFlow.next(job: job, app: app, unresolvedAnswers: unresolved, context: context)
    }

    @Test func eachEligibilityPointsAtItsOwnNextStep() throws {
        let added = "2026-01-01T00:00:00Z"
        #expect(next(try job("1", "t", "c", .notEvaluated, added: added), nil) == .action(.analyze))
        #expect(next(try job("2", "t", "c", .review, added: added), nil) == .action(.reassess))
        #expect(next(try job("3", "t", "c", .notEligible, added: added), nil) == .action(.reassess))
        #expect(next(try job("4", "t", "c", .eligible, added: added), nil) == .action(.generateResume))
    }

    @Test func aPreparedApplicationWalksFromResumeToAnswersToChrome() throws {
        let added = "2026-01-01T00:00:00Z"
        let noResume = try job("a", "t", "c", added: added, status: .prepared)
        #expect(next(noResume, try app()) == .action(.generateResume))
        let ready = try job("a", "t", "c", added: added, resume: true, status: .prepared)
        #expect(next(ready, try app(), unresolved: 2) == .action(.reviewAnswers))
        #expect(next(ready, try app(), unresolved: 0) == .action(.fillInChrome))
    }

    @Test func engineWorkWinsAndShowsItsOwnStep() throws {
        var busy = try job("a", "t", "c", added: "2026-01-01T00:00:00Z", activity: .regenerating)
        #expect(next(busy, nil) == .working(JobActivity.regenerating.defaultStep))
        busy.activityStep = "Saving"
        #expect(next(busy, nil) == .working("Saving"))
    }

    @Test func appliedJobsOfferViewApplicationOnlyFromJobsAndNeverFillAgain() throws {
        let applied = try job("a", "t", "c", added: "2026-01-01T00:00:00Z", applied: "2026-01-02T00:00:00Z", resume: true, status: .submitted)
        #expect(next(applied, try app(.submitted), .jobs) == .action(.viewApplication))
        if case .unavailable = next(applied, try app(.submitted), .applications) {} else { Issue.record("expected an explanation") }
        if case .unavailable = next(try job("b", "t", "c", added: "2026-01-01T00:00:00Z", applied: "2026-01-02T00:00:00Z"), nil, .jobs) {} else { Issue.record("no application to view") }
    }

    @Test func fillingWaitsForYouAndNeverSelfSubmits() throws {
        let filling = try job("a", "t", "c", added: "2026-01-01T00:00:00Z", resume: true, status: .filling)
        if case .unavailable = next(filling, try app(.filling)) {} else { Issue.record("expected a wait message") }
    }

    @Test func anApplicationWhoseJobWasRemovedStillGetsASensibleStep() throws {
        #expect(next(nil, try app(.prepared), unresolved: 0) == .action(.generateResume)) // no resume file on disk in tests
    }

    @Test func disabledReasonsMatchPrerequisites() {
        #expect(JobFlow.disabledReason(for: .fillInChrome, chromeUp: false, hasKey: true) != nil)
        #expect(JobFlow.disabledReason(for: .fillInChrome, chromeUp: true, hasKey: false) == nil)
        #expect(JobFlow.disabledReason(for: .generateResume, chromeUp: true, hasKey: false) != nil)
        #expect(JobFlow.disabledReason(for: .analyze, chromeUp: false, hasKey: false) == nil)
    }
}

@Suite("AnswerDraft review")
struct DraftReviewTests {
    @Test func unsureAnswersStayUnresolvedUntilEditedOrConfirmed() throws {
        let a = try app("a", "Acme", "Eng", .prepared, updated: "2026-10-28T10:00:00Z", unsure: true)
        var draft = AnswerDraft(app: a)
        #expect(draft.unresolved(in: a).map(\.id) == ["how"])
        #expect(!draft.isDirty) // looking at a field is not reviewing it

        draft.confirm("how")
        #expect(draft.unresolved(in: a).isEmpty)
        #expect(draft.changes == ["how": "Other"]) // sent so the engine marks it confident
        #expect(draft.edits.isEmpty)

        draft.markSaved(draft.changes)
        #expect(!draft.isDirty)
    }

    @Test func emptyAnswersCannotBeConfirmedAndEmptiedEditsReopenTheField() throws {
        var a = try app("a", "Acme", "Eng", .prepared, updated: "2026-10-28T10:00:00Z")
        a.answers["email"] = Answer(value: "", confident: true)
        var draft = AnswerDraft(app: a)
        draft.confirm("email")
        #expect(draft.confirmed.isEmpty)
        #expect(draft.unresolved(in: a).map(\.id) == ["email"])

        draft.values["how"] = ""
        #expect(draft.unresolved(in: a).map(\.id).contains("how"))
    }

    @Test func rebaseKeepsEditsAndDropsConfirmationsTheEngineAlreadyAccepted() throws {
        var a = try app("a", "Acme", "Eng", .prepared, updated: "2026-10-28T10:00:00Z", unsure: true)
        var draft = AnswerDraft(app: a)
        draft.confirm("how")
        draft.values["email"] = "typed@example.com"
        a.answers["how"] = Answer(value: "Other", confident: true)
        draft.rebase(onto: a)
        #expect(draft.confirmed.isEmpty)
        #expect(draft.edits == ["email": "typed@example.com"])
    }

    @Test func savingOnlyClearsWhatWasSent() throws {
        let a = try app("a", "Acme", "Eng", .prepared, updated: "2026-10-28T10:00:00Z")
        var draft = AnswerDraft(app: a)
        draft.values["email"] = "one@example.com"
        let sent = draft.changes
        draft.values["email"] = "two@example.com" // typed while the request was in flight
        draft.markSaved(sent)
        #expect(draft.edits == ["email": "two@example.com"])
    }
}

@Suite("Status copy")
struct CopyTests {
    @Test func listLineAndFitLabel() throws {
        #expect(try app("a", "A", "T", .prepared, updated: "x", unsure: true).listStatusText == "1 answer to review")
        #expect(try app("a", "A", "T", .prepared, updated: "x").listStatusText == "Ready")
        #expect(try app("a", "A", "T", .blocked, updated: "x").listStatusText == "Needs your login")
        #expect(try summary().fitLabel == "Strong fit")
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
        var draft = store.draft(for: app)
        draft.values["email"] = "x@example.com"
        store.drafts[app.id] = draft
        #expect(await store.saveDraft(app))
        #expect(store.applications.first?.answers["email"]?.value == "x@example.com")
        #expect(store.drafts[app.id] == nil) // saved drafts are dropped once the engine agrees
        // Confirming the unsure (unchanged) answer persists: the engine marks it confident.
        #expect(store.applications.first?.answers["how"]?.confident == false)
        var confirm = store.draft(for: store.applications[0])
        confirm.confirm("how")
        store.drafts[app.id] = confirm
        #expect(await store.saveDraft(store.applications[0]))
        #expect(store.applications.first?.answers["how"] == Answer(value: "Other", confident: true))
        #expect(store.applications.first?.needsYou == 0)
        // The posting text comes from the detail route, not the list.
        await store.loadDetail(app.id)
        guard case let .loaded(detail)? = store.details[app.id] else { Issue.record("detail not loaded"); return }
        #expect(detail.jd == "Build things.")
        await store.setStatus(app, .skipped)
        #expect(store.applications.first?.status == .skipped)
        await store.fill(store.applications[0]) // unknown-to-Chrome path: engine accepts, runs in background
        #expect(store.errorMessage == nil)
    }

    @Test func storeManagesJobs() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "jobpilot-swift-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        setenv("JOBPILOT_HOME", home.path, 1)
        defer { unsetenv("JOBPILOT_HOME"); try? FileManager.default.removeItem(at: home) }

        let store = AppStore()
        await store.start()
        defer { store.shutdown() }
        #expect(store.engine.state == .running)
        #expect(store.section == .jobs) // the first view is the jobs list
        #expect(store.listings.isEmpty)

        // An application the repository didn't know about shows up as a job, with nothing claimed about eligibility.
        try insert(applicationJSON, status: "prepared", into: home.appending(path: "data/agent.db").path)
        await store.refresh()
        let listing = try #require(store.listings.first)
        #expect(listing.id == "a1" && listing.applicationStatus == .prepared && listing.eligibility == .notEvaluated)
        #expect(listing.resumeReady == false) // /tmp/r.docx doesn't exist

        // Not eligible sticks and is attributed to you; the application leaves the queue; applying later changes neither.
        await store.setEligibility("a1", .notEligible)
        #expect(store.listings.first?.eligibility == .notEligible && store.listings.first?.eligibilitySource == .you)
        #expect(store.applications.first?.status == .skipped)
        #expect(store.flashMessage != nil)

        // Notes: your draft survives until you save, then persists in the engine.
        let job = try #require(store.listings.first)
        store.noteDrafts["a1"] = "Recruiter is Sam"
        #expect(store.noteIsDirty(job))
        await store.saveNote(job)
        #expect(store.listings.first?.userNote == "Recruiter is Sam" && store.noteDrafts["a1"] == nil)
        #expect(!store.noteIsDirty(store.listings[0]))

        // I already applied: dated, application submitted, eligibility untouched.
        await store.markApplied("a1")
        #expect(store.listings.first?.appliedAt != nil && store.listings.first?.applicationState == .submitted)
        #expect(store.listings.first?.eligibility == .notEligible)
        #expect(store.applications.first?.status == .submitted)

        // A bad link is explained, and adds nothing.
        await #expect(throws: EngineClient.Failure.self) { try await store.addLink("not a link") }
        #expect(store.listings.count == 1)

        // A refused change is rolled back: regenerating needs an application, and a missing job is refused outright.
        let client = try #require(store.client)
        await #expect(throws: EngineClient.Failure.self) { try await client.regenerateResume("missing") }
        await store.setEligibility("missing", .eligible)
        #expect(store.listings.count == 1 && store.listings.first?.eligibility == .notEligible)

        // Remove from Jobs keeps the application and its history; the job is gone from the list and the selection clears.
        store.selection = "a1"
        await store.removeJob("a1", scope: .listing)
        #expect(store.listings.isEmpty && store.selection == nil)
        #expect(store.applications.map(\.id) == ["a1"])
    }
}
