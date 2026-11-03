import SwiftUI

/// Engine timestamps are ISO 8601, usually with milliseconds.
enum JobDate {
    static func parse(_ text: String?) -> Date? {
        guard let text else { return nil }
        return (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: Date.ISO8601FormatStyle()))
            // Postings sometimes give only a day.
            ?? (try? Date(text, strategy: Date.ISO8601FormatStyle().year().month().day()))
    }

    /// "Oct 26" this year, "Oct 26, 2025" otherwise.
    static func compact(_ date: Date, now: Date = .now) -> String {
        let sameYear = Calendar.current.isDate(date, equalTo: now, toGranularity: .year)
        return sameYear ? date.formatted(.dateTime.month(.abbreviated).day()) : date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    /// "Monday, October 26, 2026", for tooltips and VoiceOver.
    static func full(_ date: Date) -> String { date.formatted(date: .complete, time: .omitted) }
}

extension JobListing {
    var postedDate: Date? { JobDate.parse(datePosted) }
    var addedDate: Date? { JobDate.parse(addedAt) }
    var updatedDate: Date? { JobDate.parse(updatedAt) }
    var appliedDate: Date? { JobDate.parse(appliedAt) }
    var evaluatedDate: Date? { JobDate.parse(evaluatedAt) }
    var postingURL: URL? {
        guard let url = URL(string: url), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host != nil else { return nil }
        return url
    }

    var isBusy: Bool { activity != nil }

    /// "2 days ago", "today".
    var addedAgo: String? {
        guard let d = addedDate else { return nil }
        if Calendar.current.isDateInToday(d) { return "today" }
        return d.formatted(.relative(presentation: .numeric, unitsStyle: .wide))
    }

    /// "Posted Oct 26 · Added Oct 29". A missing posted date says so; it is never replaced by the added date.
    var datesText: String {
        let posted = postedDate.map { "Posted \(JobDate.compact($0))" } ?? "Posted date unknown"
        return [posted, addedAgo.map { "Added \($0)" }].compactMap { $0 }.joined(separator: " · ")
    }

    var postedText: String { postedDate.map { "Posted \(JobDate.compact($0))" } ?? "Posted date unknown" }

    var datesHelp: String {
        [postedDate.map { "Posted \(JobDate.full($0))" } ?? "The posting doesn't give a posted date",
         addedDate.map { "Added to JobPilot \(JobDate.full($0))" }].compactMap { $0 }.joined(separator: "\n")
    }

    /// Application workflow, independent of eligibility and of whether a resume exists.
    var applicationState: ApplicationState {
        if appliedAt != nil || applicationStatus == .submitted { return .submitted }
        if applicationStatus == .filling || activity == .filling { return .inProgress }
        if applicationStatus == .error { return .failed }
        return .notApplied
    }

    var matchLabel: String? {
        switch matchFit {
        case "STRONG_FIT": "Strong fit"
        case "POSSIBLE_FIT": "Possible fit"
        case "SKIP": "Not a fit"
        default: nil
        }
    }
}

// MARK: one place for what each state is called, drawn like, and read out as

enum ApplicationState: String, CaseIterable, Identifiable, Hashable {
    case notApplied, inProgress, submitted, failed
    var id: String { rawValue }

    var label: String {
        switch self {
        case .notApplied: "Not applied"
        case .inProgress: "In progress"
        case .submitted: "Applied"
        case .failed: "Failed"
        }
    }

    var symbol: String {
        switch self {
        case .notApplied: "circle.dashed"
        case .inProgress: "arrow.triangle.2.circlepath"
        case .submitted: "checkmark.seal"
        case .failed: "exclamationmark.triangle"
        }
    }

    var tint: Color {
        switch self {
        case .notApplied: .secondary
        case .inProgress: .orange
        case .submitted: .purple
        case .failed: .red
        }
    }
}

extension Eligibility {
    var label: String {
        switch self {
        case .notEvaluated: "Not evaluated"
        case .eligible: "Eligible"
        case .notEligible: "Not eligible"
        case .review: "Needs review"
        }
    }

    var symbol: String {
        switch self {
        case .notEvaluated: "questionmark.circle"
        case .eligible: "checkmark.circle"
        case .notEligible: "xmark.circle"
        case .review: "exclamationmark.circle"
        }
    }

    /// Green eligible, red not eligible, amber review, neutral not evaluated.
    var tint: Color {
        switch self {
        case .notEvaluated: .secondary
        case .eligible: .green
        case .notEligible: .red
        case .review: .orange
        }
    }

    var meaning: String {
        switch self {
        case .notEvaluated: "Nobody has checked this job's requirements yet."
        case .eligible: "It meets your requirements: remote and open to your location."
        case .notEligible: "It doesn't meet your requirements."
        case .review: "The evidence is mixed. Look at it before you prepare an application."
        }
    }
}

extension EligibilitySource {
    var label: String {
        switch self {
        case .search: "job search"
        case .check: "an eligibility check"
        case .you: "you"
        }
    }
}

/// A small tinted capsule with icon and text (colour is never the only signal).
struct StatusChip: View {
    let text: String
    let symbol: String
    let tint: Color
    var prominent = true

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.system(size: 12, weight: .medium))
            .labelStyle(.titleAndIcon)
            .padding(.horizontal, 8).padding(.vertical, 2.5)
            .background(tint.opacity(prominent ? 0.14 : 0.08), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(prominent ? 0.32 : 0.18), lineWidth: 0.5))
            .foregroundStyle(tint == .secondary ? Color.primary.opacity(0.7) : tint)
            .fixedSize()
    }
}

/// The eligibility badge: identical in list rows and the detail header.
struct EligibilityBadge: View {
    let eligibility: Eligibility

    var body: some View {
        StatusChip(text: eligibility.label, symbol: eligibility.symbol, tint: eligibility.tint)
            .help(eligibility.meaning)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Eligibility: \(eligibility.label). \(eligibility.meaning)")
    }
}

struct ApplicationStateBadge: View {
    let state: ApplicationState

    var body: some View {
        StatusChip(text: state.label, symbol: state.symbol, tint: state.tint, prominent: state != .notApplied)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Application: \(state.label)")
    }
}

/// "Posted Oct 26 · Added Oct 29" with a calendar glyph; full dates in the tooltip.
struct JobDatesLine: View {
    let listing: JobListing
    var includeAdded = true

    var body: some View {
        Label(includeAdded ? listing.datesText : listing.postedText, systemImage: "calendar")
            .labelStyle(.titleAndIcon)
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .help(listing.datesHelp)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(listing.datesHelp.replacingOccurrences(of: "\n", with: ". "))
    }
}

/// "Added 2 days ago", bottom right of a list row.
struct JobAddedAgo: View {
    let listing: JobListing

    var body: some View {
        if let ago = listing.addedAgo {
            Text("Added \(ago)")
                .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                .help(listing.addedDate.map { "Added to JobPilot \(JobDate.full($0))" } ?? "")
        }
    }
}
