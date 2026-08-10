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

# A hardcoded version literal in server/ reported 0.9.5 to diagnostics and 0.1.0 to the MCP
# handshake for four releases. Both must come from manifest.json.
if grep -nE "=\s*['\"][0-9]+\.[0-9]+\.[0-9]+['\"]" server/*.js; then
  echo "refusing to build: hardcoded version literal above. Read it from manifest.json."
  exit 1
fi

node --check server/index.js
for f in server/*.js; do node --check "$f"; done
for t in test/*.test.js; do
  if ! node "$t" >/dev/null 2>&1; then
    echo "TESTS FAILED — not building. Run: node $t"
    node "$t" 2>&1 | tail -20
    exit 1
  fi
done
echo "tests pass"
# Print the safety audit on every build, so nobody ships without reading it.
node test/safety.test.js

rm -f "$OUT"
zip -qr "$OUT" manifest.json icon.png server
echo "built $OUT  v$VERSION  ($(du -h "$OUT" | cut -f1))"

# The site is the ONLY channel by which anyone learns a new version exists, so it must
# never lag the bundle. It did once: the site said 0.9.5 while 0.9.6 was shipping.
cp "$OUT" site/yellide.mcpb
python3 - "$VERSION" <<'PY'
import pathlib, re, sys
version = sys.argv[1]
changed = []
for f in pathlib.Path('site').glob('*.html'):
    s = f.read_text()
    new = re.sub(r'(<b class="ver">)[^<]*(</b>)', r'\g<1>' + version + r'\g<2>', s)
    new = re.sub(r'(version\s{2,})\d+\.\d+\.\d+', r'\g<1>' + version, new)
    # every mention of the filename, not just the download attribute — the prose beside
    # it drifted once. changelog.html is exempt: its old version numbers are history.
    if f.name != 'changelog.html':
        new = re.sub(r'yellide-\d+\.\d+\.\d+\.mcpb', 'yellide-' + version + '.mcpb', new)
    if new != s:
        f.write_text(new); changed.append(f.name)
site = pathlib.Path('site/llms.txt')
print('  stamped %s into: %s' % (version, ', '.join(changed) or '(nothing to change)'))
stale = [f.name for f in pathlib.Path('site').glob('*.html')
         if re.search(r'\d+\.\d+\.\d+', f.read_text()) and f.name != 'changelog.html'
         and version not in f.read_text()]
if stale:
    print('  WARNING: a version number that is not %s survives in: %s' % (version, stale))
PY
echo "  site/yellide.mcpb updated"
echo
echo "install: drag onto Claude Desktop, or Settings → Extensions → Advanced → Install Extension"
