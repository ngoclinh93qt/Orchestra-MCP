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

  it("tolerates malformed JSON lines with diagnostic markers", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "claude-projects-malformed-"));
    const projectDir = join(baseDir, "-Users-thief-nik-demo");
    await mkdir(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "system", cwd: "/Users/thief/nik/demo", sessionId: "session-with-malformed", timestamp: "2026-09-01T00:00:00Z" }),
      JSON.stringify({ type: "user", cwd: "/Users/thief/nik/demo", sessionId: "session-with-malformed", text: "hello" }),
      "{this is not valid json at all]",
      JSON.stringify({ type: "assistant", cwd: "/Users/thief/nik/demo", sessionId: "session-with-malformed", token: "sk-abc" }),
    ];
    await writeFile(join(projectDir, "session-with-malformed.jsonl"), `${lines.join("\n")}\n`);

    const page = await readClaudeSession(baseDir, "session-with-malformed", { cursor: 0, limit: 4 });
    expect(page.events).toHaveLength(4);
    expect(page.events[0]).toEqual({ type: "system", cwd: "/Users/thief/nik/demo", sessionId: "session-with-malformed", timestamp: "2026-09-01T00:00:00Z" });
    expect(page.events[1]).toEqual({ type: "user", cwd: "/Users/thief/nik/demo", sessionId: "session-with-malformed", text: "hello" });
    expect(page.events[2]).toEqual({ type: "unparsed", raw: "{this is not valid json at all]" });
    expect(page.events[3]).toEqual({ type: "assistant", cwd: "/Users/thief/nik/demo", sessionId: "session-with-malformed", token: "[REDACTED]" });
  });

  it("rejects sessionId with path traversal characters", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "claude-projects-traversal-"));
    const projectDir = join(baseDir, "-Users-thief-nik-demo");
    const outsideDir = join(baseDir, "outside-project");
    await mkdir(projectDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    // Create a real session inside the project directory
    const safeLines = [JSON.stringify({ type: "system", cwd: "/Users/thief/nik/demo", sessionId: "safe-session", timestamp: "2026-09-01T00:00:00Z" })];
    await writeFile(join(projectDir, "safe-session.jsonl"), `${safeLines.join("\n")}\n`);

    // Create a decoy session file outside the intended project directory
    const decoyLines = [JSON.stringify({ type: "system", cwd: "/Users/thief/nik/demo", sessionId: "decoy", timestamp: "2026-09-01T00:00:00Z" })];
    await writeFile(join(outsideDir, "decoy.jsonl"), `${decoyLines.join("\n")}\n`);

    // Attempt to access the outside file via path traversal
    const page = await readClaudeSession(baseDir, "../outside-project/decoy", { cursor: 0, limit: 10 });
    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBe(0);

    // Verify the safe session is still accessible
    const safePage = await readClaudeSession(baseDir, "safe-session", { cursor: 0, limit: 10 });
    expect(safePage.events).toHaveLength(1);
    expect(safePage.events[0]?.sessionId).toBe("safe-session");
  });

  it("redacts unparsed-line fallback to prevent secret leakage", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "claude-projects-unparsed-redaction-"));
    const projectDir = join(baseDir, "-Users-thief-nik-demo");
    await mkdir(projectDir, { recursive: true });

    // Create a session file with a malformed line containing a secret-shaped fragment
    const lines = [
      JSON.stringify({ type: "system", cwd: "/Users/thief/nik/demo", sessionId: "session-unparsed-redact", timestamp: "2026-09-01T00:00:00Z" }),
      "not valid json but has token: \"sk-live-abc123def456\" in it and should be redacted",
      JSON.stringify({ type: "assistant", cwd: "/Users/thief/nik/demo", sessionId: "session-unparsed-redact", text: "done" }),
    ];
    await writeFile(join(projectDir, "session-unparsed-redact.jsonl"), `${lines.join("\n")}\n`);

    // Read the session including the malformed line
    const page = await readClaudeSession(baseDir, "session-unparsed-redact", { cursor: 0, limit: 3 });

    expect(page.events).toHaveLength(3);
    expect(page.events[0]).toEqual({ type: "system", cwd: "/Users/thief/nik/demo", sessionId: "session-unparsed-redact", timestamp: "2026-09-01T00:00:00Z" });

    // Verify the malformed line's raw field is redacted (not containing the raw secret)
    const unparseEvent = page.events[1] as Record<string, unknown>;
    expect(unparseEvent.type).toBe("unparsed");
    expect(typeof unparseEvent.raw).toBe("string");
    const rawText = unparseEvent.raw as string;
    // Check that the raw text does NOT contain the unredacted secret
    expect(rawText).not.toContain("sk-live-abc123def456");
    // Check that it contains the redaction marker
    expect(rawText).toContain("[REDACTED]");
    // Verify the structure is preserved (the line is truncated to 200 chars)
    expect(rawText).toContain("not valid json but has token:");

    expect(page.events[2]).toEqual({ type: "assistant", cwd: "/Users/thief/nik/demo", sessionId: "session-unparsed-redact", text: "done" });
  });

  it("redacts secrets even when closing quote falls past truncation boundary", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "claude-projects-long-secret-"));
    const projectDir = join(baseDir, "-Users-thief-nik-demo");
    await mkdir(projectDir, { recursive: true });

    // Create a malformed line longer than 200 chars where the secret assignment's
    // closing quote falls past character 200. This tests that we redact the full
    // line BEFORE truncating, not the other way around (which would miss the closing quote).
    // After redaction, the [REDACTED] marker still fits within 200 chars, but if we truncated
    // first (old code), the closing quote would be cut off and the regex wouldn't match.
    const longLineWithSecret = `malformed line with padding: ${" ".repeat(140)}secret_token: "sk-prod-a1b2c3d4e5f6g7h8i9j0-very-long-unique-token";extra_stuff_here`;
    const lines = [
      JSON.stringify({ type: "system", cwd: "/Users/thief/nik/demo", sessionId: "session-long-secret", timestamp: "2026-09-01T00:00:00Z" }),
      longLineWithSecret,
      JSON.stringify({ type: "assistant", cwd: "/Users/thief/nik/demo", sessionId: "session-long-secret", text: "done" }),
    ];
    await writeFile(join(projectDir, "session-long-secret.jsonl"), `${lines.join("\n")}\n`);

    const page = await readClaudeSession(baseDir, "session-long-secret", { cursor: 0, limit: 3 });

    expect(page.events).toHaveLength(3);
    expect(page.events[0]).toEqual({ type: "system", cwd: "/Users/thief/nik/demo", sessionId: "session-long-secret", timestamp: "2026-09-01T00:00:00Z" });

    const unparseEvent = page.events[1] as Record<string, unknown>;
    expect(unparseEvent.type).toBe("unparsed");
    expect(typeof unparseEvent.raw).toBe("string");
    const rawText = unparseEvent.raw as string;
    // Verify redaction happened (should contain [REDACTED], not the raw secret)
    expect(rawText).toContain("[REDACTED]");
    expect(rawText).not.toContain("sk-prod-a1b2c3d4e5f6g7h8i9j0");
    // Verify truncation happened (200 char limit)
    expect(rawText.length).toBeLessThanOrEqual(200);

    expect(page.events[2]).toEqual({ type: "assistant", cwd: "/Users/thief/nik/demo", sessionId: "session-long-secret", text: "done" });
  });
});
