---
name: agent-bridge
description: Use the private Agent Bridge MCP connector to start, watch, continue, or cancel a Codex CLI or Claude Code task on the owner's Mac. Use when the user asks to run, check on, follow up with, or stop a coding-agent task through this connector.
---

# Agent Bridge

This connector controls two local coding agents — Codex CLI and Claude Code —
running on one specific Mac, through eleven tools: the six task-control tools
`agent_start`, `agent_list`, `agent_status`, `agent_output`, `agent_continue`,
`agent_cancel`, plus five read-only context tools (`repo_list`, `repo_read`,
`repo_search`, `session_list`, `session_read` — see "Reading context
directly" below). There is no shell tool, no arbitrary executable, and no
sandbox-bypass flag anywhere behind this connector: every task runs under the
provider's own normal sandboxing or permission controls.

## Before starting anything

1. Call `agent_list` first to see what is already running or recently
   finished. Do not start a duplicate task for something already in flight.
2. A task's working directory must be an absolute path inside a directory the
   owner has already allowlisted on the bridge. If the owner names a project
   by a short name only, ask for (or confirm) the absolute path rather than
   guessing one.
3. `agent_start`, `agent_continue`, and `agent_cancel` are mutating tools and
   will prompt for approval. Say plainly what will run and where before the
   approval prompt appears, so the approval is meaningful rather than a
   formality.

## While a task runs

- Task IDs returned by `agent_start` and `agent_continue` are the only handle
  you have on that task. Keep the exact ID and mention it back to the user;
  never invent or guess one.
- Poll actual state with `agent_status` and read progress with `agent_output`
  (paginate using the returned `nextCursor`). Do not report a task as done,
  failed, or waiting unless `agent_status` actually says so — a task that
  looks quiet may simply not have produced output yet.
- Terminal states are `succeeded`, `failed`, `cancelled`, and `interrupted`.
  `interrupted` means the bridge restarted while the task was active; it is
  not the same as a normal failure and does not have a provider session to
  resume in every case — check `hasProviderSession` on the status summary.

## Reading context directly

Before starting a task, or whenever more context would help, read the
repository or prior session history directly instead of guessing:

- `repo_list` / `repo_read` / `repo_search` — browse and read files inside an
  allowlisted root. `.git`, `node_modules`, `.env*`, and build/cache
  directories are never shown or readable.
- `session_list` / `session_read` — see and read Claude Code/Codex sessions
  that were run directly in a terminal, not through this connector, but only
  ones whose working directory is inside an allowlisted root. The
  `lastEventHint` and `lastModifiedAt` fields on a session are best-effort
  signals, not a reliable finished/not-finished status — for that, use
  `agent_start`/`agent_continue` and `agent_status` instead.

None of these five tools require approval; none of them can write, delete,
or move anything.

## Continuing and cancelling

- `agent_continue` only works on a task that is `waiting` or has already
  reached a terminal state AND has `hasProviderSession: true`. If the parent
  task never got that far (e.g. it was interrupted before the provider
  reported a session), say so instead of retrying blindly.
- `agent_cancel` is idempotent: cancelling an already-finished task is safe
  and simply returns its current state, it does not error.

## What this connector will never do

- It will not run a raw shell command, download a file, or read environment
  variables back to you.
- It will not bypass Codex's sandbox or Claude Code's permission prompts; a
  task that hits a blocked operation reports that limitation in its output
  instead of silently working around it.
- It will not merge this conversation's history into the coding agent's own
  session — each task's provider session is its own separate context.
