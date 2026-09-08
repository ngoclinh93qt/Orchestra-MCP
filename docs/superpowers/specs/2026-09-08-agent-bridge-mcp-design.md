# Agent Bridge MCP Design

**Date:** 2026-09-08

**Status:** Approved in chat; awaiting written-spec review

## 1. Purpose

Build a private, single-user MCP service that lets ChatGPT control local Codex
CLI and Claude Code sessions on this Mac. The same service has two entry paths:

- local clients connect to `http://127.0.0.1:8787/mcp`;
- ChatGPT on the web connects to `https://mcp.markapidown.net/mcp`, which a
  named Cloudflare Tunnel forwards to the loopback listener.

The service does not call the OpenAI API. ChatGPT use remains within the user's
ChatGPT Business workspace. Codex and Claude Code continue to use their own
installed clients, authentication, subscriptions, and usage limits.

## 2. Scope

Version 1 will:

- start a Codex or Claude Code task in an allowlisted local repository;
- retain a stable bridge task ID and the provider session ID when available;
- stream subprocess events into bounded, persistent local logs;
- report task state and incremental output;
- continue a completed or waiting provider session with a follow-up message;
- cancel a running task;
- expose the tools through MCP Streamable HTTP;
- authenticate remote MCP clients with OAuth 2.1 and PKCE;
- run the bridge and Cloudflare Tunnel as macOS LaunchAgents;
- package the remote endpoint so it can be connected from ChatGPT Web;
- retain the loopback endpoint for local clients.

Version 1 will not:

- run tasks while the Mac is offline or asleep;
- add a cloud queue, Cloudflare Worker, or hosted database;
- bypass Codex sandboxing or Claude Code permission controls;
- expose a raw shell tool;
- provide a browser dashboard;
- merge ChatGPT conversation history with provider session history;
- modify Tobi or make this service part of Tobi Core.

## 3. System boundary

The project lives at `/Users/thief/nik/agent-bridge-mcp`, separate from the
Tobi repository. It is developer infrastructure, not organism state or a Tobi
external faculty.

```text
ChatGPT Desktop / Codex local client
              |
              | http://127.0.0.1:8787/mcp
              v
      +-------------------+
      | Agent Bridge MCP  |
      | auth / tools/jobs |
      +---------+---------+
                |
       +--------+--------+
       |                 |
  Codex adapter      Claude adapter
       |                 |
  codex exec          claude -p

ChatGPT Web
     |
     | https://mcp.markapidown.net/mcp
     v
Cloudflare edge -> named Tunnel -> 127.0.0.1:8787
```

`cloudflared` makes an outbound connection. The bridge never binds a public or
LAN interface.

## 4. Technology

Use TypeScript on Node.js 20 with the official MCP TypeScript SDK and a small
HTTP framework supported by the SDK examples. Use Zod for tool input schemas.
Use SQLite for job metadata, cursors, OAuth grants/tokens, and audit records.
Store append-only provider event logs as JSON Lines files so large output does
not inflate the database.

Build to JavaScript before LaunchAgent execution. Development uses the
TypeScript runner only for tests and local iteration.

## 5. Components

### 5.1 MCP transport

Expose Streamable HTTP at `/mcp`. Sessions are independent of bridge jobs: an
MCP transport session can disappear while a Codex or Claude task continues.
Tool calls return compact structured data and never wait for an entire coding
task to finish.

Also expose:

- `GET /healthz`: process, database, and adapter availability without secrets;
- OAuth discovery and protocol endpoints required by MCP clients;
- no general-purpose administrative HTTP API.

### 5.2 Job supervisor

The supervisor is the single owner of subprocess lifecycle. It:

- validates the requested working directory against configured roots;
- starts exactly one child process per active bridge task;
- captures stdout and stderr without invoking a shell;
- parses provider JSON/JSONL where supported;
- records provider session IDs and normalized status;
- enforces output, duration, and concurrency bounds;
- sends termination, waits for a grace period, then force-terminates only the
  exact child process group belonging to the task;
