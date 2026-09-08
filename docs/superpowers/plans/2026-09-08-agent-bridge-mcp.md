# Agent Bridge MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a private MCP bridge at `mcp.markapidown.net` that safely starts, observes, continues, and cancels local Codex CLI and Claude Code tasks.

**Architecture:** A TypeScript/Node.js service binds only to `127.0.0.1:8787`, persists task metadata in SQLite and provider events in JSONL, and exposes six MCP tools over Streamable HTTP. A named Cloudflare Tunnel publishes the loopback service; MCP-compatible OAuth protects remote access, while provider adapters invoke installed CLIs without a shell or permission-bypass flags.

**Tech Stack:** Node.js 20, TypeScript 7, MCP TypeScript SDK 1.30, Express 5, Zod 4, better-sqlite3 12, Vitest 4, Cloudflare Tunnel, macOS LaunchAgents

**Spec:** `docs/superpowers/specs/2026-09-08-agent-bridge-mcp-design.md`

## Global Constraints

- Bind only to `127.0.0.1:8787`; public URL is `https://mcp.markapidown.net/mcp`.
- Do not call the OpenAI API or add an OpenAI API key.
- Never use Codex or Claude permission/sandbox bypass flags.
- Never expose raw shell, arbitrary executable, environment, model, sandbox-bypass, download, or delete-log tools.
- Spawn direct argument arrays with `shell: false`; send prompts over stdin.
- Resolve working directories beneath explicit allowlisted roots after symlink resolution.
- Keep every credential, prompt, and task log out of Git.

---

### Task 1: Foundation and Validated Configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/config.ts`, `src/errors.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `BridgeConfig`, `loadConfig(env)`, `resolveAllowedDirectory(path, roots)`

- [x] **Step 1: Add pinned dependencies and scripts**

Pin MCP SDK `1.30.0`, Express `5.2.1`, Zod `4.5.4`, better-sqlite3 `12.11.1`, TypeScript `7.0.2`, Vitest `4.1.11`, and tsx `4.23.13`. Add `build`, `typecheck`, `test`, `start`, and `verify` scripts.

- [x] **Step 2: Write failing configuration tests**

```ts
expect(loadConfig({AGENT_BRIDGE_ALLOWED_ROOTS: "/Users/thief/nik"})).toMatchObject({
  host: "127.0.0.1", port: 8787,
});
await expect(resolveAllowedDirectory(linkOutsideRoot, [allowedRoot]))
  .rejects.toThrow(PathNotAllowedError);
```

- [x] **Step 3: Confirm red**

Run: `npm install && npm test -- test/config.test.ts`

- [x] **Step 4: Implement immutable config and realpath containment**

```ts
export type BridgeConfig = Readonly<{
  host: "127.0.0.1"; port: number; stateDir: string;
  allowedRoots: readonly string[]; publicUrl: URL;
  maxConcurrentTotal: number; maxConcurrentPerProvider: number;
  maxPromptBytes: number;
}>;
```

Reject relative/missing paths, non-HTTPS public URLs, non-loopback hosts, empty roots, and symlink escapes.

- [x] **Step 5: Verify and commit**

Run: `npm test -- test/config.test.ts && npm run typecheck`

Commit: `build: scaffold agent bridge service`

---

### Task 2: Durable Tasks and Event Logs

**Files:**
- Create: `src/domain/task.ts`, `src/store/migrations.ts`, `src/store/task-store.ts`, `src/store/event-log.ts`
- Test: `test/task-store.test.ts`, `test/event-log.test.ts`

**Interfaces:**
- Produces: `BridgeTask`, `TaskState`, `TaskStore`, `EventLog`, `OutputPage`

- [x] **Step 1: Write failing store tests**

Cover creation, legal transitions, parent links, session IDs, filtering, WAL, and restart reconciliation:

```ts
const task = store.create({provider: "codex", cwd, promptBytes: 12});
store.transition(task.id, "running"); store.reconcileAfterRestart();
expect(store.get(task.id)?.state).toBe("interrupted");
```

- [x] **Step 2: Confirm red**

Run: `npm test -- test/task-store.test.ts`

- [x] **Step 3: Implement task schema/state machine**

