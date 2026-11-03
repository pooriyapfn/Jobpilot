import SwiftUI

/// One editable row per form field. Orange = the agent wasn't sure; red star = required.
struct AnswerEditor: View {
    let app: ApplicationSummary
    @Binding var draft: AnswerDraft
    @Binding var focusField: String?
    @FocusState private var focused: String?

    var body: some View {
        let fields = app.fields.filter { $0.type != .file }
        if fields.isEmpty {
            Text("No form fields — open the posting and apply by hand.")
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(fields) { field in
                    FieldRow(
                        field: field, unsure: draft.isUnresolved(field, in: app), value: binding(field), focused: $focused,
                        confirm: { draft.confirm(field.id) }
                    )
                    .id(field.id)
                }
            }
            .onChange(of: focusField) {
                if let id = focusField { focused = id }
            }
            .onChange(of: focused) {
                if focused == nil { focusField = nil }
            }
        }
    }

    private func binding(_ field: FormField) -> Binding<String> {
        Binding(get: { draft.values[field.id] ?? "" }, set: { draft.values[field.id] = $0 })
    }
}

private struct FieldRow: View {
    let field: FormField
    let unsure: Bool
    @Binding var value: String
    var focused: FocusState<String?>.Binding
    let confirm: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(field.label).font(.subheadline.weight(.medium))
                if field.required { Text("*").foregroundStyle(.red).accessibilityLabel("required") }
                Spacer()
                if unsure {
                    Label(value.isEmpty ? "Needs an answer" : "Check this answer", systemImage: "exclamationmark.circle.fill")
                        .font(.caption).foregroundStyle(.orange)
                    if !value.isEmpty {
                        Button("This is correct", action: confirm)
                            .controlSize(.small)
                            .help("Keep this answer as it is, and remember it")
                    }
                }
            }
            control
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(unsure ? Color.orange.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(unsure ? Color.orange.opacity(0.5) : .clear))
    }

    @ViewBuilder private var control: some View {
        switch field.type {
        case .textarea:
            TextEditor(text: $value)
                .font(.body)
                .frame(minHeight: 90)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 6))
                .focused(focused, equals: field.id)
        case .select, .radio:
            Picker(field.label, selection: $value) {
                Text("—").tag("")
                ForEach(options, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden()
            .focused(focused, equals: field.id)
        case .checkbox:
            // The engine ticks a checkbox when the answer is "Yes" / "true".
            Toggle(field.options?.first ?? "Yes", isOn: Binding(
                get: { ["yes", "true"].contains(value.lowercased()) },
                set: { value = $0 ? "Yes" : "No" }
            ))
        case .text, .file:
            TextField(field.label, text: $value)
                .textFieldStyle(.roundedBorder)
                .labelsHidden()
                .focused(focused, equals: field.id)
        }
    }

    /// Declared options, plus the current answer if the agent wrote something not in the list.
    private var options: [String] {
        let declared = field.options ?? []
        return value.isEmpty || declared.contains(value) ? declared : declared + [value]
    }
}
