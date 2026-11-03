#!/bin/zsh
# Build release binary and wrap it in ~/Applications/JobPilot.app (dev bundle; needs this repo + node on disk).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
swift build -c release --package-path "$ROOT/apps/macos"
BIN="$(swift build -c release --package-path "$ROOT/apps/macos" --show-bin-path)/JobPilot"
APP="$HOME/Applications/JobPilot.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/JobPilot"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>JobPilot</string>
<key>CFBundleExecutable</key><string>JobPilot</string>
<key>CFBundleIdentifier</key><string>dev.jobpilot.app</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PL
codesign --force --sign - "$APP"
echo "Built $APP"
