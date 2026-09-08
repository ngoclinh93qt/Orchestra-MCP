import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createToolHandlers } from "../src/mcp/register-tools.js";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "../src/mcp/tool-schemas.js";
import type { ProviderAdapter, ProviderEvent } from "../src/providers/provider.js";
import { EventLog } from "../src/store/event-log.js";
import { TaskStore } from "../src/store/task-store.js";
import { JobSupervisor } from "../src/supervisor/job-supervisor.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

function fakeAdapter(mode: string): ProviderAdapter {
  return {
    name: "codex",
    async checkAvailable() {},
    newInvocation({ cwd, prompt }) {
      return { command: process.execPath, args: [fixture], cwd, stdin: prompt, env: { FAKE_AGENT_MODE: mode } };
    },
    resumeInvocation({ cwd, prompt }) {
      return { command: process.execPath, args: [fixture], cwd, stdin: prompt, env: { FAKE_AGENT_MODE: mode } };
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
  readonly handlers: ReturnType<typeof createToolHandlers>;
  readonly taskStore: TaskStore;
  readonly supervisor: JobSupervisor;
  readonly cwd: string;
}

const harnesses: Harness[] = [];

async function buildHarness(mode: string): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "bridge-mcp-tools-"));
  const cwd = join(base, "repo");
  await mkdir(cwd, { recursive: true });
  const taskStore = new TaskStore(":memory:");
  const eventLog = new EventLog(join(base, "logs"));
  const supervisor = new JobSupervisor({
    taskStore,
    eventLog,
    adapters: { codex: fakeAdapter(mode) },
    allowedRoots: [base],
    maxConcurrentTotal: 2,
    maxConcurrentPerProvider: 1,
    maxPromptBytes: 1_000_000,
    gracefulTimeoutMs: 50,
  });
  const handlers = createToolHandlers({ supervisor, taskStore, eventLog });
  const harness = { handlers, taskStore, supervisor, cwd };
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

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected a text content block");
  }
  return first.text;
}

describe("tool schema surface", () => {
  it("exposes exactly six tools", () => {
    expect(TOOL_NAMES).toEqual([
      "agent_start",
      "agent_list",
      "agent_status",
      "agent_output",
      "agent_continue",
      "agent_cancel",
    ]);
    expect(TOOL_DEFINITIONS).toHaveLength(6);
  });

  it("marks list/status/output read-only and start/continue/cancel as writes", () => {
    const byName = Object.fromEntries(TOOL_DEFINITIONS.map((d) => [d.name, d]));
    expect(byName["agent_list"]?.annotations.readOnlyHint).toBe(true);
    expect(byName["agent_status"]?.annotations.readOnlyHint).toBe(true);
    expect(byName["agent_output"]?.annotations.readOnlyHint).toBe(true);
    expect(byName["agent_start"]?.annotations.readOnlyHint).toBe(false);
    expect(byName["agent_continue"]?.annotations.readOnlyHint).toBe(false);
    expect(byName["agent_cancel"]?.annotations.readOnlyHint).toBe(false);
  });

  it("marks agent_cancel idempotent", () => {
    const cancel = TOOL_DEFINITIONS.find((d) => d.name === "agent_cancel");
    expect(cancel?.annotations.idempotentHint).toBe(true);
  });
});

describe("tool handlers", () => {
  it("agent_start returns immediately with a queued or running task, never the prompt", async () => {
    const { handlers, cwd } = await buildHarness("success");
    const result = await handlers.agent_start({ provider: "codex", cwd, prompt: "secret prompt text" });
    const summary = JSON.parse(textOf(result));
    expect(["queued", "running"]).toContain(summary.state);
    expect(JSON.stringify(summary)).not.toContain("secret prompt text");
    expect(summary.cwd).toBeDefined();
    expect(summary.provider).toBe("codex");
  });

  it("agent_status reports a missing task as a tool error, not a crash", async () => {
    const { handlers } = await buildHarness("success");
    const result = await handlers.agent_status({ taskId: "does-not-exist" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does-not-exist");
  });

  it("agent_list is read-only and returns newest-first summaries", async () => {
    const { handlers, taskStore, cwd } = await buildHarness("success");
    await handlers.agent_start({ provider: "codex", cwd, prompt: "one" });
    await waitUntil(() => taskStore.list().length === 1);
    const result = await handlers.agent_list({});
    const parsed = JSON.parse(textOf(result));
    expect(parsed.tasks).toHaveLength(1);
  });

  it("agent_output paginates by cursor", async () => {
    const { handlers, taskStore, cwd } = await buildHarness("success");
    const started = JSON.parse(textOf(await handlers.agent_start({ provider: "codex", cwd, prompt: "hi" })));
    await waitUntil(() => taskStore.get(started.taskId)?.state === "succeeded");

    const first = JSON.parse(textOf(await handlers.agent_output({ taskId: started.taskId, cursor: 0, limit: 1 })));
    expect(first.events).toHaveLength(1);
    expect(first.nextCursor).toBe(1);

    const second = JSON.parse(
      textOf(await handlers.agent_output({ taskId: started.taskId, cursor: first.nextCursor, limit: 10 })),
    );
    expect(second.events.length).toBeGreaterThan(0);
  });

  it("agent_continue requires the parent to have a provider session", async () => {
    const { handlers, taskStore, cwd } = await buildHarness("success");
    // A task interrupted before ever reaching a provider session has nothing to resume.
    const orphan = taskStore.create({ provider: "codex", cwd, promptBytes: 1 });
    taskStore.transition(orphan.id, "running");
    taskStore.transition(orphan.id, "interrupted");

    const result = await handlers.agent_continue({ taskId: orphan.id, message: "keep going" });
    expect(result.isError).toBe(true);
  });

  it("agent_continue resumes a finished task's session as a new linked task", async () => {
    const { handlers, taskStore, cwd } = await buildHarness("success");
    const started = JSON.parse(textOf(await handlers.agent_start({ provider: "codex", cwd, prompt: "hi" })));
    await waitUntil(() => taskStore.get(started.taskId)?.state === "succeeded");

    const continued = JSON.parse(
      textOf(await handlers.agent_continue({ taskId: started.taskId, message: "and then?" })),
    );
    expect(continued.taskId).not.toBe(started.taskId);
    expect(continued.parentId).toBe(started.taskId);
  });

  it("agent_cancel is idempotent for an already-finished task", async () => {
    const { handlers, taskStore, cwd } = await buildHarness("success");
    const started = JSON.parse(textOf(await handlers.agent_start({ provider: "codex", cwd, prompt: "hi" })));
    await waitUntil(() => taskStore.get(started.taskId)?.state === "succeeded");

    const first = JSON.parse(textOf(await handlers.agent_cancel({ taskId: started.taskId })));
    const second = JSON.parse(textOf(await handlers.agent_cancel({ taskId: started.taskId })));
    expect(first.state).toBe("succeeded");
    expect(second.state).toBe("succeeded");
  });
});
