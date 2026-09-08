import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/providers/codex.js";

const fixtureLines = readFileSync(fileURLToPath(new URL("./fixtures/codex-events.jsonl", import.meta.url)), "utf8")
  .split("\n")
  .filter((line) => line.length > 0);

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter({ command: "codex" });

  it("builds a new-invocation command matching the installed CLI's exec grammar", () => {
    const invocation = adapter.newInvocation({ cwd: "/tmp/repo", prompt: "do the thing" });
    expect(invocation.command).toBe("codex");
    expect(invocation.args).toEqual(["exec", "--json", "--sandbox", "workspace-write", "-C", "/tmp/repo", "-"]);
    expect(invocation.stdin).toBe("do the thing");
    // The prompt must never appear in argv.
    expect(invocation.args.join(" ")).not.toContain("do the thing");
  });

  it("never uses a sandbox or approval bypass flag", () => {
    const invocation = adapter.newInvocation({ cwd: "/tmp/repo", prompt: "hello" });
    const resumed = adapter.resumeInvocation({ cwd: "/tmp/repo", prompt: "hello", providerSessionId: "s-1" });
    for (const args of [invocation.args, resumed.args]) {
      expect(args.join(" ")).not.toContain("dangerously-bypass");
    }
  });

  it("builds a resume-invocation command with the session id positional before flags", () => {
    const invocation = adapter.resumeInvocation({ cwd: "/tmp/repo", prompt: "continue", providerSessionId: "sess-42" });
    expect(invocation.args).toEqual(["exec", "resume", "sess-42", "--json", "-"]);
    expect(invocation.stdin).toBe("continue");
  });

  it("normalizes a thread.started event to a session event", () => {
    const events = adapter.parseLine("stdout", fixtureLines[0] ?? "");
    expect(events).toEqual([{ type: "session", session_id: "01a07fd1-35c6-70a0-905b-b08b5625160c" }]);
  });

  it("normalizes turn.started and item.completed to progress events", () => {
    expect(adapter.parseLine("stdout", fixtureLines[1] ?? "")).toEqual([{ type: "progress", note: "turn-started" }]);
    expect(adapter.parseLine("stdout", fixtureLines[2] ?? "")).toEqual([
      { type: "progress", item: { id: "item-1", item_type: "agent_message", text: "OK" } },
    ]);
  });

  it("normalizes turn.completed to a final event", () => {
    expect(adapter.parseLine("stdout", fixtureLines[3] ?? "")).toEqual([
      { type: "final", usage: { input_tokens: 42, output_tokens: 3 } },
    ]);
  });

  it("normalizes turn.failed to an error event", () => {
    expect(adapter.parseLine("stdout", fixtureLines[4] ?? "")).toEqual([
      { type: "error", message: "Example provider error." },
    ]);
  });

  it("normalizes an unrecognized event to unknown instead of throwing", () => {
    expect(adapter.parseLine("stdout", fixtureLines[5] ?? "")).toEqual([
      { type: "unknown", raw: { type: "some_future_event", payload: { note: "forward compatibility check" } } },
    ]);
  });

  it("normalizes unparseable stdout as unknown rather than crashing", () => {
    expect(adapter.parseLine("stdout", "not json at all")).toEqual([{ type: "unknown", text: "not json at all" }]);
  });

  it("captures stderr as an unknown/diagnostic event", () => {
    expect(adapter.parseLine("stderr", "warning: something noisy")).toEqual([
      { type: "unknown", stream: "stderr", text: "warning: something noisy" },
    ]);
  });

  it("ignores blank lines", () => {
    expect(adapter.parseLine("stdout", "")).toEqual([]);
    expect(adapter.parseLine("stdout", "   ")).toEqual([]);
  });
});
