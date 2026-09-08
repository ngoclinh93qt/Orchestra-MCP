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

# The Node binary baked into the bridge plist and the Node ABI native modules (better-sqlite3)
# are compiled against must be the exact same binary, or the service crash-loops on startup with
# an ERR_DLOPEN_FAILED that only shows up in the LaunchAgent's own log, not here. Check that
# before installing anything, rather than silently install a plist that will crash-loop. This is
# a load check only — it never rebuilds or otherwise mutates node_modules from an install script.
NODE_BIN="${RENDER_NODE_BIN:-$(command -v node)}"
echo "Checking better-sqlite3 loads under $("$NODE_BIN" --version) ($NODE_BIN) ..."
if ! "$NODE_BIN" -e "require(process.argv[1])" "$PROJECT_DIR/node_modules/better-sqlite3" >/dev/null 2>&1; then
  echo "better-sqlite3's compiled binary does not match $NODE_BIN's ABI." >&2
  echo "Fix: cd $PROJECT_DIR && $(dirname "$NODE_BIN")/npm rebuild better-sqlite3" >&2
  echo "Or set RENDER_NODE_BIN to whichever node the current build already matches." >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR"

echo "Rendering LaunchAgent plists into $LAUNCH_AGENTS_DIR ..."
RENDER_TARGET_DIR="$LAUNCH_AGENTS_DIR" RENDER_PROJECT_DIR="$PROJECT_DIR" RENDER_NODE_BIN="$NODE_BIN" \
  npx tsx "$SCRIPT_DIR/render-launch-agents.ts"

for LABEL in "${LABELS[@]}"; do
  PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
  if [ ! -f "$PLIST" ]; then
    echo "Missing rendered plist: $PLIST" >&2
    exit 1
  fi
  launchctl bootout "gui/$LAUNCHCTL_UID/$LABEL" >/dev/null 2>&1 || true

  # bootout is asynchronous: launchd can take a moment to actually release the label, and an
  # immediately-following bootstrap intermittently fails with a transient EIO ("Input/output
  # error") while that's still settling. Retry briefly instead of leaving the service down.
  BOOTSTRAPPED=0
  for ATTEMPT in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$LAUNCHCTL_UID" "$PLIST" 2>/dev/null; then
      BOOTSTRAPPED=1
      break
    fi
    sleep 1
  done
  if [ "$BOOTSTRAPPED" -ne 1 ]; then
    echo "Failed to bootstrap $LABEL after retries" >&2
    exit 1
  fi

  launchctl enable "gui/$LAUNCHCTL_UID/$LABEL"
  echo "Installed and started $LABEL"
done
