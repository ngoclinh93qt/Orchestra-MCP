#!/usr/bin/env bash
# Installs cloudflared via Homebrew only if it is not already on PATH. Idempotent: running this
# twice does nothing the second time.
set -euo pipefail

if command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared already installed: $(command -v cloudflared)"
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install cloudflared manually:" >&2
  echo "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 1
fi

echo "Installing cloudflared via Homebrew..."
brew install cloudflared
