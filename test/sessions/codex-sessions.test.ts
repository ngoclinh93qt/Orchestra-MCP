import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listCodexSessions, readCodexSession } from "../../src/sessions/codex-sessions.js";

async function buildFixtureSessionsDir(): Promise<string> {
  const baseDir = await mkdtemp(join(tmpdir(), "codex-sessions-"));
  const dateDir = join(baseDir, "2026", "09", "03");
  await mkdir(dateDir, { recursive: true });

  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id: "rollout-1" } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", cwd: "/Users/thief/nik/demo" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", token: "sk-abc" } }),
  ];
  await writeFile(join(dateDir, "rollout-2026-09-03T00-00-00-rollout-1.jsonl"), `${lines.join("\n")}\n`);

  // No turn_context at all: cwd cannot be determined, must be excluded.
  await writeFile(
    join(dateDir, "rollout-2026-09-03T00-01-00-rollout-2.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { id: "rollout-2" } })}\n`,
  );

  return baseDir;
}

describe("listCodexSessions", () => {
  it("discovers rollouts across date directories and extracts cwd from turn_context", async () => {
    const baseDir = await buildFixtureSessionsDir();
    const sessions = await listCodexSessions(baseDir);
    const withCwd = sessions.find((s) => s.sessionId === "rollout-2026-09-03T00-00-00-rollout-1");
    expect(withCwd?.cwd).toBe("/Users/thief/nik/demo");
    expect(withCwd?.provider).toBe("codex");
    expect(withCwd?.lastEventHint).toBe("task_complete");
  });

  it("excludes a rollout with no turn_context cwd", async () => {
    const baseDir = await buildFixtureSessionsDir();
    const sessions = await listCodexSessions(baseDir);
    expect(sessions.some((s) => s.sessionId === "rollout-2026-09-03T00-01-00-rollout-2")).toBe(false);
  });
});

