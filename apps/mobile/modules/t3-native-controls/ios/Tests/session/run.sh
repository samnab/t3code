#!/bin/sh
# Builds the mock AVFoundation and runs the session harness against a session source.
# Usage: ./run.sh [path/to/T3RealtimeVoiceSession.swift]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src=${1:-$here/../../T3RealtimeVoiceSession.swift}
out=$(mktemp -d)
xcrun swiftc -emit-library -emit-module -module-name AVFoundation "$here/MockAVFoundation.swift" \
  -o "$out/libAVFoundation.dylib" -emit-module-path "$out/AVFoundation.swiftmodule"
xcrun swiftc -I "$out" -L "$out" -lAVFoundation -Xlinker -rpath -Xlinker "$out" \
  -parse-as-library "$here/SessionHarness.swift" "$src" -o "$out/harness" 2>&1 || exit 2
"$out/harness"
