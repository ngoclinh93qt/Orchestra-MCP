# OMP Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OMP as an Agent Bridge provider that can run the configured Gemma 4 model, report task progress, and continue the exact OMP session.

**Architecture:** Add an OMP `ProviderAdapter` and integrate its provider name into the existing MCP, runtime discovery, profile policy, and session-store paths. Launch OMP as a shell-free subprocess in print plus JSON mode, passing the user's model selector only through `--model`. Keep OMP's normal configuration and credential store, and fail closed if the CLI cannot meet the bridge's write-boundary and approval requirements.

**Tech Stack:** TypeScript, Node.js `child_process`, Zod, Vitest, OMP 18.2.11 JSONL CLI.

**Spec:** `docs/superpowers/specs/2026-09-25-omp-provider-design.md`

## Global Constraints

- The bridge never invokes a shell.
- The bridge must use the owner's existing OMP configuration and credentials; it must not copy credentials into Agent Bridge configuration.
- Never pass API keys in command arguments.
- Never use `--auto-approve` or `--approval-mode yolo`.
- Fail closed for approval requests that cannot be handled through the existing MCP interaction.
- Verify that OMP write tools cannot modify files outside the requested allowlisted working directory; if OMP cannot enforce that boundary, stop and present the limitation for a design decision.
- Do not infer task success from an assistant message; use the authoritative end/result event and process exit status.
- Existing `codex` and `claude` task records, MCP inputs, and session behavior remain valid.
- OMP model identifiers are not validated against a baked-in list because the available catalog depends on the owner's OMP provider and configuration.

## Review Focus

- OMP writes outside the requested working directory — Task 1 performs a controlled scratch-directory behavioral probe; implementation stops if it cannot prove the boundary.
- OMP asks for approval for a shell command in print mode — Task 1 proves the process fails closed without hanging; Task 5 repeats this as a bridge smoke check.
- Session IDs are prefixes or file paths rather than canonical IDs — Tasks 1 and 2 capture an OMP JSON header and prove resume targets only that session.
- OMP JSON records contain secrets or malformed future events — Task 2 pins malformed-line and unknown-event behavior; Tasks 3–4 assert persisted event/session output is redacted.
- LaunchAgent omits OMP profile/state environment — Task 3 verifies only the required OMP state selectors are inherited, while arbitrary API-key variables remain excluded.

---

### Task 1: Verify the installed OMP CLI contract and safety gate

**Files:**
- No repository files; this task records verified results in the implementation notes before code work begins.

**Interfaces:**
- Consumes: the installed `/Users/thief/.local/bin/omp` CLI, version 18.2.11, and the user's configured Gemma 4 model.
- Produces: a verified model selector, JSON event/header shapes, exact-session resume syntax, the active OMP session directory/profile layout, and a safe non-interactive approval/write policy for Tasks 2–5.

- [ ] **Step 1: Confirm the Gemma 4 model selector and flags**

Run `omp models --help` and `omp models`, then identify the exact Gemma 4 selector from OMP's output. Confirm `omp --help` still reports `--model`, `--mode json`, `--print`, `--resume`, `--approval-mode`, and `--cwd`. Do not substitute a guessed model alias.

- [ ] **Step 2: Capture one bounded JSONL session in a disposable allowlisted directory**

Set shell variable `OMP_GEMMA4_MODEL` to the exact Gemma 4 selector printed by `omp models`; never guess the selector. Create a disposable root with `mktemp -d`, then create `repo` and `canary` directories under it and save their absolute paths in `OMP_PROBE_ROOT`, `OMP_PROBE_REPO`, and `OMP_PROBE_CANARY`. Run `omp --print --mode json --approval-mode write --cwd "$OMP_PROBE_REPO" --model "$OMP_GEMMA4_MODEL" "Create bridge-omp-probe.txt in the current workspace containing the text probe-complete, then finish."` Save stdout/stderr and the exit code as local investigation output only; do not add machine-specific output to the repository. Record the session-header fields, session identifier, start/end event types, and whether the final event marks an error.

