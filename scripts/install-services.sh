#!/usr/bin/env bash
# Renders and installs both LaunchAgents (the bridge, then the tunnel), starting each fresh.
# Idempotent: bootout-then-bootstrap means running this twice converges to the same running
# state rather than erroring on an already-loaded label.
#
# Override LAUNCH_AGENTS_DIR to install into a directory other than the real
# ~/Library/LaunchAgents (used by tests to avoid touching real launchd state).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL_UID="$(id -u)"
LABELS=(net.markapidown.agent-bridge net.markapidown.agent-tunnel)

mkdir -p "$LAUNCH_AGENTS_DIR"

echo "Rendering LaunchAgent plists into $LAUNCH_AGENTS_DIR ..."
RENDER_TARGET_DIR="$LAUNCH_AGENTS_DIR" RENDER_PROJECT_DIR="$PROJECT_DIR" \
  npx tsx "$SCRIPT_DIR/render-launch-agents.ts"

for LABEL in "${LABELS[@]}"; do
  PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
  if [ ! -f "$PLIST" ]; then
    echo "Missing rendered plist: $PLIST" >&2
    exit 1
  fi
  launchctl bootout "gui/$LAUNCHCTL_UID/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$LAUNCHCTL_UID" "$PLIST"
  launchctl enable "gui/$LAUNCHCTL_UID/$LABEL"
  echo "Installed and started $LABEL"
done
