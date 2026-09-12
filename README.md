# Agent Bridge MCP

A local MCP server that lets a remote client — ChatGPT on the web, Codex CLI,
Claude Code — read a folder on your Mac and run Codex or Claude Code tasks in
it, under access rules only you can change.

It runs as a macOS LaunchAgent bound to `127.0.0.1`, and is reached from the
internet only through a Cloudflare Tunnel you own, with OAuth in front of every
tool call.

## What it is for

ChatGPT can reason about your code but cannot see it. Pasting files into a chat
does not scale, and giving a hosted assistant a shell on your laptop is not a
trade most people want to make. This bridge takes the middle path: a fixed set
of tools, a folder allowlist you edit by hand, and no way for the connected
client to widen its own access.

## Security model

The whole design follows from one rule: **the client is not trusted to decide
what it may reach.**

- **Authorization lives on the server.** Which folders are reachable is read
  from a config file on your Mac. No tool can edit it. A client can only ask
  for a path — never grant itself one.
- **Deny wins.** A denied path is refused directly, hidden from listings of its
  allowed parent, skipped by search, and rejected as a task's working
  directory — so an agent cannot be pointed at it to read it on your behalf.
- **Loopback only.** The HTTP server binds `127.0.0.1` and refuses to start on
  any other host. Public reachability is the tunnel's job, not the server's.
- **Every call is authenticated.** Remote clients use OAuth 2.1 with PKCE,
  dynamic client registration, and rotating refresh tokens; loopback clients
  may use a local bearer token instead. There is no unauthenticated fallback
  path.
- **Secrets are stored hashed.** Authorization codes, tokens, the recovery
  code, and the local bearer token exist in plaintext exactly once, when they
  are issued. The database keeps only SHA-256 hashes.
- **Output is redacted.** File content, session history, and task output all
  pass through the same secret-redaction rule before leaving the machine.
- **No shell tool.** There is deliberately no `run_shell`, no arbitrary
  executable, and no tool that writes a file. Code changes happen only through
  a supervised Codex or Claude Code task, which the MCP client prompts you to
  approve.

Nothing in this repository contains a real token, client secret, recovery code,
or tunnel credential — see [What is not in this repository](#what-is-not-in-this-repository).

## Tools

Every request needs the `agent:read` scope; the three tools that change
something additionally require `agent:write`, so a read-only token cannot start
or cancel a task. Those three are also annotated as non-read-only, which is
what makes an MCP client prompt for approval before running them.

| Tool | Read-only | What it does |
|---|---|---|
| `repo_list` | yes | List files and directories under an allowed path |
| `repo_read` | yes | Read a file by line range |
| `repo_search` | yes | Literal substring search across an allowed path |
| `session_list` | yes | List Codex / Claude Code terminal sessions in allowed folders |
| `session_read` | yes | Read one session's history |
| `agent_list` | yes | List bridge tasks |
| `agent_status` | yes | Status of one task |
| `agent_output` | yes | Paginated, redacted output of one task |
| `agent_start` | no | Start a Codex or Claude Code task in an allowed folder |
| `agent_continue` | no | Send a follow-up to a finished or waiting task |
| `agent_cancel` | no | Cancel a running task |

`.git`, `.env*`, `node_modules`, and common build output are excluded from
listing and search, and refused by `repo_read`. That list is fixed in code; a
caller cannot ask to skip it.

## Requirements

- macOS with the Codex CLI and/or Claude Code installed **and logged in**. The
  bridge starts them; it cannot log in for them.
- Node 26 (`.nvmrc`). `better-sqlite3` is a native module, so the Node that
  runs the service must match the Node it was built against.
- A Cloudflare account and a domain, only if you want remote access. Loopback
  clients work without one.

## Quick start

```bash
npm install
npm run verify        # typecheck, tests, build
npm run enroll-owner  # prints a recovery code and a local bearer token, once
```

Save both printed values in a password manager immediately. They are not shown
again, and neither can be recovered from the database.

Then install the LaunchAgents, and the tunnel if you want remote access:

```bash
scripts/install-services.sh
```

Full deployment steps, including the one-time Cloudflare setup, are in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Choosing what the bridge can reach

One file, edited by you and never by a connected client:

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

Saving the file applies it immediately — no restart. A file that fails to parse
is rejected with a logged reason, and the previous policy stays in force, so a
typo can neither widen access nor take the bridge down. An empty `allow` list
means nothing is reachable.

## Connecting a client

[docs/CONNECT_CHATGPT.md](docs/CONNECT_CHATGPT.md) covers all three: ChatGPT on
the web (a workspace admin adds a custom connector), Codex CLI (this repo is
also a local Codex plugin marketplace), and Claude Code.

## Development

```bash
npm run verify     # typecheck + full test suite + build
npm test           # tests only
```

Tests never touch a real provider CLI, a real network, or real launchd state —
a fake agent fixture stands in for Codex and Claude Code.

Layout:

```
src/auth/        OAuth server, local bearer token, enrollment
src/policy/      the access policy and its hot-reloading config file
src/repo/        path containment, ignore list, file reading and search
src/sessions/    reading Codex and Claude Code session history off disk
src/supervisor/  task lifecycle, process spawning, cancellation
src/mcp/         tool schemas and registration
docs/superpowers/  the design specs and plans this was built from
```

## What is not in this repository

By design, and enforced by `.gitignore`:

- OAuth tokens, the recovery code, and the local bearer token — they live only
  in the state directory's SQLite database, and only as hashes.
- Cloudflare tunnel credentials — they live in `~/.cloudflared/`.
- Task output and event logs — they live in the state directory.
- The rendered LaunchAgent plists, which contain absolute local paths. Only the
  templates in `config/` are committed.

## A note on the committed hostname

`mcp.markapidown.net` appears throughout `config/`, `docs/`, and as the default
`AGENT_BRIDGE_PUBLIC_URL` — it is the author's own tunnel hostname. If you
deploy this yourself, replace it with yours: it is only a default, and the
bridge accepts any HTTPS `/mcp` URL through `AGENT_BRIDGE_PUBLIC_URL`.

## License

None yet. All rights reserved by the author until one is chosen.
