#!/bin/bash
# Build yellide.mcpb — the Claude Desktop extension bundle.
#
# A sideloaded bundle NEVER auto-updates, and Claude Desktop keeps running the old code
# if the version is unchanged. So the version bump is not optional: forget it and you
# will debug a bug you already fixed. This script refuses to build without one.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="${1:-yellide.mcpb}"

if [ -f "$OUT" ] && unzip -p "$OUT" manifest.json 2>/dev/null | grep -q "\"version\": \"$VERSION\""; then
  echo "refusing to build: $OUT already contains version $VERSION."
  echo "bump \"version\" in manifest.json first — sideloaded bundles do not auto-update."
  exit 1
fi

node --check server/index.js
for f in server/*.js; do node --check "$f"; done
if ! node test/exif.test.js >/dev/null 2>&1; then
  echo "TESTS FAILED — not building. Run: node test/exif.test.js"
  node test/exif.test.js 2>&1 | tail -5
  exit 1
fi
echo "tests pass"

rm -f "$OUT"
zip -qr "$OUT" manifest.json server
echo "built $OUT  v$VERSION  ($(du -h "$OUT" | cut -f1))"
echo
echo "install: drag onto Claude Desktop, or Settings → Extensions → Advanced → Install Extension"
