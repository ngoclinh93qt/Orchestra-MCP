# Local Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a loopback-only web UI for access/provider/profile policy and a bounded, auditable routing path for approved agent/model switches.

**Architecture:** Extend the existing versioned JSON policy and SQLite task store. Profiles, rather than arbitrary provider/model inputs, drive adapters and the supervisor. The existing Express app serves a same-origin `/admin` UI and local JSON API; all remote MCP behavior stays at `/mcp`.

**Tech Stack:** TypeScript, Express 5, better-sqlite3, Zod, Vitest, dependency-free HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-09-14-local-control-plane-design.md`

## Global Constraints

- Bind only `127.0.0.1`; never add a public admin API or CORS policy.
- Admin mutations require JSON, a loopback same-origin `Origin`, and an in-page CSRF token.
- Profiles are the only model-selection input accepted from MCP callers.
- Automatically route only quota/rate-limit/provider-unavailable failures; never automatically retry ordinary non-zero exits or timeouts.
- Keep automatic handoff payloads bounded, redacted, and in memory only; never include environment variables, credentials, raw full transcripts, or persist the original prompt.
- Preserve old `files` config and historical task rows.

---

### Task 1: Versioned policy and execution profiles

**Files:**
- Modify: `src/policy/config-file.ts`
- Create: `src/policy/execution-profiles.ts`
- Modify: `src/policy/files-policy.ts`
- Test: `test/policy/config-file.test.ts`
- Create: `test/policy/execution-profiles.test.ts`

**Interfaces:**
- Produces `ExecutionProfile`, `ProviderPolicy`, `ControlPlanePolicy`, `parseControlPlanePolicy(raw)`, and `profileById(policy, id)`.
- `BridgeFileConfig` gains `version`, `providers`, and `profiles`; absent new keys parse as legacy defaults.

- [ ] **Step 1: Write failing profile-validation tests**

```ts
expect(() => parseControlPlanePolicy({ providers: { codex: { enabled: false } }, profiles: [
  { id: "codex-fast", label: "Fast", provider: "codex", model: "x", fallbackProfileIds: [] },
] })).toThrow("disabled provider");
expect(() => parseControlPlanePolicy({ providers: bothEnabled, profiles: cyclicProfiles })).toThrow("fallback cycle");
```

- [ ] **Step 2: Run focused tests and observe validation failures**

Run: `npm test -- --run test/policy/config-file.test.ts test/policy/execution-profiles.test.ts`

- [ ] **Step 3: Implement strict profile parsing and v1 compatibility**

```ts
export interface ExecutionProfile {
  readonly id: string; readonly label: string; readonly provider: Provider;
  readonly model: string; readonly reasoning?: string; readonly fallbackProfileIds: readonly string[];
}
export function profileById(policy: ControlPlanePolicy, id: string): ExecutionProfile | undefined
```

Require slug IDs, unique IDs, enabled provider references, existing fallbacks, and no directed cycles. Serialize `version: 2`, provider enablement, and profiles while retaining `_readme` and `files`.

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- --run test/policy/config-file.test.ts test/policy/execution-profiles.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/policy test/policy
git commit -m "feat: add execution profile policy"
```

### Task 2: Persist profile and routing metadata

**Files:**
- Modify: `src/domain/task.ts`
- Modify: `src/store/migrations.ts`
- Modify: `src/store/task-store.ts`
- Test: `test/task-store.test.ts`

**Interfaces:**
- `BridgeTask` adds `profileId`, `routingRootId`, `routingAttempt`, and `switchReason`.
- `CreateTaskInput` accepts those fields; `TaskStore.create` persists and returns them.
- `TaskStore` exposes proposal CRUD with atomic `approveProposal(id): RoutingProposal | undefined` state transition; proposals contain no prompt or handoff data.

- [ ] **Step 1: Write failing migration and idempotent approval tests**