- [ ] **Step 3: Prove the write boundary and headless approval behavior**

In a second disposable root, set `OMP_PROBE_ROOT`, `OMP_PROBE_REPO`, and `OMP_PROBE_CANARY` to fresh root/repo/canary paths as in Step 2. Start one task with the same OMP flags and model selector, asking it to write one uniquely named file to the canary directory and run `pwd`. Confirm the canary file remains absent and the shell approval request terminates without waiting for interactive input. If either result cannot be established, stop here and bring the observed limitation back to the user; do not implement an OMP adapter that claims to preserve bridge policy.

- [ ] **Step 4: Verify exact-session resume**

Run a follow-up against the captured session using OMP's documented resume syntax and a unique continuation prompt. Confirm the JSON stream identifies the same session and the CLI does not select a different latest session. Record the exact safe argument order for Task 2.

**Expected result:** Tasks 2–5 proceed only if OMP prints a parseable stable session identifier, resumes the exact session, keeps writes inside the requested working directory, and exits without hanging on shell approvals. If not, revise the spec with the user before writing provider code.

---

### Task 2: Implement and verify the OMP provider adapter

**Files:**
- Create: `src/providers/omp.ts`
- Modify: `src/providers/provider.ts` to add `"omp"` to `ProviderName`
- Create: `test/omp-adapter.test.ts`
- Create or extend: `test/fixtures/omp-events.jsonl`

**Interfaces:**
- Consumes: `StartInput { cwd, prompt, model? }`, `ContinueInput { cwd, prompt, providerSessionId }`, and the event/session shapes captured in Task 1.
- Produces: `OmpAdapter implements ProviderAdapter`, with `name: "omp"`, shell-free start/resume argument builders, `checkAvailable()`, and safe JSONL event normalization.

- [ ] **Step 1: Add failing invocation tests**

Add tests asserting a model-bearing start uses the verified OMP executable and contains `--print`, `--mode`, `json`, `--approval-mode`, `write`, `--cwd`, the selected working directory, `--model`, the exact caller model string, and the prompt as a single trailing argument. Assert that a start without `model` omits `--model`; prompt contents do not get interpolated or split; no shell, `--auto-approve`, or `yolo` flag is present. Add a resume test asserting the exact captured session selector appears before the trailing prompt and no new model is passed.

- [ ] **Step 2: Run the adapter tests and confirm the expected failure**

Run: `npm test -- --run test/omp-adapter.test.ts`

Expected: FAIL because `OmpAdapter` does not exist.

- [ ] **Step 3: Add captured JSONL fixtures and parser tests**

Store representative, sanitized JSONL records from Task 1. Add one parser test for session capture, one for assistant/tool progress, one for successful completion, one for an error completion, one malformed JSON line, and one unknown future event. Each test must assert normalized event objects and prove a malformed record does not throw. Keep actual prompt text, credentials, absolute home paths, and file contents out of fixtures.

- [ ] **Step 4: Implement OmpAdapter**

Implement argument arrays directly from Task 1's verified CLI grammar. Use OMP's machine-readable mode for stdout, keep stdin empty if the verified CLI consumes the prompt as an argument, and return the exact session ID from the verified session header. Normalize only event shapes established by the fixtures; return unknown/diagnostic events for everything else. `checkAvailable()` probes `omp --version` with the same bounded timeout and `ProviderUnavailableError` behavior as the existing adapters.

- [ ] **Step 5: Run the adapter tests and inspect the diff**

Run: `npm test -- --run test/omp-adapter.test.ts`

Expected: PASS; existing Codex and Claude adapter files remain unchanged.

---

### Task 3: Register OMP across MCP, runtime discovery, and execution profiles

**Files:**
- Modify: `src/domain/task.ts`
- Modify: `src/providers/runtime.ts`
- Modify: `src/main.ts`
- Modify: `src/mcp/tool-schemas.ts`
- Modify: `src/mcp/register-tools.ts`
- Modify: `src/supervisor/job-supervisor.ts`
- Modify: `src/policy/execution-profiles.ts`
- Modify: `test/providers/provider-runtime.test.ts`
- Modify: `test/policy/execution-profiles.test.ts`
- Modify: `test/mcp-tools.test.ts`
- Modify: `test/job-supervisor.test.ts`

