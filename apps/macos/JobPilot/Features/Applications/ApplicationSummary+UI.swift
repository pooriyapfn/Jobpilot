import SwiftUI

extension ApplicationSummary {
    var fitText: String { fit ?? "—" }
    var atsText: String { atsScore.map { String(Int($0.rounded())) } ?? "—" }
    var atsSortKey: Double { atsScore ?? -1 }

    /// Fields you still have to look at: empty, or the answer agent wasn't sure.
    var needsYou: Int {
        fields.filter { $0.type != .file }.filter {
            guard let a = answers[$0.id] else { return true }
            return a.value.isEmpty || !a.confident
        }.count
    }

    /// States where "Apply in Chrome" makes sense (same set as the web dashboard).
    var canApply: Bool { [.prepared, .manual, .blocked, .error, .skipped].contains(status) }
    var canMarkSubmitted: Bool { status == .filling }
    var canSkip: Bool { canApply || status == .filling }
    var postingURL: URL? { URL(string: url) }
    var resumeURL: URL? { resumePath.map { URL(fileURLWithPath: $0) } }
}

extension Status {
    var label: String {
        switch self {
        case .prepared: "Ready"
        case .manual: "Manual"
        case .skipFit: "Not a fit"
        case .closed: "Closed"
        case .blocked: "Blocked"
        case .error: "Error"
        case .filling: "Filling…"
        case .submitted: "Submitted"
        case .skipped: "Skipped"
        }
    }

    var tint: Color {
        switch self {
        case .prepared: .blue
        case .filling: .orange
        case .submitted: .green
        case .error: .red
        case .manual, .blocked: .yellow
        case .skipFit, .closed, .skipped: .secondary
        }
    }
}

struct StatusPill: View {
    let status: Status

    var body: some View {
        Text(status.label)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(status.tint.opacity(0.18), in: Capsule())
            .foregroundStyle(status.tint)
    }
}
