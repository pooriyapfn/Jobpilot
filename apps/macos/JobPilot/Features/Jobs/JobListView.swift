import SwiftUI

/// The jobs repository. Rows are custom (not List's saturated selection) so the selected job reads quietly in light and dark.
struct JobListView: View {
    @Environment(AppStore.self) private var store
    @FocusState private var listFocused: Bool

    var body: some View {
        let rows = store.visibleListings
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(rows) { job in
                        JobRow(job: job, app: store.applicationsByID[job.id], selected: store.selection == job.id, listFocused: listFocused)
                            .id(job.id)
                            .onTapGesture { store.selection = job.id; listFocused = true }
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 6)
            }
            .focusable()
            .focused($listFocused)
            .focusEffectDisabled() // the selected row carries the focus cue
            .onKeyPress(.downArrow) { move(1, in: rows, proxy) }
            .onKeyPress(.upArrow) { move(-1, in: rows, proxy) }
            .overlay { emptyState(rows: rows) }
        }
        .safeAreaInset(edge: .top, spacing: 0) { JobListHeader(shown: rows.count) }
        .accessibilityLabel("Jobs")
    }

    /// Up/Down move the selection; the first press with nothing selected picks the first (or last) row.
    private func move(_ step: Int, in rows: [JobListing], _ proxy: ScrollViewProxy) -> KeyPress.Result {
        guard !rows.isEmpty else { return .ignored }
        let current = rows.firstIndex { $0.id == store.selection }
        let next = current.map { min(max($0 + step, 0), rows.count - 1) } ?? (step > 0 ? 0 : rows.count - 1)
        store.selection = rows[next].id
        withAnimation(.snappy(duration: 0.15)) { proxy.scrollTo(rows[next].id) }
        return .handled
    }

    @ViewBuilder private func emptyState(rows: [JobListing]) -> some View {
        let hasSearch = !store.searchText.trimmingCharacters(in: .whitespaces).isEmpty
        if !store.hasLoaded {
            ProgressView("Loading jobs…")
        } else if rows.isEmpty {
            if store.listings.isEmpty {
                ContentUnavailableView {
                    Label("No jobs yet", systemImage: "briefcase")
                } description: {
                    Text("Run a job search, or paste a link to a posting you found yourself.")
                } actions: {
                    Button("Run Job Search…") { store.sheet = .findJobs }.buttonStyle(.borderedProminent)
                    Button("Add Link Manually…") { store.sheet = .addLink }
                }
            } else {
                ContentUnavailableView {
                    Label("No matches", systemImage: "magnifyingglass")
                } description: {
                    Text(hasSearch ? "No job matches “\(store.searchText)”\(store.jobFilters.isActive ? " with these filters" : "")."
                                   : "No job matches these filters.")
                } actions: {
                    if hasSearch { Button("Clear Search") { store.searchText = "" } }
                    if store.jobFilters.isActive { Button("Clear Filters") { store.jobFilters = JobFilters() } }
                }
            }
        }
    }
}

// MARK: header: title + count, filter and sort menus, active-filter chips

