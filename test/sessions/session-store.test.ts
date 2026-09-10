import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/sessions/session-store.js";
import { accessPolicyFor } from "../helpers/policy.js";

async function buildFixtures() {
  const base = await mkdtemp(join(tmpdir(), "session-store-"));
  const allowedRoot = join(base, "allowed-project");
  await mkdir(allowedRoot, { recursive: true });

  const claudeBaseDir = join(base, "claude-projects");
  const claudeProjectDir = join(claudeBaseDir, "-slug-does-not-matter");
  await mkdir(claudeProjectDir, { recursive: true });
  await writeFile(
    join(claudeProjectDir, "in-scope.jsonl"),
    `${JSON.stringify({ type: "system", cwd: allowedRoot })}\n`,
  );
  await writeFile(
    join(claudeProjectDir, "out-of-scope.jsonl"),
    `${JSON.stringify({ type: "system", cwd: join(base, "unrelated-project") })}\n`,
  );

  const codexBaseDir = join(base, "codex-sessions");
  const dateDir = join(codexBaseDir, "2026", "09", "03");
  await mkdir(dateDir, { recursive: true });
  await writeFile(
    join(dateDir, "rollout-2026-09-03T00-00-00-codex-1.jsonl"),
    `${JSON.stringify({ type: "turn_context", payload: { cwd: allowedRoot } })}\n`,
  );

  return { base, allowedRoot, claudeBaseDir, codexBaseDir };
}

describe("SessionStore.list", () => {
  it("includes sessions inside an allowed root and excludes ones outside it", async () => {
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ policy: accessPolicyFor(allowedRoot), claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    const sessions = await store.list({});
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain("in-scope");
    expect(ids).not.toContain("out-of-scope");
  });

  it("filters by provider", async () => {
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ policy: accessPolicyFor(allowedRoot), claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    const codexOnly = await store.list({ provider: "codex" });
    expect(codexOnly.every((s) => s.provider === "codex")).toBe(true);
    expect(codexOnly.length).toBeGreaterThan(0);
  });
});

describe("SessionStore.read", () => {
  it("routes to the correct provider and still enforces the allowlist", async () => {
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ policy: accessPolicyFor(allowedRoot), claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    const page = await store.read("claude", "in-scope", {});
    expect(page.events).toHaveLength(1);

    const outOfScope = await store.read("claude", "out-of-scope", {});
    expect(outOfScope.events).toHaveLength(0);
  });

  it("reads a codex session inside an allowed root", async () => {
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ policy: accessPolicyFor(allowedRoot), claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    const page = await store.read("codex", "rollout-2026-09-03T00-00-00-codex-1", {});
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.type).toBe("turn_context");
  });

  it("returns an empty page for a session that does not exist", async () => {
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ policy: accessPolicyFor(allowedRoot), claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    await expect(store.read("claude", "no-such-session", {})).resolves.toEqual({ events: [], nextCursor: 0 });
    await expect(store.read("codex", "no-such-rollout", {})).resolves.toEqual({ events: [], nextCursor: 0 });
  });

  it("does not consult the other provider's corpus when reading", async () => {
    // Regression guard for the single-session cwd lookup: asking codex for a claude sessionId
    // must not accidentally resolve via the claude corpus.
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ policy: accessPolicyFor(allowedRoot), claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    await expect(store.read("codex", "in-scope", {})).resolves.toEqual({ events: [], nextCursor: 0 });
  });
});
