# Connecting ChatGPT, Codex, and Claude Code

This bridge exposes one MCP server two ways: over loopback at
`http://127.0.0.1:8787/mcp` for clients on this Mac, and over
`https://mcp.example.com/mcp` for ChatGPT Web via the Cloudflare Tunnel
(see `docs/OPERATIONS.md`). Both paths use the same eleven tools and the same
OAuth server; only how a client authenticates differs. Replace the example
hostname below with your own, the one you set in `.env`.

Run `npm run enroll-owner` once before connecting anything. It prints a
recovery code (approves the OAuth flow below) and a local bearer token
(skips OAuth entirely for loopback clients) — save both in your password
manager immediately, since neither is shown again.

## What a "private plugin" file can and cannot do here

`.agents/plugins/marketplace.json` and `plugins/agent-bridge/` in this
repository are a real, installable **local Codex CLI plugin** — this exact
two-file layout (a marketplace manifest whose `plugins[].source.path` points
at a sibling `plugins/<name>/` directory, itself holding
`.codex-plugin/plugin.json` and `.mcp.json`) was verified by actually running
`codex plugin marketplace add` / `codex plugin add` against this repository
in an isolated `CODEX_HOME`, not assumed from documentation. The `.mcp.json`
shape (`type: "http"`, `url`, `oauth_resource`) matches how Codex's own
Notion connector declares its remote MCP server. What none of this can do is
make this connector appear inside ChatGPT Web's own connector list — no
local file can add itself to ChatGPT's UI. Connecting ChatGPT Web is a manual
step your Business workspace admin does once, in ChatGPT's own settings.
Both paths are covered below.

## 1. Codex CLI on this Mac (local plugin)

This repository is a personal Codex plugin marketplace of one plugin, at
`.agents/plugins/marketplace.json`. The plugin's `.mcp.json` is rendered from
`.mcp.json.template` with your own public URL by
`scripts/install-services.sh`, so run that first. From the repository root:

```bash
codex plugin marketplace add .
codex plugin add agent-bridge@agent-bridge-marketplace
```

This installs the `agent-bridge` skill (`skills/agent-bridge/SKILL.md`) and
registers the remote MCP server declared in `.mcp.json`
(`https://mcp.example.com/mcp`) with Codex. The first tool call will walk
you through the OAuth flow in a browser: Codex opens the authorization page,
you enter the recovery code from enrollment, and Codex stores the resulting
token itself.

To remove it later: `codex plugin remove agent-bridge`.

### Prefer loopback instead of the public tunnel?

See `config/codex.local.example.toml` — either copy its `codex mcp add`
command or its `[mcp_servers.agent-bridge-local]` block into
`~/.codex/config.toml` yourself. This talks to `127.0.0.1:8787` directly
using the local bearer token, with no OAuth round trip and no dependency on
Cloudflare being up.

## 2. Claude Code on this Mac

Claude Code has no plugin-marketplace step for this; add the server
directly:

```bash
export AGENT_BRIDGE_LOCAL_TOKEN="<the local bearer token from enroll-owner>"
claude mcp add --transport http agent-bridge-local http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer $AGENT_BRIDGE_LOCAL_TOKEN"
```

Prefer sourcing `AGENT_BRIDGE_LOCAL_TOKEN` from your keychain or password
manager rather than a plaintext shell profile entry. To use the public
tunnel with real OAuth instead of the local token, use `--transport http`
with the `https://mcp.example.com/mcp` URL and omit `--header`; Claude
Code will run the OAuth flow itself and prompt for the recovery code on the
same approval page.

## 3. ChatGPT Web (Business workspace)

This is the one step only a workspace admin can do, in ChatGPT's own UI —
there is nothing to install or upload from this repository:

1. Sign in to the ChatGPT Business workspace as an admin.
2. Open **Settings → Connectors**, and use the option to add a **custom
   connector** (workspace admin settings; the exact label has moved before
   and may again — look for "custom connector," "developer mode," or
   "add MCP server").
3. Enter the server URL: `https://mcp.example.com/mcp`.
4. ChatGPT performs OAuth discovery against that URL automatically (this
   bridge advertises `/.well-known/oauth-authorization-server` and supports
   dynamic client registration, so no client ID needs to be entered by
   hand) and opens the authorization page in a browser tab.
5. Enter the recovery code from enrollment to approve the connection.
6. In the chat composer, enable the connector for the conversation. The
   eleven tools are `repo_list`, `repo_read`, `repo_search`, `session_list`,
   `session_read` (read-only), and `agent_start`, `agent_list`,
   `agent_status`, `agent_output`, `agent_continue`, `agent_cancel` — `agent_start`,
   `agent_continue`, and `agent_cancel` will always prompt for your approval
   before running, because they are declared as mutating tools
   (`readOnlyHint: false`) in `src/mcp/tool-schemas.ts`; ChatGPT decides how
   to surface that approval, not this bridge.

ChatGPT keeps the tool list it fetched when the connector was added. After
the bridge gains or changes tools, open the connector in ChatGPT's settings
and refresh it; otherwise ChatGPT keeps offering only the old tools. A
connector added before the `repo_*` tools existed will, for example, try to
read files by starting an agent instead.

If the workspace does not expose custom connectors at all, custom MCP
servers may be restricted by workspace policy; that is a workspace
administration setting outside this project's control.

## Security notes

- Every write tool requires approval by design; there is deliberately no way
  to mark one auto-approved from this side of the connection.
- Revoking access: an OAuth-issued token can be revoked from the bridge's
  `/revoke` endpoint (or by an OAuth-aware client's own "disconnect"
  action); the local bearer token and recovery code are rotated together by
  re-running `npm run enroll-owner`, which invalidates the previous values.
- None of the files in this repository (`.mcp.json`, `plugin.json`, this
  document) ever contain a real token, client secret, or recovery code.
