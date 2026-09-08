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
});
