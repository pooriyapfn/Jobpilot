import Foundation

/// What you've typed in the answer editor vs what the engine has saved.
struct AnswerDraft: Equatable {
    var values: [String: String]
    private(set) var baseline: [String: String]
    /// Uncertain answers you looked at and said "that's right" without changing them.
    private(set) var confirmed: Set<String> = []

    init(app: ApplicationSummary) {
        let current = Dictionary(uniqueKeysWithValues: app.fields.filter { $0.type != .file }.map {
            ($0.id, app.answers[$0.id]?.value ?? "")
        })
        values = current
        baseline = current
    }

    /// Only the fields that changed (the engine remembers these for future jobs).
    var edits: [String: String] { values.filter { baseline[$0.key] != $0.value } }

    /// What gets sent on save: the edits, plus confirmed answers (the engine marks an unchanged unsure value as confident).
    var changes: [String: String] {
        edits.merging(confirmed.compactMap { id in values[id].map { (id, $0) } }) { edit, _ in edit }
    }

    var isDirty: Bool { !changes.isEmpty }

    mutating func confirm(_ id: String) { if let v = values[id], !v.isEmpty { confirmed.insert(id) } }

    /// Fields that still need a human look: blank, or flagged by the agent and not edited or confirmed since.
    func unresolved(in app: ApplicationSummary) -> [FormField] {
        app.fields.filter { $0.type != .file }.filter { isUnresolved($0, in: app) }
    }

    func isUnresolved(_ field: FormField, in app: ApplicationSummary) -> Bool {
        if (values[field.id] ?? "").isEmpty { return true }
        if edits[field.id] != nil || confirmed.contains(field.id) { return false }
        return !(app.answers[field.id]?.confident ?? false)
    }

    /// The engine has new saved answers: take them, but keep what you've typed since the last save.
    mutating func rebase(onto app: ApplicationSummary) {
        let mine = edits
        let fresh = AnswerDraft(app: app)
        values = fresh.values.merging(mine) { _, mine in mine }
        baseline = fresh.baseline
        // A confirmation only matters while the engine still thinks the answer is unsure.
        confirmed = confirmed.filter { !(app.answers[$0]?.confident ?? false) && !(fresh.values[$0] ?? "").isEmpty }
    }

    mutating func markSaved() {
        baseline = values
        confirmed = []
    }

    /// Only what was sent is saved: anything typed while the request was in flight stays an edit.
    mutating func markSaved(_ sent: [String: String]) {
        for (id, value) in sent { baseline[id] = value }
        confirmed.subtract(sent.keys)
    }
}
