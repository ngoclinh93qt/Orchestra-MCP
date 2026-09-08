import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listClaudeSessions, readClaudeSession } from "../../src/sessions/claude-sessions.js";

async function buildFixtureProjectsDir(): Promise<string> {
  const baseDir = await mkdtemp(join(tmpdir(), "claude-projects-"));
  const projectDir = join(baseDir, "-Users-thief-nik-demo");
  await mkdir(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "system", cwd: "/Users/thief/nik/demo", sessionId: "session-1", timestamp: "2026-09-01T00:00:00Z" }),
    JSON.stringify({ type: "user", cwd: "/Users/thief/nik/demo", sessionId: "session-1", text: "hello" }),
    JSON.stringify({ type: "assistant", cwd: "/Users/thief/nik/demo", sessionId: "session-1", token: "sk-abc" }),
  ];
  await writeFile(join(projectDir, "session-1.jsonl"), `${lines.join("\n")}\n`);

  // A session with no determinable cwd must be excluded by callers, not guessed at.
  const undetectableDir = join(baseDir, "-some-other-project");
  await mkdir(undetectableDir, { recursive: true });
  await writeFile(join(undetectableDir, "session-2.jsonl"), `${JSON.stringify({ type: "system", timestamp: "2026-09-01T00:00:00Z" })}\n`);

  return baseDir;
}

describe("listClaudeSessions", () => {
  it("discovers sessions and reads cwd from content, not the directory slug", async () => {
    const baseDir = await buildFixtureProjectsDir();
    const sessions = await listClaudeSessions(baseDir);
    const withCwd = sessions.find((s) => s.sessionId === "session-1");
    expect(withCwd?.cwd).toBe("/Users/thief/nik/demo");
    expect(withCwd?.provider).toBe("claude");
    expect(withCwd?.lastEventHint).toBe("assistant");
  });

  it("excludes a session whose cwd cannot be determined", async () => {
    const baseDir = await buildFixtureProjectsDir();
    const sessions = await listClaudeSessions(baseDir);
    expect(sessions.some((s) => s.sessionId === "session-2")).toBe(false);
  });
});

describe("readClaudeSession", () => {
  it("returns paginated, redacted session content", async () => {
    const baseDir = await buildFixtureProjectsDir();
    const page = await readClaudeSession(baseDir, "session-1", { cursor: 2, limit: 1 });
    expect(page.events).toEqual([{ type: "assistant", cwd: "/Users/thief/nik/demo", sessionId: "session-1", token: "[REDACTED]" }]);
    expect(page.nextCursor).toBe(3);
  });
});
