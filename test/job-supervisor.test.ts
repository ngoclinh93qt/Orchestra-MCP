import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConcurrencyLimitError } from "../src/errors.js";
import type { ProviderAdapter, ProviderEvent } from "../src/providers/provider.js";
import { EventLog } from "../src/store/event-log.js";
import { TaskStore } from "../src/store/task-store.js";
import { JobSupervisor } from "../src/supervisor/job-supervisor.js";
import { accessPolicyFor } from "./helpers/policy.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

function fakeAdapter(mode: string): ProviderAdapter {
  return {
    name: "codex",
    async checkAvailable() {
      // Always available; this is a fixture, not a real CLI probe.
    },
    newInvocation({ cwd, prompt }) {
      return { command: process.execPath, args: [fixture], cwd, stdin: prompt, env: { FAKE_AGENT_MODE: mode } };
    },
    resumeInvocation({ cwd, prompt }) {
      return {
        command: process.execPath,
        args: [fixture, "--resume"],
        cwd,
        stdin: prompt,
        env: { FAKE_AGENT_MODE: mode },
      };
    },
    parseLine(stream, line): readonly ProviderEvent[] {
      if (line.trim().length === 0) return [];
      if (stream === "stderr") return [{ type: "stderr", text: line }];
      try {
        return [JSON.parse(line) as ProviderEvent];
      } catch {
        return [{ type: "diagnostic", text: line }];
      }
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Harness {
  readonly supervisor: JobSupervisor;
  readonly taskStore: TaskStore;
  readonly eventLog: EventLog;
  readonly cwd: string;
}

const harnesses: Harness[] = [];

async function buildHarness(
  mode: string,
  overrides: Partial<{ maxConcurrentTotal: number; maxConcurrentPerProvider: number; maxPromptBytes: number; gracefulTimeoutMs: number }> = {},
): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "bridge-supervisor-"));
  const cwd = join(base, "repo");
  await mkdir(cwd, { recursive: true });
  const taskStore = new TaskStore(":memory:");
  const eventLog = new EventLog(join(base, "logs"));
  const supervisor = new JobSupervisor({
    taskStore,
    eventLog,
    adapters: { codex: fakeAdapter(mode) },
    policy: accessPolicyFor(base),
    maxConcurrentTotal: overrides.maxConcurrentTotal ?? 2,
    maxConcurrentPerProvider: overrides.maxConcurrentPerProvider ?? 1,
    maxPromptBytes: overrides.maxPromptBytes ?? 1_000_000,
    gracefulTimeoutMs: overrides.gracefulTimeoutMs ?? 50,
  });
  const harness = { supervisor, taskStore, eventLog, cwd };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.supervisor.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));
    h.taskStore.close();
  }
});

describe("JobSupervisor", () => {
  it("runs a task to completion and records its provider session", async () => {
    const { supervisor, taskStore, eventLog, cwd } = await buildHarness("success");
    const task = await supervisor.start({ provider: "codex", cwd, prompt: "hello" });

    await waitUntil(() => taskStore.get(task.id)?.state === "succeeded");

    const finished = taskStore.get(task.id);
    expect(finished?.state).toBe("succeeded");
    expect(finished?.exitCode).toBe(0);
    expect(finished?.providerSessionId).toBe("sess-fake-1");

    const page = eventLog.read(task.id, { cursor: 0, limit: 10 });
    expect(page.events.some((e) => e["type"] === "final")).toBe(true);
  });

  it("marks a nonzero exit as failed with a redacted-clean error summary", async () => {
    const { supervisor, taskStore, cwd } = await buildHarness("failure");
    const task = await supervisor.start({ provider: "codex", cwd, prompt: "hello" });

    await waitUntil(() => taskStore.get(task.id)?.state === "failed");

    const finished = taskStore.get(task.id);
    expect(finished?.state).toBe("failed");
    expect(finished?.exitCode).toBe(1);
    expect(finished?.errorSummary).toBe("boom");
  });

  it("does not crash on malformed provider output and still reaches a terminal state", async () => {
    const { supervisor, taskStore, eventLog, cwd } = await buildHarness("malformed");
    const task = await supervisor.start({ provider: "codex", cwd, prompt: "hello" });

    await waitUntil(() => taskStore.get(task.id)?.state === "succeeded");

    const page = eventLog.read(task.id, { cursor: 0, limit: 10 });
    expect(page.events.some((e) => e["type"] === "diagnostic")).toBe(true);
    expect(page.events.some((e) => e["type"] === "final")).toBe(true);
  });

  it("never invokes a shell, so prompt metacharacters reach the provider unexpanded", async () => {
    const { supervisor, taskStore, eventLog, cwd } = await buildHarness("success");
    const dangerous = 'before $(id) after `whoami` ; rm -rf /tmp/should-not-exist && echo done';
    const task = await supervisor.start({ provider: "codex", cwd, prompt: dangerous });

    await waitUntil(() => taskStore.get(task.id)?.state === "succeeded");

    const page = eventLog.read(task.id, { cursor: 0, limit: 10 });
    const progress = page.events.find((e) => e["type"] === "progress");
    expect(progress?.["text"]).toBe(`echo:${dangerous}`);
  });

  it("cancels a running task by killing its exact process group", async () => {
    const { supervisor, taskStore, cwd } = await buildHarness("hang", { gracefulTimeoutMs: 50 });
    const task = await supervisor.start({ provider: "codex", cwd, prompt: "hello" });

    await waitUntil(() => taskStore.get(task.id)?.providerSessionId === "sess-fake-hang");
    supervisor.cancel(task.id);

    await waitUntil(() => taskStore.get(task.id)?.state === "cancelled", 3000);
    expect(taskStore.get(task.id)?.state).toBe("cancelled");
  });

  it("makes cancelling an already-finished task idempotent", async () => {
    const { supervisor, taskStore, cwd } = await buildHarness("success");
    const task = await supervisor.start({ provider: "codex", cwd, prompt: "hello" });
    await waitUntil(() => taskStore.get(task.id)?.state === "succeeded");

    // Cancel is defined for running tasks; calling it after completion must not throw,
    // even though the task is no longer actively supervised.
    expect(() => supervisor.cancel(task.id)).not.toThrow();
  });

  it("rejects a start once the per-provider concurrency limit is reached", async () => {
    const { supervisor, cwd } = await buildHarness("hang", { maxConcurrentPerProvider: 1, maxConcurrentTotal: 2 });
    await supervisor.start({ provider: "codex", cwd, prompt: "first" });

    await expect(supervisor.start({ provider: "codex", cwd, prompt: "second" })).rejects.toBeInstanceOf(
      ConcurrencyLimitError,
    );
  });

  it("rejects a start once the total concurrency limit is reached", async () => {
    const { supervisor, cwd } = await buildHarness("hang", {
      maxConcurrentPerProvider: 5,
      maxConcurrentTotal: 1,
    });
    await supervisor.start({ provider: "codex", cwd, prompt: "first" });

    await expect(supervisor.start({ provider: "codex", cwd, prompt: "second" })).rejects.toBeInstanceOf(
      ConcurrencyLimitError,
    );
  });
});
