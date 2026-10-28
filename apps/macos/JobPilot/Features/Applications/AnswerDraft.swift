import Foundation

/// What you've typed in the answer editor vs what the engine has saved.
struct AnswerDraft: Equatable {
    var values: [String: String]
    private(set) var baseline: [String: String]

    init(app: ApplicationSummary) {
        let current = Dictionary(uniqueKeysWithValues: app.fields.filter { $0.type != .file }.map {
            ($0.id, app.answers[$0.id]?.value ?? "")
        })
        values = current
        baseline = current
    }

    /// Only the fields that changed (the engine remembers these for future jobs).
    var edits: [String: String] { values.filter { baseline[$0.key] != $0.value } }
    var isDirty: Bool { !edits.isEmpty }

    /// The engine has new saved answers: take them, but keep what you've typed since the last save.
    mutating func rebase(onto app: ApplicationSummary) {
        let fresh = AnswerDraft(app: app)
        values = fresh.values.merging(edits) { _, mine in mine }
        baseline = fresh.baseline
    }

    mutating func markSaved() { baseline = values }
}
