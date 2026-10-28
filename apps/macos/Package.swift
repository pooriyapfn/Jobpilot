// swift-tools-version: 6.0
// Open this folder in Xcode (File ▸ Open…) or `swift run` / `swift test` from here.
// A signed .app bundle with the engine inside comes with scripts/build-macos.sh (Phase 7).
import PackageDescription

let package = Package(
    name: "JobPilot",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "JobPilot", path: "JobPilot"),
        .testTarget(name: "JobPilotTests", dependencies: ["JobPilot"], path: "Tests/JobPilotTests"),
    ]
)
