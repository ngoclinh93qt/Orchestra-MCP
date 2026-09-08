import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/sessions/session-store.js";

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
    const store = new SessionStore({ allowedRoots: [allowedRoot], claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    const sessions = await store.list({});
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain("in-scope");
    expect(ids).not.toContain("out-of-scope");
  });

  it("filters by provider", async () => {
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ allowedRoots: [allowedRoot], claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    const codexOnly = await store.list({ provider: "codex" });
    expect(codexOnly.every((s) => s.provider === "codex")).toBe(true);
    expect(codexOnly.length).toBeGreaterThan(0);
  });
});

describe("SessionStore.read", () => {
  it("routes to the correct provider and still enforces the allowlist", async () => {
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ allowedRoots: [allowedRoot], claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    const page = await store.read("claude", "in-scope", {});
    expect(page.events).toHaveLength(1);

    const outOfScope = await store.read("claude", "out-of-scope", {});
    expect(outOfScope.events).toHaveLength(0);
  });
});