Use `queued | running | waiting | succeeded | failed | cancelled | interrupted`. Store prompt byte count, never prompt text. Make cancellation idempotent and migrations transactional.

- [x] **Step 4: Write failing JSONL cursor/redaction tests**

```ts
log.append(id, {type: "assistant", text: "one"});
expect(log.read(id, {cursor: 0, limit: 1}).nextCursor).toBe(1);
```

Assert keys named token, authorization, api_key, and cookie are `[REDACTED]`; limits are capped and newest events survive rotation.

- [x] **Step 5: Implement owner-only append logs and verify**

Run: `npm test -- test/task-store.test.ts test/event-log.test.ts`

Commit: `feat: persist bridge tasks and events`

---

### Task 3: Bounded Process Supervisor

**Files:**
- Create: `src/providers/provider.ts`, `src/supervisor/process-runner.ts`, `src/supervisor/job-supervisor.ts`
- Create: `test/fixtures/fake-agent.mjs`
- Test: `test/job-supervisor.test.ts`

**Interfaces:**
- Produces: `ProviderAdapter`, `ProviderInvocation`, `JobSupervisor`

- [x] **Step 1: Define the adapter contract and failing lifecycle tests**

```ts
export type ProviderInvocation = Readonly<{
  command: string; args: readonly string[]; cwd: string;
  stdin: string; env: Readonly<Record<string,string>>;
}>;
export interface ProviderAdapter {
  readonly name: "codex" | "claude";
  checkAvailable(): Promise<void>;
  newInvocation(i: StartInput): ProviderInvocation;
  resumeInvocation(i: ContinueInput): ProviderInvocation;
  parseLine(s: "stdout"|"stderr", line: string): ProviderEvent[];
}
```

Test success, failure, malformed output, cancellation, concurrency limits, `shell:false`, and prompt metacharacters.

- [x] **Step 2: Confirm red**

Run: `npm test -- test/job-supervisor.test.ts`

- [x] **Step 3: Implement exact-child ownership**

Spawn a detached process group, write stdin, parse both streams, and persist observed lifecycle. Cancel with SIGTERM, wait five seconds, then SIGKILL only that exact group.

- [x] **Step 4: Add bounds/restart reconciliation and verify**

Limit one active task/provider, two total, and configured prompt bytes. Return immediately from start/continue; mark unsupervised old running tasks interrupted.

Run: `npm test -- test/job-supervisor.test.ts`

Commit: `feat: supervise bounded agent processes`

---

### Task 4: Codex and Claude Adapters

**Files:**
- Create: `src/providers/codex.ts`, `src/providers/claude.ts`
- Create: `test/fixtures/codex-events.jsonl`, `test/fixtures/claude-events.jsonl`
- Test: `test/codex-adapter.test.ts`, `test/claude-adapter.test.ts`

**Interfaces:**
- Produces: `CodexAdapter`, `ClaudeAdapter` implementing `ProviderAdapter`

- [x] **Step 1: Capture and sanitize one read-only JSON stream from each installed CLI**

Remove prompts, local paths, IDs, account data, and credentials; commit only representative event shapes.

- [x] **Step 2: Write failing Codex tests**

Assert new args contain `exec --json --sandbox workspace-write -C <cwd> -`; resume uses the installed CLI's validated `exec resume <session-id>` ordering; prompt stays out of args; forbidden flags are absent. Test session, progress, final, error, and unknown events.

- [x] **Step 3: Write failing Claude tests**

Assert direct args include `-p --output-format stream-json --permission-mode acceptEdits --permission-prompts none`; resume uses `--resume <session-id>`; forbidden flags are absent. Test the same normalized event classes.

- [x] **Step 4: Confirm red, implement pure parsers and probes**

Run: `npm test -- test/codex-adapter.test.ts test/claude-adapter.test.ts`

Probe only `codex --version` and `claude --version`, each with a short timeout.

- [x] **Step 5: Verify and commit**

Run: `npm test -- test/codex-adapter.test.ts test/claude-adapter.test.ts test/job-supervisor.test.ts`

Commit: `feat: add coding agent adapters`

---

### Task 5: MCP Tools and Loopback HTTP