**Interfaces:**
- Consumes: `OmpAdapter` from Task 2 and the existing optional `agent_start.model` field.
- Produces: provider literal `"omp"`; runtime fields `ompCommand` and `AGENT_BRIDGE_OMP_BIN`; OMP provider policy/profile support; registered adapter available to `JobSupervisor`.

- [ ] **Step 1: Add failing provider runtime tests**

Add cases proving an explicit executable `AGENT_BRIDGE_OMP_BIN` wins, an invalid explicit override does not fall back to PATH, an executable named `omp` on PATH resolves, and `~/.local/bin/omp` is a default candidate. Assert runtime child environment includes `PI_CODING_AGENT_DIR` and `OMP_PROFILE` only when present, while an unrelated `GEMINI_API_KEY` from the parent is not inherited.

- [ ] **Step 2: Run the runtime tests and confirm failure**

Run: `npm test -- --run test/providers/provider-runtime.test.ts`

Expected: FAIL on missing OMP runtime fields and candidates.

- [ ] **Step 3: Add failing provider/profile/schema cases**

Add tests proving `Provider` and MCP task provider schemas accept `omp`, unknown values remain rejected, the optional model remains accepted on `agent_start`, OMP execution profiles validate, and an OMP profile is rejected when OMP policy is disabled. Add a supervisor test whose fake adapter records `newInvocation` input and assert `model: "gemma4-test"` reaches it unchanged from `start`. Keep legacy Codex/Claude defaults and serialized configs valid. Leave `session_list` and `session_read` provider schema cases to Task 4.

- [ ] **Step 4: Run relevant tests and confirm failure**

Run: `npm test -- --run test/policy/execution-profiles.test.ts test/mcp-tools.test.ts`

Expected: FAIL only on the new OMP cases.

- [ ] **Step 5: Implement provider/runtime/policy registration**

Add `omp` to provider types and task MCP provider enums; add `model?: string` to `AgentStartArgs` and `StartRequest`, expose optional non-empty `model` in the `agent_start` schema, and pass it through `JobSupervisor.start()` into `StartInput.model`; add OMP defaults to provider policies and profile validation; extend runtime lookup with `AGENT_BRIDGE_OMP_BIN`, PATH discovery, and `join(home, ".local", "bin", "omp")`; pass `PI_CODING_AGENT_DIR` and `OMP_PROFILE` through the child environment allowlist; add `ompCommand` to `ProviderRuntime`; construct `OmpAdapter` in `main.ts`; and include OMP in the existing startup found/missing CLI messages. Preserve generic task-store SQL with no migration.

- [ ] **Step 6: Run focused integration tests and typecheck**

Run: `npm test -- --run test/providers/provider-runtime.test.ts test/policy/execution-profiles.test.ts test/mcp-tools.test.ts` and `npm run typecheck`.

Expected: all focused tests and typecheck pass; old provider assertions stay unchanged except for expanded enums.

---

### Task 4: Add OMP session list/read support

**Files:**
- Create: `src/sessions/omp-sessions.ts`
- Modify: `src/sessions/types.ts`
- Modify: `src/sessions/session-store.ts`
- Modify: `src/main.ts` to pass the resolved OMP session root into `SessionStore`
- Modify: `src/mcp/tool-schemas.ts`
- Modify: `src/mcp/register-tools.ts`
- Create: `test/sessions/omp-sessions.test.ts`
- Modify: `test/repo-session-tools.test.ts`

**Interfaces:**
- Consumes: verified OMP session root and JSONL shape from Task 1; `SessionSummary`, `SessionPage`, and `isPathPermitted` existing patterns.
- Produces: `listOmpSessions(baseDir)`, `getOmpSessionCwd(baseDir, sessionId)`, and `readOmpSession(baseDir, sessionId, { cursor?, limit? })`; `SessionStore` dispatches provider `omp` to those functions.