- marks interrupted processes accurately after bridge restart.

Allowed states are `queued`, `running`, `waiting`, `succeeded`, `failed`,
`cancelled`, and `interrupted`.

### 5.3 Codex adapter

Start new work with `codex exec --json --sandbox workspace-write -C <cwd> -` and
send the prompt over stdin. Do not pass the prompt through command-line shell
parsing. Resume with `codex exec resume <session-id> --json -` after checking
the installed CLI's exact argument order in an adapter contract test.

Do not use `--dangerously-bypass-approvals-and-sandbox`. If a task requires an
operation unavailable under `workspace-write`, it must report the limitation;
version 1 does not remotely escalate it.

### 5.4 Claude adapter

Start new work with `claude -p --output-format stream-json --permission-mode
acceptEdits --permission-prompts none <prompt>` using direct process arguments.
Resume with `--resume <session-id>` after validating the installed CLI contract.

Do not use `--dangerously-skip-permissions`. Operations that still require an
interactive permission are denied and surfaced in task output. A later version
may add an explicit approval protocol, but version 1 will not pretend that a
blocked prompt was approved.

### 5.5 Persistence

Application state defaults to:

`~/Library/Application Support/Agent Bridge MCP/`

It contains:

- `bridge.sqlite3`;
- `logs/<task-id>.jsonl`;
- a generated local configuration file without OAuth plaintext secrets;
- rotated service logs.

SQLite uses WAL mode. Schema migrations are numbered and transactional. The
task record stores provider, working directory, timestamps, state, exit status,
provider session ID, last event cursor, and a redacted error summary. Prompts
and raw output stay local and are never sent anywhere except to the selected
provider CLI and the authenticated MCP caller requesting them.

## 6. MCP tool contract

### `agent_start`

Input: provider (`codex` or `claude`), absolute working directory, prompt, and
optional safe profile. Output: task ID, initial state, and timestamps.

This is a mutating tool and always requires tool approval in ChatGPT.

### `agent_list`

Input: optional provider, state, and bounded limit. Output: compact task
summaries newest first. Read-only.

### `agent_status`

Input: task ID. Output: state, provider, directory, timestamps, exit summary,
provider session availability, and the latest short progress summary. Read-only.

### `agent_output`

Input: task ID, cursor, and bounded event limit. Output: normalized events and
the next cursor. Raw secret-looking values are redacted before return. Read-only.

### `agent_continue`

Input: a terminal or waiting task ID and follow-up message. Output: a new bridge
task ID linked to the parent while resuming the same provider session.

This is mutating and requires approval.

### `agent_cancel`

Input: running task ID. Output: cancellation acceptance and resulting state.
Cancellation is idempotent, mutating, and requires approval.

There is deliberately no `run_shell`, arbitrary executable, environment
override, model override, sandbox bypass, file download, or delete-log tool.

## 7. Directory and process security

Configuration contains explicit allowed roots. A requested directory must:

1. be absolute;
2. exist and be a directory;
3. resolve through `realpath` beneath one allowed root;
4. remain beneath that root after symlink resolution.

The bridge passes a minimal inherited environment plus an explicit allowlist.
It never returns environment variables. Provider credentials remain in their
existing local stores and are not copied into bridge configuration.

Concurrency defaults to one task per provider and two total. Prompts have a
size limit, output is paginated, and logs have rotation/retention limits.

## 8. Authentication

The public MCP endpoint uses MCP-compatible OAuth 2.1:

- Authorization Code flow with PKCE;
- dynamic client registration when required by ChatGPT;
- short-lived access tokens and rotated refresh tokens;
- exact redirect URI validation;
- narrow `agent:read` and `agent:write` scopes;
- a single local owner account;
- hashed authorization codes, refresh tokens, and recovery secret at rest;
- rate limiting and audit records for authentication failures.

Initial owner enrollment happens locally. The owner authenticates the first
remote connection with a generated one-time recovery code shown only on the
Mac. OAuth token responses are never written to normal logs.

