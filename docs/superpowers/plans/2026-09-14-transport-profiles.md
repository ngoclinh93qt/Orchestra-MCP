# Transport Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple bridge installation from Cloudflare by introducing managed Cloudflare and externally-managed ingress profiles, and document OpenAI Secure MCP Tunnel.

**Architecture:** The bridge remains a loopback HTTP service. `AGENT_BRIDGE_INGRESS` is interpreted only by deployment scripts: `cloudflare` renders and manages the Cloudflare LaunchAgent; `external` renders the bridge only. Provider-specific setup stays in documentation, not `src/`.

**Tech Stack:** TypeScript, Node.js, Bash, macOS LaunchAgents, Vitest, Markdown.

**Spec:** `docs/superpowers/specs/2026-09-14-transport-profiles-design.md`

## Global Constraints

- `AGENT_BRIDGE_INGRESS` accepts only `cloudflare` and `external`; omitted means `cloudflare`.
- `AGENT_BRIDGE_PUBLIC_URL` remains required and must be an HTTPS `/mcp` URL.
- Never put tunnel credentials or OpenAI runtime keys in committed files or rendered bridge plists.
- The bridge binds `127.0.0.1`; no ingress provider belongs in `src/`.
- Preserve the Cloudflare profile's existing labels and behavior.

---

### Task 1: Make LaunchAgent rendering profile-aware

**Files:**
- Modify: `scripts/render-launch-agents.ts`
- Modify: `test/deployment-assets.test.ts`

**Interfaces:**
- Produces `IngressProfile = "cloudflare" | "external"`.
- `RenderOptions` gains `ingress: IngressProfile`.
- `renderPlists(options)` returns the bridge plist always and tunnel plist only for `cloudflare`.

- [ ] Write tests asserting `external` renders only `local.agent-bridge.bridge` and that Cloudflare still renders both labels.
- [ ] Run `npm test -- --run test/deployment-assets.test.ts` and observe the new external assertion fail.
- [ ] Add the profile type, choose template list by `options.ingress`, and parse `AGENT_BRIDGE_INGRESS` in the renderer with a clear unsupported-value error.
- [ ] Run `npm test -- --run test/deployment-assets.test.ts` and confirm rendering tests pass.

### Task 2: Make install and uninstall profile-aware

**Files:**
- Modify: `scripts/install-services.sh`
- Modify: `scripts/uninstall-services.sh`
- Modify: `test/deployment-assets.test.ts`

**Interfaces:**
- `AGENT_BRIDGE_INGRESS=cloudflare|external`; default `cloudflare`.
- Cloudflare installs bridge and tunnel; external installs bridge only.
- Uninstall always removes the bridge plist and removes a legacy Cloudflare plist when present.

- [ ] Add explicit `AGENT_BRIDGE_PUBLIC_URL` to each fake-install test environment and a failing external-profile test expecting one bootstrap and no tunnel plist.
- [ ] Run the focused deployment test and observe the external expectation fail.
- [ ] Validate ingress in the install script, build labels from the chosen profile, pass it to the renderer, and print the external ownership notice.
- [ ] Change uninstall to remove both known bridge and legacy Cloudflare plist labels without requiring an ingress credential.
- [ ] Run the focused deployment test and confirm all install/uninstall assertions pass.

### Task 3: Document profiles and OpenAI Secure MCP Tunnel

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/OPERATIONS.md`
- Create: `docs/TRANSPORTS.md`

**Interfaces:**
- README links to `docs/TRANSPORTS.md`.
- `docs/TRANSPORTS.md` documents Cloudflare, external ingress, and OpenAI Secure MCP Tunnel.

- [ ] Add `AGENT_BRIDGE_INGRESS=cloudflare` and external-profile comments to `.env.example`.
- [ ] Add an ingress-profile summary and guide link to README.
- [ ] Rewrite operations install/rollback wording so Cloudflare steps apply only to its profile.
- [ ] Write the OpenAI guide from the official Secure MCP Tunnel documentation: create/manage a tunnel, run `tunnel-client` inside the local network, point it at `http://127.0.0.1:8787/mcp`, connect it in ChatGPT developer mode, diagnose with `tunnel-client doctor`, and state the OAuth authorization-server reachability caveat.
- [ ] Run `git diff --check` and inspect every command for placeholders or credentials.

### Task 4: Full verification and review

**Files:**
- Test: `test/deployment-assets.test.ts`

- [ ] Run `npm run verify`.
- [ ] Run `git diff --check` and `git status --short`.
- [ ] Review diff against the spec: no `src/` ingress dependency, Cloudflare backwards-compatible, external mode owns no tunnel process, docs contain no secret values.
- [ ] Commit implementation with `git add` of the source, tests, and documentation changes followed by `git commit -m "feat: add ingress transport profiles"`.