**Files:**
- Create: `src/mcp/tool-schemas.ts`, `src/mcp/register-tools.ts`, `src/http/app.ts`, `src/main.ts`
- Test: `test/mcp-tools.test.ts`, `test/http-transport.test.ts`

**Interfaces:**
- Produces: `agent_start`, `agent_list`, `agent_status`, `agent_output`, `agent_continue`, `agent_cancel`; `createApp(deps)`

- [ ] **Step 1: Write failing schema/behavior tests**

Assert only six tools exist; list/status/output are read-only; start/continue/cancel are writes; cancellation is idempotent. Test async start, pagination, continuation requiring session ID, missing-task errors, and cancel.

- [ ] **Step 2: Confirm red**

Run: `npm test -- test/mcp-tools.test.ts`

- [ ] **Step 3: Implement compact structured handlers**

Never return prompts, environments, raw database rows, or provider objects.

- [ ] **Step 4: Write failing transport tests and implement**

Test `/healthz`, MCP initialize/list-tools over Streamable HTTP, request size cap, 404 fallback, loopback binding, per-session transport, and graceful SIGTERM shutdown.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/mcp-tools.test.ts test/http-transport.test.ts`

Commit: `feat: expose agent control over MCP`

---

### Task 6: Single-User OAuth and Local Token

**Files:**
- Create: `src/auth/crypto.ts`, `src/auth/oauth-store.ts`, `src/auth/oauth-provider.ts`, `src/auth/routes.ts`, `src/auth/middleware.ts`
- Create: `src/cli/enroll-owner.ts`
- Modify: `src/http/app.ts`, `package.json`
- Test: `test/oauth.test.ts`, `test/auth-middleware.test.ts`

**Interfaces:**
- Produces: MCP OAuth discovery/registration/authorization/token/revoke endpoints; `agent:read`, `agent:write`; loopback bearer verification

- [ ] **Step 1: Write failing OAuth protocol tests**

Cover metadata, dynamic registration, Authorization Code + S256 PKCE, exact redirect URIs, one-time codes, expiry, refresh rotation/replay rejection, scope narrowing, and revoke.

- [ ] **Step 2: Write failing security tests**

Assert no plaintext bearer material in SQLite/logs; correct 401 responses; auth failure rate limiting; read scope cannot call writes; localhost without a token is rejected.

- [ ] **Step 3: Confirm red**

Run: `npm test -- test/oauth.test.ts test/auth-middleware.test.ts`

- [ ] **Step 4: Implement secure storage and enrollment**

Use 256-bit entropy, SHA-256 token lookup, constant-time comparison, UTC expiries, code binding to client/redirect/scope/PKCE, and transactional refresh rotation. `npm run enroll-owner` prints one recovery code once and writes mode-0600 state.

- [ ] **Step 5: Enforce scopes in middleware and tool handlers**

Keep `/healthz` public and data-free. OAuth tokens and explicit local bearer tokens take precedence over all unauthenticated access.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- test/oauth.test.ts test/auth-middleware.test.ts test/mcp-tools.test.ts`

Commit: `feat: protect MCP with single-user OAuth`

---

### Task 7: Private Plugin and Local Configuration

**Files:**
- Create: `.codex-plugin/plugin.json`, `.mcp.json`, `skills/agent-bridge/SKILL.md`, `agents/openai.yaml`
- Create: `config/codex.local.example.toml`, `docs/CONNECT_CHATGPT.md`
- Test: `test/plugin-package.test.ts`

**Interfaces:**
- Produces: private remote plugin plus optional localhost configuration

- [ ] **Step 1: Invoke the current `plugin-creator` skill**

Use its manifest and personal-marketplace conventions; validate with installed Codex tooling.

- [ ] **Step 2: Write failing package tests**

Assert manifests parse, remote URL is exact, write tools default to approval, all referenced files exist, and tracked files contain no credentials.

- [ ] **Step 3: Create plugin and workflow skill**

Instruct ChatGPT to start with list/status, request approval before start/continue/cancel, poll actual state, and preserve returned task IDs. Declare the OAuth-enabled remote HTTP MCP.

- [ ] **Step 4: Add an opt-in localhost example**

