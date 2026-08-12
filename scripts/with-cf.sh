#!/bin/bash
# Run a command with the Cloudflare credentials from .env.local, without printing them.
#
#   bash scripts/with-cf.sh npx wrangler d1 list
#   bash scripts/with-cf.sh npx wrangler pages deploy site --project-name=yellide
#
# The token is never echoed, never passed on a command line where `ps` would show it, and
# never written anywhere. If .env.local is missing or empty this says so and stops, rather
# than running with no credentials and producing a confusing authentication error.
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "  No $ENV_FILE. Start from the template:"
  echo "    cp .env.example $ENV_FILE && chmod 600 $ENV_FILE"
  exit 1
fi

# A world-readable secret is not a secret.
perms=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null)
if [ "$perms" != "600" ]; then
  echo "  $ENV_FILE is mode $perms. Fixing to 600."
  chmod 600 "$ENV_FILE"
fi

# Refuse to run if it is somehow tracked, which would mean the token is on its way to GitHub.
if git ls-files --error-unmatch "$ENV_FILE" >/dev/null 2>&1; then
  echo "  STOP. $ENV_FILE is tracked by git and this repository is public."
  echo "  Run: git rm --cached $ENV_FILE   then rotate the token, because it may already be pushed."
  exit 1
fi

# Tracing is disabled around the read, so `bash -x` on this script can never print the
# token. It printed one into a transcript once, which is a rotation and an apology.
{ set +x; } 2>/dev/null
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "  CLOUDFLARE_API_TOKEN is empty in $ENV_FILE."
  echo "  Create one at dash.cloudflare.com, My Profile, API Tokens, Create Token, Custom token."
  echo "  Permissions, and nothing beyond them:"
  echo "    Account  D1                 Edit"
  echo "    Account  Workers Scripts    Edit"
  echo "    Account  Cloudflare Pages   Edit"
  echo "    Account  Account Analytics  Read"
  exit 1
fi

if [ $# -eq 0 ]; then
  echo "  Credentials loaded. Pass a command, for example:"
  echo "    bash scripts/with-cf.sh npx wrangler whoami"
  exit 0
fi

exec "$@"