private struct JobListHeader: View {
    @Environment(AppStore.self) private var store
    let shown: Int

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Job repository").font(.title3.weight(.semibold))
                Text(countText).font(.callout).foregroundStyle(.secondary).monospacedDigit()
                    .accessibilityLabel(countText)
                Spacer()
            }
            HStack(spacing: 8) {
                filterMenu
                sortMenu
                Spacer(minLength: 0)
            }
            if let bulk = store.bulk { bulkBar(bulk) }
            if store.jobFilters.isActive { chips }
            if let error = store.errorMessage { ErrorBanner(text: error) { store.errorMessage = nil } }
        }
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8)
        .background(.background)
        .overlay(alignment: .bottom) { Divider() }
    }

    private func bulkBar(_ bulk: BulkProgress) -> some View {
        HStack(spacing: 8) {
            ProgressView(value: Double(bulk.done), total: Double(max(bulk.total, 1))).frame(maxWidth: 120)
            Text("\(bulk.title): \(bulk.done) of \(bulk.total)").font(.callout).foregroundStyle(.secondary).monospacedDigit()
            Spacer(minLength: 0)
            Button("Stop") { store.cancelBulk() }.buttonStyle(.link).font(.callout)
        }
    }

    private var countText: String {
        let total = store.listings.count
        return shown == total ? "\(total) job\(total == 1 ? "" : "s")" : "\(shown) of \(total) jobs"
    }

    private var filterMenu: some View {
        @Bindable var store = store
        return Menu {
            Picker("Eligibility", selection: $store.jobFilters.eligibility) {
                Text("Any eligibility").tag(Eligibility?.none)
                ForEach(Eligibility.allCases, id: \.self) { Text($0.label).tag(Eligibility?.some($0)) }
            }
            .pickerStyle(.inline)
            Picker("Fit", selection: $store.jobFilters.fit) {
                Text("Any fit").tag(FitFilter?.none)
                ForEach(FitFilter.allCases) { Text($0.title).tag(FitFilter?.some($0)) }
            }
            .pickerStyle(.inline)
            Picker("Preparation", selection: $store.jobFilters.preparation) {
                Text("Any preparation").tag(PreparationFilter?.none)
                ForEach(PreparationFilter.allCases) { Text($0.title).tag(PreparationFilter?.some($0)) }
            }
            .pickerStyle(.inline)
            Picker("Application", selection: $store.jobFilters.application) {
                Text("Any application state").tag(ApplicationState?.none)
                ForEach(ApplicationState.allCases) { Text($0.label).tag(ApplicationState?.some($0)) }
            }
            .pickerStyle(.inline)
            if store.jobFilters.isActive {
                Divider()
                Button("Clear All Filters") { store.jobFilters = JobFilters() }
            }
        } label: {
            Label(store.jobFilters.isActive ? "Filter (\(store.jobFilters.activeCount))" : "Filter",
                  systemImage: store.jobFilters.isActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .menuStyle(.button).controlSize(.small).fixedSize()
        .help("Filter by eligibility, fit, preparation or application state")
    }

    private var sortMenu: some View {
        @Bindable var store = store
        return Menu {
            Picker("Sort by", selection: $store.jobSort) {
                ForEach(JobSort.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.inline)
            Picker("Order", selection: $store.jobSortAscending) {
                Text(store.jobSort == .company ? "A to Z" : "Oldest first").tag(true)
                Text(store.jobSort == .company ? "Z to A" : "Newest first").tag(false)
            }
            .pickerStyle(.inline)
        } label: {
            Label(store.jobSort.title, systemImage: store.jobSortAscending ? "arrow.up" : "arrow.down")
        }
        .menuStyle(.button).controlSize(.small).fixedSize()
        .help("Sort jobs. Jobs without a posted date always come last.")
    }

    private var chips: some View {
        @Bindable var store = store
        return HStack(spacing: 6) {
            if let e = store.jobFilters.eligibility { chip(e.label) { store.jobFilters.eligibility = nil } }
            if let f = store.jobFilters.fit { chip(f.title) { store.jobFilters.fit = nil } }
            if let p = store.jobFilters.preparation { chip(p.title) { store.jobFilters.preparation = nil } }
            if let a = store.jobFilters.application { chip(a.label) { store.jobFilters.application = nil } }
            Spacer(minLength: 0)
        }
    }

    private func chip(_ text: String, clear: @escaping () -> Void) -> some View {
        HStack(spacing: 4) {
            Text(text).font(.caption)
            Button(action: clear) { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)) }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear filter \(text)")
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(.quaternary.opacity(0.6), in: Capsule())
    }
}

// MARK: row

private struct JobRow: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    let job: JobListing
    let app: ApplicationSummary?
    let selected: Bool
    let listFocused: Bool
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 8) {
                if store.isUnread(job.id) {
                    Circle().fill(Color.accentColor).frame(width: 8, height: 8).padding(.top, 5)
                        .accessibilityLabel("Unread")
                }
                Text(job.title).font(.system(size: 13, weight: .semibold)).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 4)
            }
            Text(job.company).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
            if !job.snippet.isEmpty {
                Text(job.snippet).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2).truncationMode(.tail)
            }
            HStack(spacing: 10) {
                JobDatesLine(listing: job, includeAdded: false)
                Spacer(minLength: 4)
                indicators
                JobAddedAgo(listing: job)
            }
            .padding(.top, 8)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Color.accentColor.opacity(listFocused ? 0.65 : 0.3) : .clear, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .contextMenu { menu }
    }

    private var background: Color {
        if selected { return Color.accentColor.opacity(0.12) }
        return hovering ? Color.primary.opacity(0.05) : .clear
    }

    /// Resume ready, answers to review, applied: small, only when true.
    private var indicators: some View {
        HStack(spacing: 8) {
            if job.activity != nil { ProgressView().controlSize(.mini).accessibilityLabel("Working") }
            if job.userNote != nil { Image(systemName: "note.text").help("You wrote a note").accessibilityLabel("Has your note") }
            if job.resumeReady { Label("Resume ready", systemImage: "doc.text").labelStyle(.titleAndIcon) }
            if let n = app.flatMap({ $0.status == .prepared && $0.needsYou > 0 ? $0.needsYou : nil }) {
                Label("\(n)", systemImage: "exclamationmark.bubble").foregroundStyle(.orange).help("\(n) answer\(n == 1 ? "" : "s") to review")
            }
            if job.applicationState != .notApplied { Label(job.applicationState.label, systemImage: job.applicationState.symbol).foregroundStyle(job.applicationState.tint) }
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    private var accessibilityText: String {
        var parts = [store.isUnread(job.id) ? "Unread" : "", job.title, job.company, job.datesHelp.replacingOccurrences(of: "\n", with: ", ")]
        if job.resumeReady { parts.append("Resume ready") }
        if let n = app.flatMap({ $0.status == .prepared && $0.needsYou > 0 ? $0.needsYou : nil }) { parts.append("\(n) answers to review") }
        if job.applicationState != .notApplied { parts.append(job.applicationState.label) }
        return parts.filter { !$0.isEmpty }.joined(separator: ". ")
    }

    @ViewBuilder private var menu: some View {
        if let url = job.postingURL { Button("Open Job Posting", systemImage: "safari") { openURL(url) } }
        Divider()
        if job.eligibility != .eligible { Button("Mark as Eligible", systemImage: "checkmark.circle") { Task { await store.setEligibility(job.id, .eligible) } } }
        if job.eligibility != .notEligible { Button("Mark as Not Eligible", systemImage: "xmark.circle") { Task { await store.setEligibility(job.id, .notEligible) } } }
    }
}