The loopback endpoint remains authenticated. A local client may use a separate
keychain-backed bearer token so it does not need an interactive OAuth flow.

Cloudflare Access is not used as a substitute for MCP OAuth in version 1,
because the ChatGPT MCP client must be able to complete and refresh the
protocol-defined authorization flow. Cloudflare still provides TLS termination,
DNS, tunnel routing, and edge protection.

## 9. Cloudflare deployment

Use a named, remotely managed tunnel, not a Quick Tunnel. Configure one route:

```text
mcp.markapidown.net -> http://127.0.0.1:8787
```

The zone must be `markapidown.net`. Add a final catch-all route returning 404.
Install `cloudflared` and the tunnel as a macOS service/LaunchAgent after the
user completes the browser-based Cloudflare authorization step. Store tunnel
credentials with owner-only filesystem permissions.

The bridge LaunchAgent starts before `cloudflared` where practical. Both use
restart-on-failure with bounded retry behavior. Health checks distinguish a
healthy tunnel from a healthy local origin.

## 10. ChatGPT and local client connection

Create a private plugin package that declares the remote HTTP MCP server at:

`https://mcp.markapidown.net/mcp`

The package documents its two write tools and defaults them to approval. It
contains no tunnel credential, provider credential, or OAuth token. Connect and
test it in ChatGPT Web under the user's Business workspace according to the
workspace's plugin/admin controls.

Keep a separate local MCP configuration example pointing to:

`http://127.0.0.1:8787/mcp`

Local configuration is opt-in; remote setup is the version 1 priority.

## 11. Failure behavior

- If the Mac sleeps or loses network, remote calls fail honestly; active local
  provider processes may continue and are reconciled when the bridge resumes.
- If `cloudflared` is healthy but the bridge is down, `/healthz` fails and MCP
  calls do not fall back to an unauthenticated path.
- If a provider CLI is missing or unauthenticated, `agent_start` rejects the
  request before creating a running task.
- If the bridge restarts, child processes it can no longer supervise become
  `interrupted`; it does not guess that they succeeded.
- Malformed provider events are stored as bounded diagnostic events and do not
  crash the bridge.
- Repeated OAuth failures are rate-limited without revealing whether an owner
  credential exists.

## 12. Testing and verification

Automated tests cover:

- path containment, symlink escape, and argument-injection attempts;
- authentication discovery, PKCE, redirect validation, scopes, expiry, refresh
  rotation, and replay rejection;
- tool schemas and read/write annotations;
- job state transitions, restart reconciliation, cancellation, output cursors,
  retention, and concurrency bounds;
- Codex and Claude adapters using fake executables that emit representative
  event streams;
- integration of Streamable HTTP MCP over loopback;
- configuration generation without secrets in tracked files.

Deployment verification covers:

- formatting, type checking, unit tests, and integration tests;
- `curl` health checks on loopback and the public hostname;
- an MCP initialize/list-tools call through the tunnel;
- OAuth connection from ChatGPT Web;
- one read-only smoke task for each installed provider;
- LaunchAgent restart and recovery;
- a final diff and secret scan.

## 13. Rollback

Rollback is recoverable:

- disconnect or remove the private ChatGPT plugin;
- disable the Cloudflare public hostname and tunnel;
- unload the two LaunchAgents;
- stop the bridge;
- retain the local database/log directory unless the user separately requests
  deletion.

No Tobi files, provider credential stores, or coding-agent session stores are
deleted by rollback.

## 14. Acceptance criteria

The setup is complete when:

1. ChatGPT Web can authenticate to `mcp.markapidown.net`.
2. It can list the six MCP tools.
3. A user-approved call can start one safe Codex task and one safe Claude task
   in an allowlisted repository.
4. ChatGPT can poll status/output, continue a provider session, and cancel a
   running task.
5. Neither adapter uses a sandbox/permission bypass flag.
6. The public origin is unavailable without valid OAuth authorization.
7. The bridge and tunnel recover after process restart.
8. Local access remains available at the loopback URL.
9. The complete automated test suite and deployment checks pass.