describe("readCodexSession", () => {
  it("returns paginated, redacted rollout content", async () => {
    const baseDir = await buildFixtureSessionsDir();
    const page = await readCodexSession(baseDir, "rollout-2026-09-03T00-00-00-rollout-1", { cursor: 3, limit: 1 });
    expect(page.events).toEqual([{ type: "event_msg", payload: { type: "task_complete", token: "[REDACTED]" } }]);
  });

  it("tolerates malformed JSON lines with diagnostic markers", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "codex-sessions-malformed-"));
    const dateDir = join(baseDir, "2026", "09", "03");
    await mkdir(dateDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "turn_context", payload: { cwd: "/Users/thief/nik/demo" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      "{this is not valid json at all]",
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ];
    await writeFile(join(dateDir, "rollout-2026-09-03T00-00-00-malformed.jsonl"), `${lines.join("\n")}\n`);

    const page = await readCodexSession(baseDir, "rollout-2026-09-03T00-00-00-malformed", { cursor: 0, limit: 4 });
    expect(page.events).toHaveLength(4);
    expect(page.events[0]).toEqual({ type: "turn_context", payload: { cwd: "/Users/thief/nik/demo" } });
    expect(page.events[1]).toEqual({ type: "event_msg", payload: { type: "task_started" } });
    expect(page.events[2]).toEqual({ type: "unparsed", raw: "{this is not valid json at all]" });
    expect(page.events[3]).toEqual({ type: "event_msg", payload: { type: "task_complete" } });
  });

  it("rejects sessionId with path traversal characters", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "codex-sessions-traversal-"));
    const dateDir = join(baseDir, "2026", "09", "03");
    const outsideDir = join(baseDir, "outside");
    await mkdir(dateDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    // Create a real rollout inside the intended directory
    const safeLines = [JSON.stringify({ type: "turn_context", payload: { cwd: "/Users/thief/nik/demo" } })];
    await writeFile(join(dateDir, "rollout-2026-09-03T00-00-00-safe.jsonl"), `${safeLines.join("\n")}\n`);

    // Create a decoy rollout outside the intended directory
    const decoyLines = [JSON.stringify({ type: "turn_context", payload: { cwd: "/Users/thief/nik/demo" } })];
    await writeFile(join(outsideDir, "rollout-2026-09-03T00-01-00-decoy.jsonl"), `${decoyLines.join("\n")}\n`);

    // Attempt to access the outside file via path traversal
    const page = await readCodexSession(baseDir, "../outside/rollout-2026-09-03T00-01-00-decoy", { cursor: 0, limit: 10 });
    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBe(0);

    // Verify the safe rollout is still accessible
    const safePage = await readCodexSession(baseDir, "rollout-2026-09-03T00-00-00-safe", { cursor: 0, limit: 10 });
    expect(safePage.events).toHaveLength(1);
    expect(safePage.events[0]?.type).toBe("turn_context");
  });

  it("redacts unparsed-line fallback to prevent secret leakage", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "codex-sessions-unparsed-redaction-"));
    const dateDir = join(baseDir, "2026", "09", "03");
    await mkdir(dateDir, { recursive: true });

    // Create a rollout file with a malformed line containing a secret-shaped fragment
    const lines = [
      JSON.stringify({ type: "turn_context", payload: { cwd: "/Users/thief/nik/demo" } }),
      "not valid json but has token: \"sk-live-abc123def456\" in it and should be redacted",
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ];
    await writeFile(join(dateDir, "rollout-2026-09-03T00-00-00-unparsed-redact.jsonl"), `${lines.join("\n")}\n`);

    // Read the rollout including the malformed line
    const page = await readCodexSession(baseDir, "rollout-2026-09-03T00-00-00-unparsed-redact", { cursor: 0, limit: 3 });

    expect(page.events).toHaveLength(3);
    expect(page.events[0]).toEqual({ type: "turn_context", payload: { cwd: "/Users/thief/nik/demo" } });

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

    expect(page.events[2]).toEqual({ type: "event_msg", payload: { type: "task_complete" } });
  });

  it("redacts secrets even when closing quote falls past truncation boundary", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "codex-sessions-long-secret-"));
    const dateDir = join(baseDir, "2026", "09", "03");
    await mkdir(dateDir, { recursive: true });

    // Create a malformed line longer than 200 chars where the secret assignment's
    // closing quote falls past character 200. This tests that we redact the full
    // line BEFORE truncating, not the other way around (which would miss the closing quote).
    // After redaction, the [REDACTED] marker still fits within 200 chars, but if we truncated
    // first (old code), the closing quote would be cut off and the regex wouldn't match.
    const longLineWithSecret = `malformed line with padding: ${" ".repeat(140)}secret_token: "sk-prod-a1b2c3d4e5f6g7h8i9j0-very-long-unique-token";extra_stuff_here`;
    const lines = [
      JSON.stringify({ type: "turn_context", payload: { cwd: "/Users/thief/nik/demo" } }),
      longLineWithSecret,
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ];
    await writeFile(join(dateDir, "rollout-2026-09-03T00-00-00-long-secret.jsonl"), `${lines.join("\n")}\n`);

    const page = await readCodexSession(baseDir, "rollout-2026-09-03T00-00-00-long-secret", { cursor: 0, limit: 3 });

    expect(page.events).toHaveLength(3);
    expect(page.events[0]).toEqual({ type: "turn_context", payload: { cwd: "/Users/thief/nik/demo" } });

    const unparseEvent = page.events[1] as Record<string, unknown>;
    expect(unparseEvent.type).toBe("unparsed");
    expect(typeof unparseEvent.raw).toBe("string");
    const rawText = unparseEvent.raw as string;
    // Verify redaction happened (should contain [REDACTED], not the raw secret)
    expect(rawText).toContain("[REDACTED]");
    expect(rawText).not.toContain("sk-prod-a1b2c3d4e5f6g7h8i9j0");
    // Verify truncation happened (200 char limit)
    expect(rawText.length).toBeLessThanOrEqual(200);

    expect(page.events[2]).toEqual({ type: "event_msg", payload: { type: "task_complete" } });
  });
});