```ts
const child = store.create({ provider: "claude", cwd: "/repo", promptBytes: 3,
  profileId: "claude-review", routingRootId: root.id, routingAttempt: 1, switchReason: "quota" });
expect(child.profileId).toBe("claude-review");
expect(store.approveProposal(proposal.id)?.state).toBe("approved");
expect(store.approveProposal(proposal.id)).toBeUndefined();
```

- [ ] **Step 2: Run task-store tests and observe failures**

Run: `npm test -- --run test/task-store.test.ts`

- [ ] **Step 3: Add migration version 3 and store APIs**

Add nullable task columns and a `routing_proposals` table with source task, target profile, reason, state, and timestamps. Do not store prompts or handoff text. Make approval a single SQL `UPDATE ... WHERE state = 'pending'`.

- [ ] **Step 4: Re-run task-store tests**

Run: `npm test -- --run test/task-store.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/domain/task.ts src/store test/task-store.test.ts
git commit -m "feat: persist routing metadata"
```

### Task 3: Profile-aware adapters and supervisor routing

**Files:**
- Modify: `src/providers/provider.ts`
- Modify: `src/providers/codex.ts`
- Modify: `src/providers/claude.ts`
- Create: `src/supervisor/routing-service.ts`
- Modify: `src/supervisor/job-supervisor.ts`
- Test: `test/codex-adapter.test.ts`
- Test: `test/claude-adapter.test.ts`
- Test: `test/job-supervisor.test.ts`
- Create: `test/routing-service.test.ts`

**Interfaces:**
- `StartInput` and `ProviderInvocation` carry an `ExecutionProfile` or profile-derived model/reasoning fields.
- `RoutingService.start`, `RoutingService.propose`, and `RoutingService.autoFailover` return `BridgeTask` or a pending proposal.

- [ ] **Step 1: Write failing adapter and routing tests**

```ts
expect(new CodexAdapter().newInvocation({ cwd: "/repo", prompt: "x", profile })).toMatchObject({
  args: expect.arrayContaining(["--model", profile.model]),
});
expect(new ClaudeAdapter().newInvocation({ cwd: "/repo", prompt: "x", profile }).args)
  .toEqual(expect.arrayContaining(["--model", profile.model, "--effort", "high"]));
```

Create fake adapters whose output classifies a quota event, then assert one child task uses the first fallback profile and a second event cannot retry an already-attempted profile.

- [ ] **Step 2: Run focused adapter/supervisor tests and observe failures**

Run: `npm test -- --run test/codex-adapter.test.ts test/claude-adapter.test.ts test/job-supervisor.test.ts test/routing-service.test.ts`

- [ ] **Step 3: Implement model args, reason classification, and bounded handoff**

Add only safe Codex `--model` and Claude `--model`/`--effort` args. `RoutingService` builds a byte-capped in-memory handoff using the active task prompt, redacted recent event entries, and a git status/diff summary. Classify explicit quota/rate-limit/provider availability only; use metadata-only proposals for all other switch reasons.

- [ ] **Step 4: Integrate router into `JobSupervisor`**

On automatic classification, finalize source, create exactly one child with `routingAttempt + 1`, and spawn it. Do not attempt cross-provider resume. Expose manual proposal approval as a supervisor method.

- [ ] **Step 5: Re-run focused tests**

Run: `npm test -- --run test/codex-adapter.test.ts test/claude-adapter.test.ts test/job-supervisor.test.ts test/routing-service.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/providers src/supervisor test/codex-adapter.test.ts test/claude-adapter.test.ts test/job-supervisor.test.ts test/routing-service.test.ts
git commit -m "feat: route approved agent profiles"
```

### Task 4: Restrict MCP starts to profiles

**Files:**
- Modify: `src/mcp/tool-schemas.ts`
- Modify: `src/mcp/register-tools.ts`
- Modify: `src/main.ts`
- Test: `test/mcp-tools.test.ts`

