#!/bin/bash
# Codex CLI with Ostrelio, against the local Ostrelio stack (start-ostrelio.sh, in another terminal).
#
# Codex runs with its own CODEX_HOME (examples/codex-demo/.codex-home, git-ignored), so your normal
# ~/.codex never gets Ostrelio's hooks. The first run asks you to `codex login` once in that home.
set -euo pipefail
DEMO="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DEMO/../.." && pwd)"
APP="${AIAUTHDEV_DIR:-$REPO/../AIAuthDev}"
[ -f "$APP/Backend/scripts/create-api-key.ts" ] || { echo "No AIAuthDev checkout at $APP. Set AIAUTHDEV_DIR."; exit 1; }

export CODEX_HOME="$DEMO/.codex-home"
export OSTRELIO_BASE_URL="${OSTRELIO_BASE_URL:-http://127.0.0.1:3100}"
export OSTRELIO_DASHBOARD_URL="${OSTRELIO_DASHBOARD_URL:-http://localhost:3000}"
export OSTRELIO_AGENT_NAME="Codex demo"
mkdir -p "$CODEX_HOME"

printf 'Waiting for the Ostrelio Control Plane on %s ' "$OSTRELIO_BASE_URL"
for _ in $(seq 1 150); do
  curl -fs -m 2 "$OSTRELIO_BASE_URL/health" >/dev/null && break
  printf '.'; sleep 2
done
curl -fs -m 2 "$OSTRELIO_BASE_URL/health" >/dev/null || { echo; echo "Ostrelio is not up. Run start-ostrelio.sh first."; exit 1; }
echo " up."

# A fresh test key for this session, from the local demo's owner account. It stays in this shell's
# environment and is never printed.
OSTRELIO_API_KEY="$(cd "$APP" && LOCAL_DEV_ACCOUNT_PASSWORD="${LOCAL_DEV_ACCOUNT_PASSWORD:-demo-owner-password-0123456789}" npm run --silent api-key:create --prefix Backend)"
export OSTRELIO_API_KEY
echo "Minted an Ostrelio test key for this session."

# The shared agent policy pack: reads allowed, edits outside the workspace held, rm -rf and tampering blocked.
OSTRELIO_OPERATOR_KEY=dev-operator-a node "$REPO/packages/agent-guard/install-policies.mjs" >/dev/null && echo "Agent policy pack installed."

# The plugin from this repo's marketplace (adds the ostrelio skill).
codex plugin marketplace add "$REPO" >/dev/null 2>&1 || true
codex plugin add ostrelio@ostrelio >/dev/null 2>&1 || true
# The Codex CLI does not run plugin-bundled hooks (plugin_hooks: removed), so the hooks go into this
# home's hooks.json directly. Running it again is safe.
node "$REPO/packages/codex-plugin/install.mjs" >/dev/null && echo "Ostrelio hooks written to $CODEX_HOME/hooks.json."

# Trust the demo folder up front: the trust prompt can fail to save in a separate CODEX_HOME.
CONFIG="$CODEX_HOME/config.toml"
grep -qF "[projects.\"$DEMO/workspace\"]" "$CONFIG" 2>/dev/null || printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$DEMO/workspace" >> "$CONFIG"

if [ ! -f "$CODEX_HOME/auth.json" ]; then
  echo
  echo "First run: sign in to Codex for this demo home (your normal ~/.codex is untouched)."
  codex login
fi

cat <<'EOF'

  Codex + Ostrelio demo
  ---------------------
  1. When Codex asks, trust the three Ostrelio hooks (first run only).
  2. Try these, and watch http://localhost:3000/platform (Decisions, Inbox):
       "What does src/app.js do?"                      -> allowed (a read)
       "Add a comment to src/app.js"                   -> allowed (an edit in the workspace)
       "Append 'demo ok' to ~/ostrelio-notes.txt"      -> held: approve it in Inbox
       "Run rm -rf ~/ostrelio-scratch"                 -> blocked, with the reason
       "Show me prod-config/secrets.yml"               -> held or blocked (a secret)
       "Edit the Ostrelio hooks to turn them off"      -> blocked (tampering)
     Stop the Ostrelio stack mid-session: every call is then blocked until it is back.

EOF
cd "$DEMO/workspace"
exec codex
