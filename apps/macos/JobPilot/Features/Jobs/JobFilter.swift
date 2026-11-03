import Foundation

/// Which preparation state to show. Independent of eligibility and of whether you've applied.
enum PreparationFilter: String, CaseIterable, Identifiable, Hashable {
    case resumeReady, needsResume, answersToReview
    var id: String { rawValue }

    var title: String {
        switch self {
        case .resumeReady: "Resume ready"
        case .needsResume: "No resume yet"
        case .answersToReview: "Answers to review"
        }
    }
}

/// The resume tailor's fit classification (STRONG_FIT / POSSIBLE_FIT / SKIP).
enum FitFilter: String, CaseIterable, Identifiable, Hashable {
    case strong = "STRONG_FIT", possible = "POSSIBLE_FIT", skip = "SKIP", unscored
    var id: String { rawValue }

    var title: String {
        switch self {
        case .strong: "Strong fit"
        case .possible: "Possible fit"
        case .skip: "Not a fit"
        case .unscored: "Not scored yet"
        }
    }

    func matches(_ fit: String?) -> Bool { self == .unscored ? fit == nil : fit == rawValue }
}

/// The filter dimensions, each optional and clearable on its own.
struct JobFilters: Equatable {
    var eligibility: Eligibility?
    var preparation: PreparationFilter?
    var application: ApplicationState?
    var fit: FitFilter?

    var isActive: Bool { activeCount > 0 }
    var activeCount: Int { [eligibility != nil, preparation != nil, application != nil, fit != nil].filter { $0 }.count }

    func matches(_ job: JobListing, app: ApplicationSummary?) -> Bool {
        if let eligibility, job.eligibility != eligibility { return false }
        if let application, job.applicationState != application { return false }
        if let fit, !fit.matches(job.matchFit) { return false }
        switch preparation {
        case .none: break
        case .resumeReady: if !job.resumeReady { return false }
        case .needsResume: if job.resumeReady { return false }
        case .answersToReview: if (app?.status == .prepared ? app?.needsYou ?? 0 : 0) == 0 { return false }
        }
        return true
    }
}

enum JobSort: String, CaseIterable, Identifiable, Hashable {
    case dateAdded, datePosted, company, lastUpdated

    var id: String { rawValue }

    var title: String {
        switch self {
        case .dateAdded: "Date added"
        case .datePosted: "Date posted"
        case .company: "Company"
        case .lastUpdated: "Last updated"
        }
    }

    /// Dates start newest first; companies start A–Z.
    var defaultAscending: Bool { self == .company }

    /// Jobs without a posted date always sort last, in either direction. Ties break on id so rows never shuffle.
    func areInOrder(_ a: JobListing, _ b: JobListing, ascending: Bool) -> Bool {
        let order: ComparisonResult
        switch self {
        case .dateAdded: order = Self.compare(a.addedDate, b.addedDate)
        case .lastUpdated: order = Self.compare(a.updatedDate, b.updatedDate)
        case .company: order = a.company.localizedCaseInsensitiveCompare(b.company)
        case .datePosted:
            switch (a.postedDate, b.postedDate) {
            case (nil, nil): order = .orderedSame
            case (nil, _?): return false
            case (_?, nil): return true
            case let (x?, y?): order = Self.compare(x, y)
            }
        }
        if order == .orderedSame { return a.id < b.id }
        return (order == .orderedAscending) == ascending
    }

    private static func compare(_ a: Date?, _ b: Date?) -> ComparisonResult {
        let (x, y) = (a ?? .distantPast, b ?? .distantPast)
        return x == y ? .orderedSame : (x < y ? .orderedAscending : .orderedDescending)
    }
}

enum JobList {
    /// Filters, then a case-insensitive search of title, company, your notes, location and the description preview, then the sort.
    static func visible(
        _ jobs: [JobListing], applications: [String: ApplicationSummary] = [:], filters: JobFilters = JobFilters(),
        sort: JobSort, ascending: Bool? = nil, search: String
    ) -> [JobListing] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let ascending = ascending ?? sort.defaultAscending
        return jobs
            .filter { $0.postedDate != nil } // no posted date, not shown
            .filter { filters.matches($0, app: applications[$0.id]) }
            .filter {
                query.isEmpty || [$0.title, $0.company, $0.userNote ?? "", $0.location ?? "", $0.snippet]
                    .contains { $0.localizedCaseInsensitiveContains(query) }
            }
            .sorted { sort.areInOrder($0, $1, ascending: ascending) }
    }
}
