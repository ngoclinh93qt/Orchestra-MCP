# Operations

This covers running the bridge and its tunnel as macOS background services,
health-checking them, and rolling the whole thing back. It assumes
`npm run verify` passes and `npm run enroll-owner` has already been run once
(see `docs/CONNECT_CHATGPT.md` for connecting clients afterward).

## Install

```bash
cp .env.example .env             # your public URL and your folders; git-ignored
npm run build
scripts/install-cloudflared.sh   # no-op if cloudflared is already on PATH
```

`.env` is the single place this deployment's own settings live.
`scripts/install-services.sh` reads it when rendering the plists and the Codex
plugin's `.mcp.json`, and refuses to run without `AGENT_BRIDGE_PUBLIC_URL`.
Re-run that script after changing a value — the installed plist carries a copy.

Before installing the tunnel LaunchAgent, complete the one-time Cloudflare
login and named-tunnel creation (interactive; needs your Cloudflare account):

```bash
cloudflared tunnel login
cloudflared tunnel create agent-bridge
cp config/cloudflared.example.yml ~/.cloudflared/config.yml
# Edit ~/.cloudflared/config.yml: fill in the real tunnel id and
# credentials-file path that `tunnel create` printed.
cloudflared tunnel route dns agent-bridge mcp.example.com
```

Then install both LaunchAgents:

```bash
scripts/install-services.sh
```

This renders `local.agent-bridge.bridge.plist` and
`local.agent-bridge.tunnel.plist` from the templates in `config/`,
installs them into `~/Library/LaunchAgents`, and starts both immediately via
`launchctl bootstrap`. It is idempotent — running it again cleanly restarts
both services rather than erroring on an already-loaded label. If some other
process already holds the bridge's port, it stops and tells you rather than
installing a service that would crash-loop against it.

## Access policy: which folders the bridge can reach

File access is controlled by one file, edited by you and never by a connected
client:

```
~/Library/Application Support/Agent Bridge MCP/config.json
```

```jsonc
{
  "files": {
    "allow": ["/Users/you/projects"],
    "deny": ["/Users/you/projects/client-nda"]
  }
}
```

- `allow` — absolute paths the bridge may reach. Everything outside them is
  invisible; an empty list means nothing is reachable.
- `deny` — absolute paths carved back out of `allow`. **Deny wins.** A denied
  directory is refused directly, hidden from listings of its allowed parent,
  skipped by search, and rejected as an `agent_start` working directory — so an
  agent cannot be pointed at it to read it on a caller's behalf. A deny entry
  may name a path that does not exist yet; the rule applies the moment it does.

Both lists apply to `repo_list`, `repo_read`, `repo_search`, `session_*`, and
`agent_start` alike. The fixed ignore list (`.git`, `.env*`, `node_modules`,
build output) still applies on top and cannot be switched off.

**Saving the file applies it immediately — no restart.** The bridge logs each
reload. A file that fails to parse or validate is rejected and the previous
policy stays in force, so a typo can never widen access or take the bridge
down; the error is logged (see Logs below).

The file is created on first start. If the legacy
`AGENT_BRIDGE_ALLOWED_ROOTS` environment variable is set, it seeds the initial
`allow` list so an existing deployment keeps the access it had. After that the
file is the only source of truth and the variable is ignored.

## Provider CLIs

A LaunchAgent does not see your shell's PATH (launchd gives it only
`/usr/bin:/bin:/usr/sbin:/sbin`), so the bridge locates each CLI itself at
startup — first on its PATH, then in the usual install locations: Claude Code
in `~/.local/bin`, the Codex CLI inside `/Applications/ChatGPT.app` (or
`Codex.app`), then Homebrew and `/usr/local/bin`. The startup log names the
binary each provider resolved to, or warns that one is missing.

If a CLI lives somewhere else, set `AGENT_BRIDGE_CODEX_BIN` or
`AGENT_BRIDGE_CLAUDE_BIN` to its absolute path in the bridge plist's
`EnvironmentVariables` and restart. An override is used exactly as given: a
wrong path fails loudly rather than quietly falling back to another binary.

Agents run with a minimal environment — `HOME`, `USER`, locale, and a PATH
that adds the bridge's own Node directory, `~/.local/bin`, and Homebrew — and
nothing else from the bridge's environment.

Two things the bridge cannot fix for you:

- Each CLI must be logged in on this Mac (`claude auth status`, `codex login
  status`). A logged-out CLI starts, then fails its task with an
  authentication error.
- Codex refuses to run outside a git repository. Point `agent_start` at a
  repository, not a parent folder of several.

## Health checks

```bash
# Loopback origin
curl -s http://127.0.0.1:8787/healthz

# Public hostname, through the tunnel
curl -s https://mcp.example.com/healthz

# Confirm nothing but the loopback interface is actually listening
lsof -iTCP -sTCP:LISTEN -P | grep 8787
```

A healthy tunnel with a down bridge fails the public health check without
ever falling back to an unauthenticated path — there is no such fallback in
`src/http/app.ts`.

## Logs

```bash
tail -f ~/Library/Application\ Support/Agent\ Bridge\ MCP/logs/agent-bridge.stdout.log
tail -f ~/Library/Application\ Support/Agent\ Bridge\ MCP/logs/agent-bridge.stderr.log
tail -f ~/Library/Application\ Support/Agent\ Bridge\ MCP/logs/agent-tunnel.stdout.log
```

Per-task provider output lives in
`~/Library/Application Support/Agent Bridge MCP/logs/<task-id>.jsonl`,
separately from the two service logs above.

## Restart

```bash
launchctl kickstart -k "gui/$(id -u)/local.agent-bridge.bridge"
launchctl kickstart -k "gui/$(id -u)/local.agent-bridge.tunnel"
```

Both LaunchAgents restart automatically on crash (`KeepAlive.Crashed`), but
not on a clean exit (`KeepAlive.SuccessfulExit: false`) — a deliberate exit
(e.g. from `npm run enroll-owner`'s guidance to restart after re-enrolling)
stays stopped until you kickstart it or reboot triggers `RunAtLoad`.

## Rollback

Each step here is independently reversible and none of them deletes state:

```bash
# 1. Stop and unload both services; removes the two plist files only.
scripts/uninstall-services.sh

# 2. Disable the public hostname (Cloudflare dashboard, or):
cloudflared tunnel route dns --overwrite-dns agent-bridge <somewhere-else>
# or delete the DNS record entirely from the Cloudflare dashboard.

# 3. Remove the private plugin/connector:
codex plugin remove agent-bridge
# and disconnect the custom connector in ChatGPT's own workspace settings.
```

None of the above touches `~/Library/Application Support/Agent Bridge MCP/`
(the SQLite database and event logs) or `~/.cloudflared/` (the tunnel
credentials). Delete those yourself only if you actually want to discard
task history or the tunnel's identity.

## Verifying a deployment end to end

```bash
npm run verify
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.example.com/healthz
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.example.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# ^ expect 401: unauthenticated tool calls must be rejected, even over the tunnel.
```

The bridge now exposes eleven tools (previously six): the original
`agent_start`/`agent_list`/`agent_status`/`agent_output`/`agent_continue`/
`agent_cancel`, plus five read-only context tools — `repo_list`, `repo_read`,
`repo_search`, `session_list`, `session_read`. A successful authenticated
`tools/list` call returns all eleven.
