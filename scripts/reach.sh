#!/bin/bash
# What can be known about Yellide's reach without it phoning home.
#
# Every number here is counted by someone else's server as a byproduct of serving a
# request. Nothing is collected by Yellide, and nothing here reveals whether anyone
# actually uses it. See the note at the bottom.
#
#   bash scripts/reach.sh
set -uo pipefail
cd "$(dirname "$0")/.."

REPO=urbanmorph/yellide
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")

echo
echo "  Yellide v$VERSION"
echo "  ------------------------------------------------------------"

if command -v gh >/dev/null 2>&1; then
  gh api "repos/$REPO" --jq '
    "  stars              \(.stargazers_count)
  forks              \(.forks_count)
  watchers           \(.subscribers_count)
  open issues        \(.open_issues_count)"' 2>/dev/null || echo "  github            not reachable"
  gh api "repos/$REPO/traffic/views" --jq '"  repo views 14d     \(.count) (\(.uniques) unique)"' 2>/dev/null
  gh api "repos/$REPO/traffic/clones" --jq '"  clones 14d         \(.count) (\(.uniques) unique)"' 2>/dev/null
else
  echo "  gh not installed, skipping GitHub"
fi

echo
echo "  Cloudflare, in the dashboard rather than here:"
echo "    dash.cloudflare.com -> Workers & Pages -> yellide -> Analytics"
echo "    the number that matters is requests for /yellide.mcpb, which is downloads"

cat <<'NOTE'

  ------------------------------------------------------------
  What none of this tells you

  A download is not an install. An install is not a scan. A scan is
  not a second session. Yellide collects nothing and cannot, so the
  gap between "downloaded" and "used" is invisible on purpose.

  Two things close it without changing that:

    ask       At this scale there is one user. Ask him.
    diagnose  "Run Yellide diagnostics" prints version, platform,
              capabilities and counts, with no filenames, paths or
              search terms. He chooses to send it. That is the only
              usage data that exists, and it moves because a person
              decided it should.

  Clone counts are mostly automated. Do not read them as people.
NOTE
echo