Point it to `http://127.0.0.1:8787/mcp` using a keychain-backed bearer environment variable; do not edit global Codex config.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/plugin-package.test.ts && npm run verify`

Commit: `feat: package private agent bridge plugin`

---

### Task 8: macOS and Cloudflare Deployment

**Files:**
- Create: `scripts/install-cloudflared.sh`, `scripts/render-launch-agents.ts`, `scripts/install-services.sh`, `scripts/uninstall-services.sh`
- Create: `config/cloudflared.example.yml`, `config/net.markapidown.agent-bridge.plist.template`, `config/net.markapidown.agent-tunnel.plist.template`
- Create: `docs/OPERATIONS.md`
- Test: `test/deployment-assets.test.ts`

**Interfaces:**
- Produces: recoverable per-user LaunchAgents and named tunnel route

- [ ] **Step 1: Write failing asset tests**

Parse plists/YAML; assert loopback URL, 404 catch-all, no inline token, absolute paths, `RunAtLoad`, failure restart, and state-preserving uninstall.

- [ ] **Step 2: Implement idempotent install/render/uninstall**

Use strict shell mode, explicit paths, temp files + atomic rename, owner-only secret files, and exact `launchctl bootstrap/bootout` labels. Never recursively delete state.

- [ ] **Step 3: Add named-tunnel flow**

Install `cloudflared` with Homebrew only if absent; route `mcp.markapidown.net` to `http://127.0.0.1:8787`; require final 404; never use a Quick Tunnel for completion.

- [ ] **Step 4: Dry-run twice and test rollback**

Render into a temporary root, prove repeated install is stable, and prove uninstall preserves database/logs/provider sessions/tunnel credentials.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/deployment-assets.test.ts && npm run verify`

Commit: `build: add macOS and Cloudflare deployment`

---

### Task 9: End-to-End Verification and Live Setup

**Files:**
- Create: `test/e2e/bridge.e2e.test.ts`, `scripts/verify-live.sh`, `README.md`
- Modify: `docs/OPERATIONS.md`, `docs/CONNECT_CHATGPT.md`

**Interfaces:**
- Produces: verified loopback service, public tunnel, ChatGPT connection, provider smoke results, rollback guide

- [ ] **Step 1: Build the local end-to-end test**

With fake providers on an ephemeral loopback port, complete OAuth PKCE, initialize MCP, list tools, then start/poll/page/continue/cancel. Verify unauthenticated and insufficient-scope failures.

- [ ] **Step 2: Run the pre-deployment gate and secret review**

Run: `npm run verify && git diff --check`

Inspect `git grep -n -E '(Bearer [A-Za-z0-9._-]{16,}|api[_-]?key|tunnel[_-]?token|client[_-]?secret)' -- ':!package-lock.json'`; no real credential may remain.

- [ ] **Step 3: Enroll owner and verify loopback**

Save the one-time recovery code in the user's password manager, install the bridge LaunchAgent, and verify health, discovery, authenticated MCP initialize, and tool listing locally.

- [ ] **Step 4: Complete the user-authorized Cloudflare login**

Open `cloudflared tunnel login`; after browser authorization create the named tunnel, DNS route, untracked credential config, and tunnel LaunchAgent.

- [ ] **Step 5: Verify public security and network binding**

Run `scripts/verify-live.sh https://mcp.markapidown.net`; verify unauthenticated rejection and authenticated tool listing. Use `lsof` to confirm only `127.0.0.1:8787` listens.

- [ ] **Step 6: Connect ChatGPT Web and smoke-test both providers**

Install/connect the private plugin in the Business workspace, complete OAuth, and run one read-only Codex and Claude task in this repository. Verify terminal states and resumable provider session IDs.

- [ ] **Step 7: Restart services, document evidence, and commit**

Confirm task history survives both LaunchAgent restarts. Record exact paths, labels, health commands, limits, and rollback without secrets.

Run: `npm run verify && scripts/verify-live.sh https://mcp.markapidown.net`

Commit: `docs: finish agent bridge operations guide`

## Completion Evidence

Report focused tests, final `npm run verify`, loopback/public MCP checks, OAuth rejection and success, redacted provider smoke states, loopback-only `lsof`, LaunchAgent state, Cloudflare hostname health, commits, clean Git status, and exact rollback commands.
