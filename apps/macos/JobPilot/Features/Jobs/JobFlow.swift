import Foundation

/// Where a job is being viewed from. Removing a job belongs to the jobs repository only.
enum DetailContext { case jobs, applications }

enum JobAction: Equatable {
    case analyze, generateResume, reviewAnswers, fillInChrome, applyByHand, viewApplication, reassess

    var title: String {
        switch self {
        case .analyze: "Analyze job"
        case .generateResume: "Generate resume"
        case .reviewAnswers: "Review answers"
        case .fillInChrome: "Fill in Chrome"
        case .applyByHand: "Open & apply by hand"
        case .viewApplication: "View application"
        case .reassess: "Reassess eligibility"
        }
    }
}

/// What the footer offers: one dominant action, or why there isn't one.
enum JobNextStep: Equatable {
    case action(JobAction)
    case working(String)
    case unavailable(String)
}

enum JobFlow {
    /// The next step, derived from the job's real eligibility, preparation and application state. Never more than one.
    static func next(job: JobListing?, app: ApplicationSummary?, unresolvedAnswers: Int, context: DetailContext) -> JobNextStep {
        if let job, let activity = job.activity { return .working(job.activityStep ?? activity.defaultStep) }

        let applied = job?.applicationState == .submitted || app?.status == .submitted
        if applied {
            if app != nil, context == .jobs { return .action(.viewApplication) }
            let when = job?.appliedDate.map { " on \(JobDate.compact($0))" } ?? ""
            return .unavailable("Applied\(when).")
        }
        if app?.status == .filling { return .unavailable("Review the form in Chrome, then submit it there.") }

        switch job?.eligibility ?? .eligible {
        case .notEvaluated: return .action(.analyze)
        case .notEligible: return .action(.reassess)
        case .review:
            // Mixed evidence: you may still go ahead once an application is prepared. Otherwise look again first.
            guard app != nil else { return .action(.reassess) }
        case .eligible: break
        }

        guard let app else { return .action(.generateResume) }
        let hasResume = job?.resumeReady ?? (app.resumeURL.map { FileManager.default.fileExists(atPath: $0.path) } ?? false)
        if !hasResume { return .action(.generateResume) }
        if app.status == .closed { return .unavailable("The posting is closed.") }
        guard app.canApply else { return .unavailable(app.status.label) }
        if app.status == .manual { return .action(.applyByHand) }
        return .action(unresolvedAnswers > 0 ? .reviewAnswers : .fillInChrome)
    }

    /// Why the dominant action can't run right now, if it can't.
    static func disabledReason(for action: JobAction, chromeUp: Bool, hasKey: Bool) -> String? {
        switch action {
        case .fillInChrome: chromeUp ? nil : "Start Chrome first. It's needed to fill the form."
        case .generateResume: hasKey ? nil : "Add OPENROUTER_API_KEY to .env.local in your data folder to generate resumes."
        case .analyze, .reassess: nil
        case .reviewAnswers, .viewApplication, .applyByHand: nil
        }
    }
}

extension JobActivity {
    var defaultStep: String {
        switch self {
        case .assessing: "Checking the posting…"
        case .preparing: "Preparing the application…"
        case .regenerating: "Generating the resume…"
        case .filling: "Filling in Chrome…"
        case .scanning: "Scanning the application form…"
        }
    }

    /// "Generating resume", for list rows and notices.
    var title: String {
        switch self {
        case .assessing: "Checking eligibility"
        case .preparing: "Preparing application"
        case .regenerating: "Generating resume"
        case .filling: "Filling in Chrome"
        case .scanning: "Scanning application form"
        }
    }

    var finishedMessage: String {
        switch self {
        case .assessing: "Eligibility checked"
        case .preparing: "Application prepared"
        case .regenerating: "Resume generated"
        case .filling: "Chrome session ended"
        case .scanning: "Application form scanned"
        }
    }
}
