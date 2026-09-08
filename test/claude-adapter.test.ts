import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/providers/claude.js";

const fixtureLines = readFileSync(fileURLToPath(new URL("./fixtures/claude-events.jsonl", import.meta.url)), "utf8")
  .split("\n")
  .filter((line) => line.length > 0);

describe("ClaudeAdapter", () => {
  const adapter = new ClaudeAdapter({ command: "claude" });

  it("builds a new-invocation command matching the installed CLI's print grammar", () => {
    const invocation = adapter.newInvocation({ cwd: "/tmp/repo", prompt: "do the thing" });
    expect(invocation.command).toBe("claude");
    expect(invocation.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
      "--verbose",
      "do the thing",
    ]);
    // stream-json with -p is rejected by the installed CLI unless --verbose is present.
    expect(invocation.args).toContain("--verbose");
    expect(invocation.stdin).toBe("");
  });

  it("never uses a permission bypass flag", () => {
    const invocation = adapter.newInvocation({ cwd: "/tmp/repo", prompt: "hello" });
    const resumed = adapter.resumeInvocation({ cwd: "/tmp/repo", prompt: "hello", providerSessionId: "s-1" });
    for (const args of [invocation.args, resumed.args]) {
      expect(args.join(" ")).not.toContain("dangerously-skip-permissions");
    }
  });

  it("builds a resume-invocation command with --resume and the session id", () => {
    const invocation = adapter.resumeInvocation({ cwd: "/tmp/repo", prompt: "continue", providerSessionId: "sess-42" });
    expect(invocation.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
      "--verbose",
      "--resume",
      "sess-42",
      "continue",
    ]);
  });

  it("normalizes a system/init event to a session event", () => {
    expect(adapter.parseLine("stdout", fixtureLines[0] ?? "")).toEqual([
      { type: "session", session_id: "session-abc-123" },
    ]);
  });

  it("normalizes an assistant message to a progress event", () => {
    expect(adapter.parseLine("stdout", fixtureLines[1] ?? "")).toEqual([
      { type: "progress", text: "Looking at the repository now." },
    ]);
  });

  it("normalizes a successful result to a final event", () => {
    expect(adapter.parseLine("stdout", fixtureLines[2] ?? "")).toEqual([{ type: "final", text: "Task complete." }]);
  });

  it("normalizes a failed result to an error event", () => {
    expect(adapter.parseLine("stdout", fixtureLines[3] ?? "")).toEqual([
      { type: "error", message: "Example provider error." },
    ]);
  });

  it("normalizes an unrecognized event to unknown instead of throwing", () => {
    expect(adapter.parseLine("stdout", fixtureLines[4] ?? "")).toEqual([
      { type: "unknown", raw: { type: "some_future_event", payload: { note: "forward compatibility check" } } },
    ]);
  });

  it("normalizes unparseable stdout as unknown rather than crashing", () => {
    expect(adapter.parseLine("stdout", "not json at all")).toEqual([{ type: "unknown", text: "not json at all" }]);
  });

  it("ignores blank lines", () => {
    expect(adapter.parseLine("stdout", "")).toEqual([]);
  });
});