- [ ] **Step 1: Add failing session parser/store tests**

Use temporary OMP session roots with one valid in-scope fixture, one out-of-scope session, one malformed file, one nested unrelated file, and one large event file. Assert list returns only parseable OMP session files with valid cwd, read checks only the requested session's cwd before reading events, pagination uses event-line cursors and returns at most the requested limit, output is redacted, malformed records become bounded `unparsed` events, and unrelated files are ignored. Include traversal-like session IDs such as `../canary` and assert they return an empty page without reading outside the root.

- [ ] **Step 2: Run session tests and confirm failure**

Run: `npm test -- --run test/sessions/omp-sessions.test.ts test/repo-session-tools.test.ts`

Expected: FAIL because OMP session helpers/provider dispatch do not exist.

- [ ] **Step 3: Implement bounded OMP session parsing**

Follow the existing Codex/Claude session helper structure. Resolve session files by exact filename or the exact stable ID mapping discovered in Task 1; reject path separators and traversal in caller session IDs; inspect a bounded header prefix for the absolute cwd; enforce existing allowlist checks before returning events; apply `redactJsonValue` and `redactTextLine`; cap result pages with existing `limit` and cursor conventions. Add `ompSessionsDir?: string` to `SessionStoreOptions`, default it to the verified OMP session directory under `~/.omp/agent`, and pass the resolved OMP state directory from `main.ts` so `PI_CODING_AGENT_DIR` is honored.

- [ ] **Step 4: Wire and verify session provider dispatch**

Extend `SessionProvider`, MCP session schemas, and `SessionStore.list/read` with OMP branches. Add tests that `session_list` and `session_read` accept OMP and reject unknown providers. Do not alter Codex/Claude lookup behavior. Run: `npm test -- --run test/sessions/omp-sessions.test.ts test/repo-session-tools.test.ts test/sessions/session-store.test.ts`.

Expected: PASS. If Task 1 did not establish a safe bounded OMP session format, stop this task and revise the spec with the user rather than parsing guessed fields.

---

### Task 5: Document operation and run end-to-end verification

**Files:**
- Modify: `README.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: completed OMP provider/runtime/session integration from Tasks 2–4.
- Produces: installation and configuration guidance, example MCP call for Gemma 4 using the exact model selector found in Task 1, and end-to-end evidence for the spec's verification criteria.

- [ ] **Step 1: Document installation, executable override, model use, and MCP refresh**

Document the installed OMP command, `AGENT_BRIDGE_OMP_BIN`, the required OMP state/profile environment, an `agent_start` example using the Gemma 4 selector discovered from `omp models`, the configured default behavior when `model` is omitted, the `agent_continue` same-session behavior, and refreshing a client's cached MCP tool schema. State clearly that the bridge does not accept OMP credentials through MCP arguments.

- [ ] **Step 2: Run focused regression suites**

Run: `npm test -- --run test/omp-adapter.test.ts test/providers/provider-runtime.test.ts test/policy/execution-profiles.test.ts test/mcp-tools.test.ts test/sessions/omp-sessions.test.ts test/repo-session-tools.test.ts test/job-supervisor.test.ts test/codex-adapter.test.ts test/claude-adapter.test.ts`.

Expected: PASS with no behavior changes to Codex/Claude invocations.

- [ ] **Step 3: Run repository verification**

Run: `npm run verify`.

Expected: TypeScript check, complete Vitest suite, and production build all pass.

- [ ] **Step 4: Perform the controlled OMP smoke run from Task 1**

Use the Gemma 4 selector from `omp models`, an allowlisted disposable repository, and `--approval-mode write`. Verify a workspace file can be created, a sibling canary cannot be changed, shell approval fails closed without hanging, the bridge records OMP's exact session ID, `agent_continue` resumes that same session, and `agent_cancel` terminates an active process tree.

Expected: every safety and lifecycle check passes. If workspace containment or non-interactive approval fails, do not mark the provider ready; return to the user with the specific observed limitation and options for a revised design.
