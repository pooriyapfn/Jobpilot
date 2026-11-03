import Foundation
import Observation

/// The knowledge documents you can edit in the app. The canonical resume and the experience bank are different files.
enum LibraryDoc: String, CaseIterable, Identifiable, Hashable {
    case profile, baseResume, experienceBank

    var id: String { rawValue }

    var title: String {
        switch self {
        case .profile: "My profile"
        case .baseResume: "Base resume"
        case .experienceBank: "Experience bank"
        }
    }

    var path: String {
        switch self {
        case .profile: "profile.md"
        case .baseResume: "resume/main_resume.md"
        case .experienceBank: "resume/base_resume.md"
        }
    }

    var symbol: String { self == .profile ? "person" : "doc.text" }

    var summary: String {
        switch self {
        case .profile: "Facts about you. The answer agent copies these into application forms."
        case .baseResume: "The canonical resume. Every tailored resume starts from this document."
        case .experienceBank: "Detailed background the tailor can draw on. Separate from the base resume."
        }
    }
}

/// One markdown file: load, edit, save. Lives in the store so unsaved text survives navigation.
@MainActor @Observable
final class KnowledgeEditorModel {
    enum Load: Equatable { case idle, loading, loaded, failed(String) }

    let doc: LibraryDoc
    var text = ""
    private(set) var saved = ""
    private(set) var load: Load = .idle
    private(set) var isNewFile = false
    private(set) var saving = false
    private(set) var saveError: String?

    init(doc: LibraryDoc) { self.doc = doc }

    var isDirty: Bool { text != saved }

    func loadIfNeeded(_ client: EngineClient?) async {
        guard load == .idle || { if case .failed = load { true } else { false } }(), let client else { return }
        load = .loading
        do {
            let document = try await client.knowledge(doc.path)
            text = document.content
            saved = document.content
            isNewFile = false
        } catch let error as EngineClient.Failure where error.isNotFound {
            text = ""
            saved = ""
            isNewFile = true // saving creates it
        } catch {
            load = .failed(error.localizedDescription)
            return
        }
        load = .loaded
    }

    @discardableResult
    func save(_ client: EngineClient?) async -> Bool {
        guard let client, !saving else { return false }
        saving = true
        saveError = nil
        defer { saving = false }
        let content = text
        do {
            try await client.saveKnowledge(doc.path, content: content)
            saved = content
            isNewFile = false
            return true
        } catch {
            saveError = error.localizedDescription
            return false
        }
    }

    func revert() {
        text = saved
        saveError = nil
    }

    func reload(_ client: EngineClient?) async {
        guard !isDirty else { return }
        load = .idle
        await loadIfNeeded(client)
    }
}
