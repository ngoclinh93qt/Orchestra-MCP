import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/store/event-log.js";

async function freshLogDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bridge-events-"));
}

describe("EventLog", () => {
  it("appends and reads events by cursor", async () => {
    const dir = await freshLogDir();
    const log = new EventLog(dir);
    log.append("task-1", { type: "assistant", text: "one" });
    log.append("task-1", { type: "assistant", text: "two" });

    const first = log.read("task-1", { cursor: 0, limit: 1 });
    expect(first.events).toEqual([{ type: "assistant", text: "one" }]);
    expect(first.nextCursor).toBe(1);

    const second = log.read("task-1", { cursor: first.nextCursor, limit: 10 });
    expect(second.events).toEqual([{ type: "assistant", text: "two" }]);
    expect(second.nextCursor).toBe(2);
  });

  it("returns no events past the end of the log", async () => {
    const dir = await freshLogDir();
    const log = new EventLog(dir);
    log.append("task-1", { type: "assistant", text: "one" });
    const page = log.read("task-1", { cursor: 5, limit: 10 });
    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBe(5);
  });

  it("returns an empty page for a task with no log yet", () => {
    const log = new EventLog("/tmp/does-not-matter-" + Math.random());
    const page = log.read("never-appended", { cursor: 0, limit: 10 });
    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBe(0);
  });

  it("redacts secret-looking keys before they are ever readable", async () => {
    const dir = await freshLogDir();
    const log = new EventLog(dir);
    log.append("task-1", {
      type: "progress",
      token: "sk-live-abc",
      Authorization: "Bearer xyz",
      api_key: "k-1",
      cookie: "session=1",
      text: "safe",
    });
    const page = log.read("task-1", { cursor: 0, limit: 1 });
    expect(page.events[0]).toEqual({
      type: "progress",
      token: "[REDACTED]",
      Authorization: "[REDACTED]",
      api_key: "[REDACTED]",
      cookie: "[REDACTED]",
      text: "safe",
    });
  });

  it("writes the log file with owner-only permissions", async () => {
    const dir = await freshLogDir();
    const log = new EventLog(dir);
    log.append("task-1", { type: "assistant", text: "one" });
    const info = await stat(join(dir, "task-1.jsonl"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("keeps only the newest events once the cap is exceeded", async () => {
    const dir = await freshLogDir();
    const log = new EventLog(dir, { maxEventsPerTask: 3 });
    for (let i = 0; i < 5; i += 1) log.append("task-1", { type: "assistant", text: `msg-${i}` });

    const page = log.read("task-1", { cursor: 0, limit: 10 });
    expect(page.events.map((e) => e.text)).toEqual(["msg-2", "msg-3", "msg-4"]);
  });
});
