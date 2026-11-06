import SwiftUI

/// Sidebar → application list → selected application, in one native split view.
struct WorkspaceView: View {
    @Environment(AppStore.self) private var store
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var confirmBulk = false

    var body: some View {
        @Bindable var store = store
        NavigationSplitView(columnVisibility: $columns) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 260)
        } content: {
            Group {
                switch store.section {
                case .jobs: JobListView()
                case .applications: ApplicationListView()
                case .library: LibraryListView()
                }
            }
            .navigationSplitViewColumnWidth(min: 320, ideal: 380, max: 480)
        } detail: {
            switch store.section {
            case .jobs:
                if let job = store.selectedListing {
                    JobDetailView(id: job.id, context: .jobs).id(job.id)
                } else {
                    ContentUnavailableView(
                        "Select a job",
                        systemImage: "briefcase",
                        description: Text("Choose a job from the list to view its details and prepare your application.")
                    )
                }
            case .applications:
                if let app = store.selected {
                    JobDetailView(id: app.id, context: .applications).id(app.id)
                } else {
                    ContentUnavailableView(
                        "Select an application",
                        systemImage: "doc.text.magnifyingglass",
                        description: Text("Choose one from the list to review its tailored resume and answers.")
                    )
                }
            case let .library(doc):
                LibraryEditorView(doc: doc)
            }
        }
        .navigationTitle(store.section.title)
        .searchable(text: $store.searchText, placement: .toolbar, prompt: store.section == .jobs ? "Search jobs (title, company, keywords…)" : "Search applications")
        .toolbar {
            ToolbarItem {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.refresh() } }
                    .keyboardShortcut("r")
                    .help("Refresh jobs and applications")
            }
            ToolbarItem {
                Menu {
                    Button("Prepare eligible jobs…", systemImage: "doc.badge.gearshape") { store.sheet = .prepare }
                    if store.section == .jobs {
                        let count = store.bulkAssessable(store.visibleListings).count
                        Button("Reassess eligibility of \(count) shown job\(count == 1 ? "" : "s")…", systemImage: "arrow.clockwise") { confirmBulk = true }
                            .disabled(count == 0 || store.bulk != nil)
                    }
                    Button("Start Chrome", systemImage: "globe") { Task { await store.startChrome() } }
                        .disabled(store.info?.chromeReachable == true || store.startingChrome)
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
                .help("Prepare the jobs already found, or start the Chrome JobPilot fills forms in")
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Run job search", systemImage: "magnifyingglass") { store.sheet = .findJobs }
                        .keyboardShortcut("f", modifiers: [.command, .option])
                        .help("Find new jobs with AI")
                    Button("Add link manually", systemImage: "link") { store.sheet = .addLink }
                        .keyboardShortcut("n", modifiers: [.command, .option])
                        .help("Paste a job URL to add it")
                } label: {
                    Label("Add Job", systemImage: "plus").labelStyle(.titleAndIcon)
                }
                .menuStyle(.button)
                .buttonStyle(.borderedProminent)
                .help("Search for new jobs, or add a posting by its link")
            }
        }
        .overlay(alignment: .bottom) {
            if let text = store.flashMessage {
                Label(text, systemImage: "checkmark.circle.fill")
                    .font(.callout)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(.separator, lineWidth: 0.5))
                    .padding(.bottom, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .animation(.snappy, value: store.flashMessage)
        .confirmationDialog("Reassess \(store.bulkAssessable(store.visibleListings).count) jobs?", isPresented: $confirmBulk, titleVisibility: .visible) {
            Button("Reassess") { store.assessJobs(store.bulkAssessable(store.visibleListings)) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Reads each posting again and updates its eligibility, three at a time. Jobs you marked yourself and jobs you applied to are left alone. Use the filters or search first to pick which jobs.")
        }
        .sheet(item: $store.sheet) { sheet in
            switch sheet {
            case .findJobs: FindJobsSheet()
            case .prepare: PrepareSheet()
            case .addLink: AddLinkSheet()
            }
        }
        .onChange(of: store.section) { store.reconcileSelection() }
        .onChange(of: store.searchText) {
            // Searching only makes sense in the jobs and application lists.
            if case .library = store.section, !store.searchText.isEmpty { store.section = .jobs }
            store.reconcileSelection()
        }
        .frame(minWidth: 960, minHeight: 600)
    }
}