**Interfaces:**
- `agent_start` schema becomes `{ profileId: string; cwd: string; prompt: string }`.
- `TaskSummary` includes `profileId` and routing fields without prompt or handoff text.

- [ ] **Step 1: Write failing MCP tests**

```ts
expect(TOOL_DEFINITIONS.find((x) => x.name === "agent_start")?.inputSchema.provider).toBeUndefined();
const result = await handlers.agent_start({ profileId: "disabled", cwd, prompt: "x" });
expect(result.isError).toBe(true);
```

- [ ] **Step 2: Run MCP tests and observe failures**

Run: `npm test -- --run test/mcp-tools.test.ts`

- [ ] **Step 3: Implement profile-only start path**

Pass the live control-plane policy into handlers/supervisor. Reject missing, disabled, or unavailable profiles with expected tool errors. Keep `agent_continue` pinned to the original task profile.

- [ ] **Step 4: Re-run MCP tests**

Run: `npm test -- --run test/mcp-tools.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/mcp src/main.ts test/mcp-tools.test.ts
git commit -m "feat: restrict MCP agent starts to profiles"
```

### Task 5: Local admin UI and protected admin routes

**Files:**
- Create: `src/admin/router.ts`
- Create: `src/admin/assets.ts`
- Modify: `src/http/app.ts`
- Modify: `src/main.ts`
- Create: `test/admin-router.test.ts`
- Modify: `README.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/TRANSPORTS.md`

**Interfaces:**
- `createAdminRouter(deps)` serves `/admin`, `GET /admin/api/state`, `PUT /admin/api/policy`, and proposal approve/reject endpoints.
- `assertLocalAdminMutation(req)` rejects non-JSON, missing/foreign Origin, or invalid CSRF requests.

- [ ] **Step 1: Write failing HTTP security and UI-state tests**

```ts
expect((await fetch(new URL("/admin/api/policy", baseUrl), {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(nextPolicy),
})).status).toBe(403);
expect((await fetch(new URL("/admin/api/policy", baseUrl), {
  method: "PUT", headers: { "content-type": "application/json", origin: baseUrl.origin, "x-csrf-token": csrf },
  body: JSON.stringify(nextPolicy),
})).status).toBe(200);
expect((await fetch(new URL("/admin", baseUrl))).headers.get("cache-control")).toContain("no-store");
```

- [ ] **Step 2: Run focused admin tests and observe failures**

Run: `npm test -- --run test/admin-router.test.ts`

- [ ] **Step 3: Implement dependency-free dashboard and APIs**

Render HTML with an ephemeral CSRF token, serve embedded/static JS/CSS, and expose safe task/profile/proposal state. Write policy through the atomic config writer; validate before writing. Add profile editing, folder editing, provider enablement, proposal approval/rejection with owner-supplied next instruction, and manual switch proposal creation.

- [ ] **Step 4: Mount admin outside MCP auth, but inside loopback app**

Add `mountAdminRoutes` to `createApp` and wire it from `main.ts`. Do not add CORS middleware. Apply `Cache-Control: no-store` to all admin responses.

- [ ] **Step 5: Update deployment documentation**

Document `http://127.0.0.1:8787/admin`, explain there is no login because it is loopback-only, and state tunnel/reverse-proxy config must not expose `/admin` or `/admin/api`.

- [ ] **Step 6: Re-run focused admin tests**

Run: `npm test -- --run test/admin-router.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/admin src/http/app.ts src/main.ts test/admin-router.test.ts README.md docs
git commit -m "feat: add local control plane UI"
```

### Task 6: Full verification

**Files:**
- Test: all existing tests

- [ ] **Step 1: Run formatting/diff validation**

Run: `git diff --check`

- [ ] **Step 2: Run full verification**

Run: `npm run verify`

- [ ] **Step 3: Inspect release state**

Run: `git status --short && git log --oneline -8`

- [ ] **Step 4: Commit remaining documentation only if status shows intended files**

```bash
git add README.md docs
git commit -m "docs: document local control plane"
```
