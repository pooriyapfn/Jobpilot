import Foundation

/// The four sidebar filters. Counts and lists come from engine data only (see BUILD_SPEC §4).
enum ApplicationFilter: String, CaseIterable, Identifiable, Hashable {
    case all, ready, needsInput, submitted

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: "All applications"
        case .ready: "Ready to review"
        case .needsInput: "Needs your input"
        case .submitted: "Submitted"
        }
    }

    var symbol: String {
        switch self {
        case .all: "doc.text"
        case .ready: "doc.text.magnifyingglass"
        case .needsInput: "exclamationmark.bubble"
        case .submitted: "paperplane"
        }
    }

    func includes(_ app: ApplicationSummary) -> Bool {
        switch self {
        case .all: true
        case .ready: app.status == .prepared
        case .needsInput: app.status == .prepared && app.needsYou > 0 // a subset of .ready
        case .submitted: app.status == .submitted
        }
    }

    func count(in apps: [ApplicationSummary]) -> Int { apps.filter(includes).count }

    /// Newest first (stable: ties break on id), narrowed by a case-insensitive company/title search.
    func visible(in apps: [ApplicationSummary], search: String) -> [ApplicationSummary] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return apps
            .filter(includes)
            .filter { query.isEmpty || $0.company.localizedCaseInsensitiveContains(query) || $0.title.localizedCaseInsensitiveContains(query) }
            .sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }
    }
}
