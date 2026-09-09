# Repo and Session Read Tools Design

**Date:** 2026-09-08

**Status:** Approved in chat; awaiting written-spec review

## 1. Purpose

The bridge (`docs/superpowers/specs/2026-09-08-agent-bridge-mcp-design.md`) lets
ChatGPT start, watch, continue, and cancel Codex CLI and Claude Code tasks, but
gives it no way to see the repository or prior work on its own — it can only
learn about a project by paying to run a task inside it. Live use surfaced two
concrete gaps:

- ChatGPT cannot read source files or search a repository to build context
  before deciding what task to start.
- ChatGPT cannot see conversation history from Codex or Claude Code sessions
  that were run directly in a terminal, outside the bridge, even though the
  owner may want it to use that history as context.

This adds five read-only tools that close both gaps, without adding any new
mutating capability and without changing anything about the six existing
tools' behavior.

## 2. Scope

This version will:

- add `repo_list`, `repo_read`, and `repo_search`, each confined to the same
  allowlisted roots `agent_start` already validates against;
- add `session_list` and `session_read`, exposing Claude Code's and Codex's
  own on-disk session history, filtered to sessions whose recorded working
  directory falls inside an allowlisted root;
- apply the same key-based secret redaction already used for task event logs
  to both file content and session content;
- exclude `.git`, `.env`/`.env.*`, `node_modules`, and common build/cache
  directories from listing, search, and direct reads;
- report best-effort staleness hints (`lastModifiedAt`, `lastEventHint`) on
  session results, explicitly documented as heuristics, not authoritative
  state.

This version will not:

- add any tool that writes, deletes, or moves a file;
- add a tool that decomposes a goal into subtasks — planning stays entirely
  in ChatGPT's own reasoning, using these read tools plus `agent_start`;
- add a dedicated "review" tool — reviews happen via `agent_start` with a
  review-focused prompt, or via ChatGPT reading code itself;
- expose sessions or files outside the allowlisted roots, even read-only,
  regardless of what else exists on the machine;
- add a system dependency (e.g. `ripgrep`) for `repo_search`;
- change the authentication, scope, or transport model — these are new tools
  under the existing `agent:read` scope, nothing more.

## 3. Why sessions are scoped to allowlisted roots

The owner initially asked for unrestricted access to every Claude Code and
Codex session on the machine. That was reconsidered in favor of scoping to
allowlisted roots: an allowlisted root is a project the owner has already
explicitly granted the bridge access to for running tasks: reading that
project's own prior session history is a natural extension of trust already
given. Unrelated projects' session history was never granted that trust and
may contain unrelated sensitive material; nothing in this design exposes it.

## 4. New tools

All five are `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`, `openWorldHint: false`, and require the `agent:read`
scope — the same annotation and scope profile as `agent_list`/`agent_status`/
`agent_output`. None require approval beyond what the MCP client already
requires for a read-only tool.

### `repo_list`

Input: an absolute path (must resolve inside an allowlisted root, defaults to
the root itself), optional depth limit (default 1, i.e. immediate children
only), optional pagination cursor/limit.
Output: file and directory entries at that path, one level unless a deeper
`depth` is requested, with a `nextCursor` when truncated. Ignored entries
(§6) are never returned.

### `repo_read`

Input: an absolute file path, optional starting line (`cursor`, default 0),
optional line count (`limit`, capped). Output: the requested line range,
`nextCursor`, and `totalLines`. Refuses `.env`/`.env.*` paths and anything
outside an allowlisted root with the same error family `agent_start` already
uses for a bad `cwd`. Refuses binary files (detected by a null byte in the
first read chunk) with a clear error rather than returning garbled content.
Every returned line passes through the existing redaction pass.

### `repo_search`

Input: a literal substring query, an optional starting path (defaults to
allowed roots), a result cap (default 50, hard max 200). Output: matches as
`{file, line, text}`, each `text` truncated to a bounded length and redacted.
Implemented as a pure Node directory walk honoring the same ignore list as
`repo_list` — no external process, no `ripgrep` dependency. `String.includes`
has no backtracking risk and is fast even over a very large tree, so no
separate scan budget is needed for it.

