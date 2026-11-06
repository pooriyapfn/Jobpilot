import Foundation
import Observation

/// Where the sidebar points: the jobs repository, an application filter, or one of the library documents.
enum SidebarSection: Hashable {
    case jobs
    case applications(ApplicationFilter)
    case library(LibraryDoc)

    var title: String {
        switch self {
        case .jobs: "Jobs"
        case .applications: "Applications"
        case let .library(doc): doc.title
        }
    }
}

/// Modal flows started from the toolbar or an empty state.
enum WorkspaceSheet: String, Identifiable {
    case findJobs, prepare, addLink
    var id: String { rawValue }
}

/// App-wide state: the engine, the applications it reports, your drafts, and the actions you take on them.
@MainActor @Observable
final class AppStore {
    static let shared = AppStore()

    enum DetailState { case loading, loaded(Application), failed(String) }
    enum ListingDetailState { case loading, loaded(JobListingDetail), failed(String) }

    let engine = EngineProcess()
    let editors: [LibraryDoc: KnowledgeEditorModel] = Dictionary(uniqueKeysWithValues: LibraryDoc.allCases.map { ($0, KnowledgeEditorModel(doc: $0)) })

    private(set) var applications: [ApplicationSummary] = [] {
        didSet { applicationsByID = Dictionary(applications.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }) }
    }
    private(set) var applicationsByID: [String: ApplicationSummary] = [:]
    private(set) var listings: [JobListing] = []
    private(set) var info: EngineInfo?
    private(set) var hasLoaded = false
    private(set) var client: EngineClient?
    var errorMessage: String?

    var section: SidebarSection = .jobs
    var searchText = ""
    var jobFilters = JobFilters()
    var jobSort = JobSort.dateAdded {
        didSet { if jobSort != oldValue { jobSortAscending = jobSort.defaultAscending } }
    }
    var jobSortAscending = JobSort.dateAdded.defaultAscending
    /// A short confirmation of the last thing that worked ("Marked as not eligible"). Errors stay in `errorMessage`.
    private(set) var flashMessage: String?
    var selection: ApplicationSummary.ID? {
        didSet { if let selection { markRead(selection) } }
    }

    /// Jobs you've opened, on this Mac only.
    private(set) var readJobIDs: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "readJobIDs") ?? [])
    func isUnread(_ id: String) -> Bool { !readJobIDs.contains(id) }
    func markRead(_ id: String) {
        guard readJobIDs.insert(id).inserted else { return }
        UserDefaults.standard.set(Array(readJobIDs), forKey: "readJobIDs")
    }
    var sheet: WorkspaceSheet?

    /// Unsaved answer edits by application id. Kept across polling, tab switches and navigation.
    var drafts: [String: AnswerDraft] = [:]
    private(set) var saving: Set<String> = []
    private(set) var saveErrors: [String: String] = [:]
    private(set) var filling: Set<String> = []
    private(set) var details: [String: DetailState] = [:]
    private(set) var listingDetails: [String: ListingDetailState] = [:]
    /// Your unsaved notes by job id, and what happened when you last tried to save them.
    var noteDrafts: [String: String] = [:]
    private(set) var savingNotes: Set<String> = []
    private(set) var noteErrors: [String: String] = [:]
    private var lastActivity: [String: JobActivity] = [:]
    private var flashTask: Task<Void, Never>?
    /// Background-action errors you dismissed, so a poll doesn't bring them back.
    private var dismissedActivityErrors: Set<String> = []
    private(set) var startingChrome = false
    /// A bulk run in progress: how many jobs are finished out of how many.
    private(set) var bulk: BulkProgress?
    private var bulkTask: Task<Void, Never>?

    private var poller: Task<Void, Never>?

    // MARK: derived

    var currentFilter: ApplicationFilter {
        if case let .applications(filter) = section { filter } else { .all }
    }

    var visibleApplications: [ApplicationSummary] { currentFilter.visible(in: applications, search: searchText) }

    /// The selected application, only while it is still in the list you're looking at.
    var selected: ApplicationSummary? {
        guard let selection else { return nil }
        return visibleApplications.first { $0.id == selection }
    }

    var visibleListings: [JobListing] {
        JobList.visible(listings, applications: applicationsByID, filters: jobFilters, sort: jobSort, ascending: jobSortAscending, search: searchText)
    }

    /// The selected job, only while it is still in the jobs list you're looking at.
    var selectedListing: JobListing? {
        guard case .jobs = section, let selection else { return nil }
        return visibleListings.first { $0.id == selection }
    }

    func listing(for id: String) -> JobListing? { listings.first { $0.id == id } }

    /// A background action's failure, until you dismiss it.
    func activityError(for listing: JobListing) -> String? {
        guard let error = listing.activityError, !dismissedActivityErrors.contains("\(listing.id)\n\(error)") else { return nil }
        return error
    }

    func dismissActivityError(_ listing: JobListing) {
        if let error = listing.activityError { dismissedActivityErrors.insert("\(listing.id)\n\(error)") }
    }

    func count(_ filter: ApplicationFilter) -> Int { filter.count(in: applications) }

    var hasUnsavedChanges: Bool {
        drafts.values.contains { $0.isDirty } || editors.values.contains { $0.isDirty } || listings.contains { noteIsDirty($0) }
    }

    func draft(for app: ApplicationSummary) -> AnswerDraft { drafts[app.id] ?? AnswerDraft(app: app) }

    // MARK: lifecycle

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
        hasLoaded = false
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
            async let jobs = client.listings()
            async let info = client.info()
            let (freshApps, freshJobs, freshInfo) = try await (apps, jobs, info)
            // Assign only on change so a quiet poll doesn't re-render the whole window.
            if freshApps != applications { applications = freshApps }
            if freshJobs != listings { announceFinishedWork(in: freshJobs); listings = freshJobs }
            if freshInfo != self.info { self.info = freshInfo }
            hasLoaded = true
            rebaseDrafts(onto: freshApps)
            reconcileSelection()
        } catch {
            // A failed poll is only worth a banner if the engine itself is still supposed to be up.
            if engine.state == .running { errorMessage = error.localizedDescription }
        }
    }

    private func rebaseDrafts(onto apps: [ApplicationSummary]) {
        let byID = Dictionary(uniqueKeysWithValues: apps.map { ($0.id, $0) })
        for (id, var draft) in drafts {
            guard let app = byID[id] else { drafts[id] = nil; continue }
            draft.rebase(onto: app)
            if !draft.isDirty { drafts[id] = nil } else if draft != drafts[id] { drafts[id] = draft }
        }
    }

    /// Drops a selection that is no longer in the list; never moves it to another row.
    func reconcileSelection() {
        guard selection != nil else { return }
        if case .jobs = section {
            if selectedListing == nil { selection = nil }
        } else if selected == nil {
            selection = nil
        }
    }

    // MARK: actions on one application

    func setStatus(_ app: ApplicationSummary, _ status: Status) async { await act { try await $0.setStatus(app.id, status) } }

    /// Sends your edits and confirmations. On failure the draft stays intact and the error is shown with the application.
    @discardableResult
    func saveDraft(_ app: ApplicationSummary) async -> Bool {
        guard let draft = drafts[app.id], draft.isDirty else { return true }
        guard let client, !saving.contains(app.id) else { return false }
        saving.insert(app.id)
        defer { saving.remove(app.id) }
        let sent = draft.changes
        do {
            try await client.saveAnswers(app.id, sent)
            saveErrors[app.id] = nil
            drafts[app.id]?.markSaved(sent)
            await refresh()
            return true
        } catch {
            saveErrors[app.id] = error.localizedDescription
            return false
        }
    }

    /// Fill the form in your Chrome. Edits are saved first; if that fails nothing is filled.
    func fill(_ app: ApplicationSummary) async {
        guard !filling.contains(app.id) else { return }
        filling.insert(app.id)
        defer { filling.remove(app.id) }
        guard await saveDraft(app) else { return }
        await act { try await $0.apply(app.id) } // starts the fill; the status moves on through polling
    }

    // MARK: actions on one job

    /// Your decision about eligibility. Shown at once, then confirmed by the engine; if the engine refuses, it is rolled back.
    func setEligibility(_ id: String, _ eligibility: Eligibility) async {
        let ok = await optimistic(id, { $0.eligibility = eligibility; $0.eligibilitySource = .you }) { try await $0.setEligibility(id, eligibility) }
        if ok { flash("Marked as \(eligibility.label.lowercased())") }
    }

    func markApplied(_ id: String) async {
        let now = Date.now.formatted(.iso8601)
        let ok = await optimistic(id, { $0.appliedAt = $0.appliedAt ?? now }) { try await $0.markApplied(id) }
        if ok { flash("Marked as applied") }
    }

    /// Reads the posting again and updates eligibility. Also what "Analyze job" does for a job nobody has checked.
    func assessJob(_ id: String) async { await act { try await $0.assessListing(id) } }

    /// Jobs a bulk reassess may touch: not applied to, and not decided by you.
    func bulkAssessable(_ jobs: [JobListing]) -> [String] {
        jobs.filter { $0.eligibilitySource != .you && $0.applicationState != .submitted }.map(\.id)
    }

    /// Reassesses many jobs, a few at a time so the engine isn't flooded. Jobs already being worked on are skipped.
    func assessJobs(_ ids: [String], concurrency: Int = 3) {
        guard bulk == nil else { return }
        let todo = ids.filter { listing(for: $0)?.isBusy == false }
        guard !todo.isEmpty else { flash("Nothing to reassess"); return }
        bulk = BulkProgress(title: "Reassessing eligibility", done: 0, total: todo.count)
        bulkTask = Task { [weak self] in
            guard let self else { return }
            var next = 0, done = 0
            var running: [String] = []
            while !Task.isCancelled, next < todo.count || !running.isEmpty {
                let still = running.filter { self.listing(for: $0)?.isBusy == true }
                done += running.count - still.count
                running = still
                while running.count < concurrency, next < todo.count, !Task.isCancelled {
                    let id = todo[next]
                    next += 1
                    if await self.act({ try await $0.assessListing(id) }) { running.append(id) } else { done += 1 }
                }
                self.bulk?.done = done
                try? await Task.sleep(for: .seconds(1))
            }
            let cancelled = Task.isCancelled
            self.bulk = nil
            self.bulkTask = nil
            self.flash(cancelled ? "Stopped after \(done) of \(todo.count). Jobs already started will finish." : "Reassessed \(todo.count) job\(todo.count == 1 ? "" : "s")")
        }
    }

    func cancelBulk() { bulkTask?.cancel() }

    /// "Generate resume": a whole application (resume, form, answers) for a job without one, otherwise just a new resume.
    func generateResume(_ id: String) async {
        if applicationsByID[id] == nil { await act { try await $0.prepareListing(id) } }
        // Clicking Generate on a job flagged "Not a fit" is you saying you want it anyway.
        else { await act { try await $0.regenerateResume(id, force: self.listing(for: id)?.matchFit == "SKIP") } }
    }

    /// Saves the page with the real application form and scans it for questions. An empty link clears it.
    func setApplyLink(_ id: String, _ url: String) async {
        await act { try await $0.setApplyLink(id, url) }
    }

    /// Takes the job off your list. `.listing` keeps its application and files; `.everything` deletes those too.
    func removeJob(_ id: String, scope: RemoveScope) async {
        guard await act({ try await $0.removeListing(id, scope: scope) }) else { return }
        drafts[id] = nil
        noteDrafts[id] = nil
        details[id] = nil
        listingDetails[id] = nil
        if selection == id { selection = nil }
        flash(scope == .everything ? "Job and application deleted" : "Removed from Jobs")
    }

    func viewApplication(_ id: String) {
        section = .applications(.all)
        searchText = ""
        selection = id
    }

    /// Adds a pasted link and shows it. Throws so the add-link sheet can say what went wrong.
    @discardableResult
    func addLink(_ url: String) async throws -> JobListing {
        guard let client else { throw EngineClient.Failure.malformed("the engine isn't running") }
        let added = try await client.addListing(url)
        await refresh()
        section = .jobs
        searchText = ""
        jobFilters = JobFilters()
        selection = added.id
        flash("Added “\(added.title)”")
        return added
    }

    // MARK: notes

    func noteDraft(for job: JobListing) -> String { noteDrafts[job.id] ?? job.userNote ?? "" }
    func noteIsDirty(_ job: JobListing) -> Bool { noteDrafts[job.id].map { $0 != (job.userNote ?? "") } ?? false }

    func saveNote(_ job: JobListing) async {
        guard let client, let draft = noteDrafts[job.id], !savingNotes.contains(job.id) else { return }
        savingNotes.insert(job.id)
        defer { savingNotes.remove(job.id) }
        do {
            try await client.setNote(job.id, draft)
            noteErrors[job.id] = nil
            if noteDrafts[job.id] == draft { noteDrafts[job.id] = nil } // typed more while saving? keep that
            await refresh()
            flash("Note saved")
        } catch {
            noteErrors[job.id] = error.localizedDescription // the draft stays; nothing is lost
        }
    }

    // MARK: feedback

    func flash(_ text: String) {
        flashMessage = text
        flashTask?.cancel()
        flashTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3.5))
            if !Task.isCancelled { self?.flashMessage = nil }
        }
    }

    /// Background work that just ended without an error says so; failures stay on the job until dismissed.
    private func announceFinishedWork(in fresh: [JobListing]) {
        for job in fresh {
            if let before = lastActivity[job.id], job.activity == nil, job.activityError == nil {
                flash("\(job.title): \(before.finishedMessage.lowercased())")
            }
            lastActivity[job.id] = job.activity
        }
    }

    /// Applies `change` to the listing now, asks the engine, and puts the old value back if the engine says no.
    @discardableResult
    private func optimistic(_ id: String, _ change: (inout JobListing) -> Void, _ work: (EngineClient) async throws -> Void) async -> Bool {
        guard let client, let index = listings.firstIndex(where: { $0.id == id }) else { return false }
        let before = listings[index]
        change(&listings[index])
        do {
            try await work(client)
            errorMessage = nil
            await refresh()
            return true
        } catch {
            if let i = listings.firstIndex(where: { $0.id == id }) { listings[i] = before }
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Fetches the cleaned description (and why a job was judged not a fit). Keeps showing the old text while it refreshes.
    func loadListingDetail(_ id: String, force: Bool = false) async {
        if case .loaded = listingDetails[id], !force { return }
        guard let client else { return }
        if case .loaded = listingDetails[id] {} else { listingDetails[id] = .loading }
        do {
            listingDetails[id] = .loaded(try await client.listing(id))
        } catch {
            listingDetails[id] = .failed(error.localizedDescription)
        }
    }

    func loadDetail(_ id: String) async {
        if case .loaded = details[id] { return }
        guard let client else { return }
        details[id] = .loading
        do {
            details[id] = .loaded(try await client.application(id))
        } catch {
            details[id] = .failed(error.localizedDescription)
        }
    }

    // MARK: Chrome

    func startChrome() async {
        guard let client, !startingChrome else { return }
        startingChrome = true
        defer { startingChrome = false }
        do {
            try await client.startJob(.chrome)
        } catch let error as EngineClient.Failure where error.isConflict {
            // already starting
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        for _ in 0..<20 { // the job returns before Chrome is listening
            await refresh()
            if info?.chromeReachable == true { return }
            try? await Task.sleep(for: .seconds(1))
        }
        errorMessage = "Chrome didn't start listening. Try Start Chrome again."
    }

    // MARK: pipeline

    func eligibleJobs() async throws -> [EligibleJob] {
        guard let client else { return [] }
        return try await client.eligibleJobs()
    }

    func run(_ run: PipelineRun) {
        guard let client else { return }
        run.start(client: client) { [weak self] in await self?.refresh() }
    }

    func cancel(_ run: PipelineRun) {
        if let client { run.cancel(client: client) }
    }

    // MARK: library

    func loadEditor(_ doc: LibraryDoc) async { await editors[doc]?.loadIfNeeded(client) }
    func saveEditor(_ doc: LibraryDoc) async { await editors[doc]?.save(client) }

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

struct BulkProgress: Equatable {
    var title: String
    var done: Int
    var total: Int
}
