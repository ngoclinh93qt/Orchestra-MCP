#!/usr/bin/env bash
# Runs the loopback Agent Bridge MCP server and its OpenAI tunnel together in
# one terminal. Ctrl+C stops both; runtime credentials stay in a 0600 file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="${AGENT_BRIDGE_STATE_DIR:-$HOME/Library/Application Support/Agent Bridge MCP}"
SECRET_FILE="$STATE_DIR/tunnel-client.env"
BRIDGE_PID=""

cleanup() {
  if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ ! -r "$SECRET_FILE" ]; then
  echo "Missing readable tunnel runtime key file: $SECRET_FILE" >&2
  exit 1
fi
if [ "$(stat -f '%Lp' "$SECRET_FILE")" != "600" ]; then
  echo "Refusing to use $SECRET_FILE: expected mode 600." >&2
  exit 1
fi
if ! command -v tunnel-client >/dev/null 2>&1; then
  echo "tunnel-client is not installed or not on PATH." >&2
  exit 1
fi
if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 8787 is already in use. Stop the existing bridge before running this foreground script." >&2
  exit 1
fi

cd "$PROJECT_DIR"
npm run build

CONTROL_PLANE_API_KEY="$(cat "$SECRET_FILE")"
export CONTROL_PLANE_API_KEY
# Secure MCP Tunnel owns the remote connection boundary, so this local bridge
# intentionally does not expose its separate HTTP OAuth provider.
AGENT_BRIDGE_AUTH_MODE=openai-tunnel node --env-file=.env dist/main.js &
BRIDGE_PID="$!"

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "Bridge exited before becoming healthy." >&2
    exit 1
  fi
  sleep 1
done
if ! curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
  echo "Bridge did not become healthy within 30 seconds." >&2
  exit 1
fi

echo "Bridge is running at http://127.0.0.1:8787/mcp"
echo "Starting OpenAI tunnel; press Ctrl+C to stop both processes."
tunnel-client run --profile agent-bridge
