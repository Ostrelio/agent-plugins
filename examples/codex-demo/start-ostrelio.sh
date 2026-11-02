#!/bin/bash
# Starts the local Ostrelio stack for the Codex demo: Control Plane on :3100, dashboard on :3000.
# Needs an AIAuthDev checkout (AIAUTHDEV_DIR, default ../AIAuthDev next to this repo) with
# `npm install` done. Reviewers are simulated and the built-in demo agent is off, so the dashboard's
# Decisions page shows Codex's calls only.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${AIAUTHDEV_DIR:-$REPO/../AIAuthDev}"
[ -f "$APP/scripts/demo.mjs" ] || { echo "No AIAuthDev checkout at $APP. Set AIAUTHDEV_DIR."; exit 1; }
cd "$APP"
export DEMO_NO_OPEN=1 REVIEWER_SIMULATION="${REVIEWER_SIMULATION:-1}" DEMO_AGENT=0
exec npm run demo
