import { describe, expect, it } from "vitest";
import { IllegalTaskTransitionError, TaskNotFoundError } from "../src/errors.js";
import { TaskStore } from "../src/store/task-store.js";

function freshStore(): TaskStore {
  return new TaskStore(":memory:");
}

describe("TaskStore", () => {
  it("creates a queued task with no session and no output yet", () => {
    const store = freshStore();
    const task = store.create({ provider: "codex", cwd: "/tmp/repo", promptBytes: 12 });
    expect(task.state).toBe("queued");
    expect(task.provider).toBe("codex");
    expect(task.providerSessionId).toBeNull();
    expect(task.parentId).toBeNull();
    expect(store.get(task.id)).toEqual(task);
  });

  it("allows legal transitions and records provider session id", () => {
    const store = freshStore();
    const task = store.create({ provider: "claude", cwd: "/tmp/repo", promptBytes: 4 });
    const running = store.transition(task.id, "running", { providerSessionId: "sess-1" });
    expect(running.state).toBe("running");
    expect(running.providerSessionId).toBe("sess-1");
    const done = store.transition(task.id, "succeeded", { exitCode: 0 });
    expect(done.state).toBe("succeeded");
    expect(done.exitCode).toBe(0);
  });

  it("rejects illegal transitions", () => {
    const store = freshStore();
    const task = store.create({ provider: "codex", cwd: "/tmp/repo", promptBytes: 1 });
    store.transition(task.id, "running");
    store.transition(task.id, "succeeded");
    expect(() => store.transition(task.id, "running")).toThrow(IllegalTaskTransitionError);
  });

  it("makes cancellation idempotent", () => {
    const store = freshStore();
    const task = store.create({ provider: "codex", cwd: "/tmp/repo", promptBytes: 1 });
    store.transition(task.id, "running");
    const first = store.transition(task.id, "cancelled");
    const second = store.transition(task.id, "cancelled");
    expect(first.state).toBe("cancelled");
    expect(second.state).toBe("cancelled");
  });

  it("throws for an unknown task id", () => {
    const store = freshStore();
    expect(() => store.transition("missing", "running")).toThrow(TaskNotFoundError);
  });

  it("links a continuation task to its parent", () => {
    const store = freshStore();
    const parent = store.create({ provider: "codex", cwd: "/tmp/repo", promptBytes: 1 });
    const child = store.create({ provider: "codex", cwd: "/tmp/repo", promptBytes: 2, parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });

  it("filters and lists tasks newest first", () => {
    const store = freshStore();
    const a = store.create({ provider: "codex", cwd: "/tmp/repo", promptBytes: 1 });
    const b = store.create({ provider: "claude", cwd: "/tmp/repo", promptBytes: 1 });
    const listed = store.list({ provider: "codex" });
    expect(listed.map((t) => t.id)).toEqual([a.id]);
    const all = store.list();
    expect(all.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("marks unsupervised active tasks interrupted on restart reconciliation", () => {
    const store = freshStore();
    const task = store.create({ provider: "codex", cwd: "/tmp/repo", promptBytes: 1 });
    store.transition(task.id, "running");
    const finished = store.create({ provider: "codex", cwd: "/tmp/repo", promptBytes: 1 });
    store.transition(finished.id, "running");
    store.transition(finished.id, "succeeded");

    const changed = store.reconcileAfterRestart();

    expect(changed).toBe(1);
    expect(store.get(task.id)?.state).toBe("interrupted");
    expect(store.get(finished.id)?.state).toBe("succeeded");
  });
});
