# Local Control Plane Design

## Goal

Add a loopback-only web control plane to Agent Bridge MCP. The owner can manage folder access, enabled providers, and approved execution profiles from a browser at `http://127.0.0.1:<port>/admin`. The orchestrator runs only approved profiles and performs bounded, auditable failover when a provider is rate-limited, out of quota, or unavailable.

## Decisions

- The control plane is served by the existing Express process; there is no second daemon, remote admin API, or new public ingress route.
- `/admin` is not authenticated. It is protected by the loopback bind, no CORS, same-origin checks for writes, and a per-browser CSRF token. Reverse-proxy/tunnel documentation must explicitly expose only `/mcp` and OAuth paths, never `/admin`.
- The policy contains owner-defined execution profiles rather than accepting an arbitrary provider/model pair from an MCP caller.
- Quota/rate-limit and provider-unavailable failures may fail over automatically. Timeouts, ordinary task failures, and a difficult-task escalation always create a pending recommendation for owner approval.
- A cross-provider/model switch starts a new child task. It never pretends provider session IDs are portable.

## Policy document

`config.json` becomes versioned and remains atomically written with mode `0600`. Existing `files` configuration is backwards compatible.

```json
{
  "version": 2,
  "files": { "allow": ["/absolute/repository"], "deny": [] },
  "providers": {
    "codex": { "enabled": true },
    "claude": { "enabled": true }
  },
  "profiles": [
    {
      "id": "codex-fast",
      "label": "Codex fast",
      "provider": "codex",
      "model": "gpt-5.6-luna",
      "reasoning": "medium",
      "fallbackProfileIds": ["claude-review"]
    }
  ]
}
```

Profile IDs are stable lowercase slugs. They are unique, must reference an enabled provider, and each fallback must reference another profile. Fallback cycles are rejected. A provider can be installed but disabled; disabled providers and profiles are unavailable to MCP calls and routing.

Models and reasoning values are opaque, validated non-empty strings rather than a hard-coded vendor catalogue. The owner can only add them through the local UI/config; MCP clients supply profile IDs only. The Codex adapter maps `model` to `codex exec --model`; the Claude adapter maps it to `claude --model` and maps `reasoning` to `--effort` when set.

## MCP and supervisor behavior

`agent_start` accepts `profileId`, replacing the caller-controlled provider field. During migration, the old provider-only shape remains accepted only when a matching enabled default profile exists; the tool response always includes provider and profile ID. `agent_continue` resumes only within the same provider/profile because its session ID is provider-specific.

`JobSupervisor` owns a `RoutingService`. A task records its execution profile, routing attempt number, and switch reason. Before spawn, the service validates that the profile is enabled and its provider CLI is available.

On classified automatic failure, the supervisor cancels/finalizes the original task and starts the next allowed fallback profile as a child. It tries each profile at most once per routing chain. If no valid fallback remains, it records a terminal failure with the original cause. It never retries generic non-zero exits automatically.

The current adapters normalize recognizable rate-limit/quota/unavailable events to routing reasons. Unknown output stays a normal task failure. Provider availability failures from `checkAvailable()` count as unavailable.

## Handoff packet and proposals

For an automatic switch of an active task, `RoutingService` creates a bounded in-memory handoff packet:

- original task request and working directory;
- git status/diff summary, limited by byte budget;
- recent event-log entries after secret redaction;
- previous provider/profile, failure reason, and next requested outcome.

The packet is inserted into the new child task prompt; raw environment variables, credentials, unredacted logs, and an entire session transcript are never included. The original prompt and packet remain in the active process only and are never persisted. A bridge restart therefore stops automatic failover for an interrupted task.

For non-automatic scenarios, a routing proposal is stored in SQLite: source task, candidate profile, reason, `pending|approved|rejected|expired` state, and timestamps. It never stores a prompt or handoff. The dashboard lets the owner approve or reject it; approval requires the owner to enter the next instruction and creates exactly one child task. Repeated clicks are idempotent.

## Local admin UI

The Express app serves a dependency-free HTML/CSS/JS application from compiled/static assets at `/admin` and JSON routes below `/admin/api`.

Views:

1. **Dashboard** — active/recent tasks, selected profile, routing chain, availability and pending proposals.
2. **Access policy** — allow/deny folders, with server-side absolute-path validation.
3. **Providers and profiles** — enable providers; create/edit/delete profiles; choose model, reasoning, and ordered fallback profiles.
4. **Proposal detail** — inspect the source task's safe summary, approve/reject with an owner-provided next instruction, or manually switch a terminal/waiting task to an allowed profile.

Read routes return only existing safe task summaries and redacted event data. Mutation routes require JSON, a same-origin `Origin` header matching the loopback origin, and the CSRF token rendered into the initial page. They reject missing/foreign origins and accept no credentials from CORS. The app emits `Cache-Control: no-store` for admin pages and APIs. `/admin` is not mounted behind the MCP OAuth middleware and must not be exposed by any ingress rule.

## Storage and migration

`TaskStore` gains nullable `profile_id`, `routing_root_id`, `routing_attempt`, and `switch_reason` fields through a SQLite migration. Existing rows have no profile and remain readable. Existing config parses as v1 and is serialized as v2 with both providers enabled and zero profiles; an owner must create profiles before starting new agent tasks.

The config watcher validates the entire new policy before swapping it. Invalid changes leave the previous policy active. Reloads do not terminate running tasks; later starts and routing decisions use the new policy.

## Testing

- Config migration, validation, uniqueness, disabled-provider/profile, and fallback-cycle tests.
- Adapter argument tests for profile model/reasoning values.
- Supervisor routing tests for automatic quota/unavailable failover, no retry loop, proposal creation, approval idempotency, and redacted handoff bounds.
- HTTP tests for loopback admin headers, CSRF/origin rejection, policy mutation validation, and no `/admin` CORS exposure.
- Tool schema/handler tests proving callers cannot select arbitrary models and cannot use disabled profiles.

## Non-goals

- Discovering live account quota or model catalogues from providers.
- Automatic difficulty scoring or automatic recovery from ordinary coding failures/timeouts.
- Cross-provider session resume.
- Remote multi-user administration, browser login, or exposing `/admin` through a tunnel.
