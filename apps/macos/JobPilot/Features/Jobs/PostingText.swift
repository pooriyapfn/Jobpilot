import SwiftUI

/// The cleaned posting text: "## Heading", "- bullet", blank line between paragraphs. Selectable, readable, no markup.
struct PostingText: View {
    let text: String

    private enum Block: Identifiable {
        case heading(Int, String), paragraph(Int, String), bullets(Int, [String])
        var id: Int {
            switch self {
            case let .heading(i, _), let .paragraph(i, _), let .bullets(i, _): i
            }
        }
    }

    private var blocks: [Block] {
        var out: [Block] = []
        var bullets: [String] = []
        func flush() { if !bullets.isEmpty { out.append(.bullets(out.count, bullets)); bullets = [] } }
        for chunk in text.components(separatedBy: "\n\n") {
            for line in chunk.split(separator: "\n", omittingEmptySubsequences: true).map(String.init) {
                if line.hasPrefix("## ") { flush(); out.append(.heading(out.count, String(line.dropFirst(3)))) }
                else if line.hasPrefix("- ") { bullets.append(String(line.dropFirst(2))) }
                else { flush(); out.append(.paragraph(out.count, line)) }
            }
            flush()
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks) { block in
                switch block {
                case let .heading(_, t):
                    Text(t).font(.headline).padding(.top, 6).accessibilityAddTraits(.isHeader)
                case let .paragraph(_, t):
                    Text(t).font(.body).lineSpacing(3)
                case let .bullets(_, items):
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("•").foregroundStyle(.secondary)
                                Text(item).font(.body).lineSpacing(3)
                            }
                        }
                    }
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
