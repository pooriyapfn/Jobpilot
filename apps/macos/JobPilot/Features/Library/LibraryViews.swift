import SwiftUI

/// Middle pane while a Library document is open: the documents you can edit.
struct LibraryListView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        List(selection: selection) {
            ForEach(LibraryDoc.allCases) { doc in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(doc.title).font(.system(size: 13, weight: .semibold))
                        if store.editors[doc]?.isDirty == true {
                            Circle().fill(.orange).frame(width: 6, height: 6).accessibilityLabel("Unsaved changes")
                        }
                    }
                    Text(doc.path).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                }
                .padding(.vertical, 4)
                .tag(doc)
            }
        }
        .listStyle(.inset)
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                Text("Library").font(.title3.weight(.semibold))
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(.background)
        }
    }

    private var selection: Binding<LibraryDoc?> {
        Binding(
            get: { if case let .library(doc) = store.section { doc } else { nil } },
            set: { if let doc = $0 { store.section = .library(doc) } }
        )
    }
}

/// A plain markdown editor over `knowledge/<path>`, through the engine's knowledge API.
struct LibraryEditorView: View {
    @Environment(AppStore.self) private var store
    let doc: LibraryDoc

    var body: some View {
        if let model = store.editors[doc] {
            Editor(model: model)
                .id(doc)
                .task(id: doc) { await store.loadEditor(doc) }
        }
    }

    private struct Editor: View {
        @Environment(AppStore.self) private var store
        @Bindable var model: KnowledgeEditorModel

        var body: some View {
            VStack(spacing: 0) {
                header
                content
                Divider()
                footer
            }
            .background(.background)
        }

        private var header: some View {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.doc.title).font(.system(size: 22, weight: .semibold))
                Text(model.doc.summary).font(.system(size: 13)).foregroundStyle(.secondary)
                Text("knowledge/\(model.doc.path)").font(.caption.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 12)
        }

        @ViewBuilder private var content: some View {
            switch model.load {
            case .idle, .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .failed(message):
                ContentUnavailableView {
                    Label("Couldn't open \(model.doc.title)", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await store.loadEditor(model.doc) } }
                }
            case .loaded:
                VStack(spacing: 0) {
                    if model.isNewFile {
                        Label("This file doesn't exist yet. Saving creates it.", systemImage: "info.circle")
                            .font(.callout).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 24).padding(.bottom, 8)
                    }
                    TextEditor(text: $model.text)
                        .font(.system(size: 13, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .padding(8)
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator))
                        .padding(.horizontal, 24).padding(.bottom, 12)
                        .accessibilityLabel("\(model.doc.title) markdown")
                }
            }
        }

        private var footer: some View {
            HStack(spacing: 10) {
                if let error = model.saveError {
                    Label("Couldn't save: \(error)", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout).foregroundStyle(.red).lineLimit(2).textSelection(.enabled)
                } else if model.isDirty {
                    Text("Unsaved changes").font(.callout).foregroundStyle(.secondary)
                } else if model.load == .loaded {
                    Text("Saved").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Show in Finder") { reveal() }
                    .disabled(model.isNewFile || store.info == nil)
                Button("Revert") { model.revert() }.disabled(!model.isDirty)
                Button(model.saving ? "Saving…" : "Save") { Task { await store.saveEditor(model.doc) } }
                    .keyboardShortcut("s")
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.isDirty || model.saving || model.load != .loaded)
            }
            .padding(.horizontal, 24).padding(.vertical, 12)
            .background(.bar)
        }

        private func reveal() {
            guard let home = store.info?.home else { return }
            let url = URL(fileURLWithPath: home).appending(path: "knowledge").appending(path: model.doc.path)
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }
}