Regex mode was attempted during implementation (with static rejection of the
classic nested-quantifier ReDoS shape, then a `node:vm`-based per-line
execution timeout once the static check proved incomplete), but a final
review found an unresolvable-in-scope risk: there was no cap on total
lines/files scanned per call independent of the match `limit`, so an
ordinary, non-adversarial regex search that doesn't match early — the common
case, not an edge case — could still block the single-threaded server for
70-90 seconds over a large directory tree. Rather than ship regex support in
a still-partially-safe state, it was deferred and removed; only literal
substring search ships for now.

### `session_list`

Input: optional provider filter (`codex` | `claude`), optional cwd filter,
pagination limit. Output: one entry per discovered session — provider,
session id, cwd, `lastModifiedAt`, `lastEventHint`, and (where cheaply
available) a short title/summary — newest-modified first. Only sessions whose
recorded cwd resolves inside an allowlisted root are included; a session
whose cwd cannot be determined is excluded rather than guessed at.

### `session_read`

Input: provider, session id (as returned by `session_list`), cursor, limit.
Output: the session's own JSONL entries over that range, redacted, plus
`nextCursor`. This mirrors `agent_output`'s shape deliberately: both return
paginated, redacted raw provider events rather than a synthesized summary,
so the two tools behave the same way from ChatGPT's side.

## 5. Locating sessions on disk

**Claude Code:** one directory per project under `~/.claude/projects/`, named
by a slug of the project's absolute path (`/` replaced with `-`); one `.jsonl`
file per session inside. The slug is lossy (a literal `-` in a real path
segment is indistinguishable from an original `/`), so the project's real
`cwd` is read from the `cwd` field recorded inside the session's own content
(present on at least its early `system`-type entries), never inferred from
the directory name.

**Codex:** rollout files under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
organized by date rather than by project. Each rollout's `turn_context`
record carries the `cwd` it ran with; a rollout is attributed to that cwd for
allowlist filtering.

Both stores are read directly from disk as plain files — this feature adds no
dependency on either CLI being installed or running, only on their session
files existing in their known locations.

## 6. Ignore list

Applied identically by `repo_list`, `repo_search`, and as an outright refusal
in `repo_read`: `.git`, `.env`, `.env.*`, `node_modules`, `dist`, `build`,
`.next`, `__pycache__`, `.venv`, `target`, `.DS_Store`. This list is fixed in
code for v1, not configurable per request — a caller cannot ask the tool to
skip it.

## 7. Staleness hints are heuristic, not authoritative

Unlike a bridge-started task — which has a real state machine
(`queued/running/waiting/succeeded/failed/cancelled/interrupted`) because the
bridge supervises its process directly — an externally-run terminal session
has no such supervision. `lastModifiedAt` (file mtime) and `lastEventHint`
(best-effort description of the last recorded event, e.g. Codex's
`task_complete`) are the only signals available, and both are documented in
the tool description as non-authoritative. A caller that needs a reliable
finished/not-finished answer must use `agent_start`/`agent_continue` and
`agent_status`, not these tools.

## 8. Testing

- Path/ignore-list containment: symlink escape, `.env` refusal, ignore-list
  exclusion from `repo_list`/`repo_search`, still-readable-if-not-ignored
  cases.
- `repo_read`: pagination correctness, binary-file refusal, redaction of
  secret-looking lines, cursor past end-of-file.
- `repo_search`: literal substring matches, result cap enforcement, ignore
  list honored, no external process spawned.
- Session discovery: cwd extracted from content (not directory name) for a
  fixture Claude Code project directory and a fixture Codex rollout;
  allowlist filtering excludes an out-of-scope fixture session;
  a session with undeterminable cwd is excluded.
- `session_read`: pagination, redaction, correct provider routing.
- Tool schema/annotation tests matching the pattern in
  `test/mcp-tools.test.ts`: all five are read-only, all five require
  `agent:read`, no new write tool was accidentally introduced.

## 9. Acceptance criteria

1. ChatGPT can list and read any file inside an allowlisted root except the
   fixed ignore list, and cannot read anything outside one.
2. ChatGPT can search for a string or pattern across an allowlisted root and
   get bounded, relevant results without an external search binary.
3. ChatGPT can list and read Claude Code and Codex sessions whose cwd is
   inside an allowlisted root, and cannot see sessions from unrelated
   projects.
4. Every one of the five tools is read-only, requires no approval beyond
   what a read-only tool already needs, and is scoped to `agent:read`.
5. Secret-looking content is redacted in both file and session output, using
   the same redaction rule already applied to task event logs.
6. The complete automated test suite passes, including new tests for all
   five tools.
