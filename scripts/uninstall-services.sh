#!/usr/bin/env bash
# Stops and unloads both LaunchAgents and removes their plist files. Never touches the bridge's
# state directory (database, event logs), the Codex/Claude session stores, or the Cloudflare
# tunnel credentials file — rollback is recoverable, not destructive.
#
# Override LAUNCH_AGENTS_DIR to target a directory other than the real ~/Library/LaunchAgents
# (used by tests).
set -euo pipefail

LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL_UID="$(id -u)"
LABELS=(net.markapidown.agent-bridge net.markapidown.agent-tunnel)

for LABEL in "${LABELS[@]}"; do
  launchctl bootout "gui/$LAUNCHCTL_UID/$LABEL" >/dev/null 2>&1 || true
  PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    echo "Removed $PLIST"
  fi
done

echo "Services stopped and unloaded. Database, logs, and Cloudflare tunnel credentials were left untouched."
