import { resolveAllowedDirectory } from "../config.js";
import { isTerminalState, type BridgeTask, type Provider } from "../domain/task.js";
import {
  ConcurrencyLimitError,
  PromptTooLargeError,
  TaskNotFoundError,
  TaskNotResumableError,
} from "../errors.js";
import type { AccessPolicy } from "../policy/files-policy.js";
import type { ProviderAdapter, ProviderInvocation } from "../providers/provider.js";
import type { EventLog } from "../store/event-log.js";
import type { TaskStore } from "../store/task-store.js";
import { startProcess, type RunningProcess } from "./process-runner.js";

export interface JobSupervisorOptions {
  readonly taskStore: TaskStore;
  readonly eventLog: EventLog;
  readonly adapters: Readonly<Partial<Record<Provider, ProviderAdapter>>>;
  readonly policy: AccessPolicy;
  readonly maxConcurrentTotal: number;
  readonly maxConcurrentPerProvider: number;
  readonly maxPromptBytes: number;
  readonly baseEnv?: Readonly<Record<string, string>>;
  readonly gracefulTimeoutMs?: number;
}

interface ActiveEntry {
  readonly provider: Provider;
  readonly running: RunningProcess;
}

export interface StartRequest {
  readonly provider: Provider;
  readonly model?: string;
  readonly cwd: string;
  readonly prompt: string;
}

export interface ContinueRequest {
  readonly taskId: string;
  readonly message: string;
}

/**
 * The single owner of coding-agent subprocess lifecycle. Every task this process starts is
 * tracked in memory for the life of that process; nothing here survives a bridge restart, which
 * is why TaskStore.reconcileAfterRestart() marks orphaned active tasks interrupted at startup.
 */
export class JobSupervisor {
  private readonly active = new Map<string, ActiveEntry>();
  private readonly cancelRequested = new Set<string>();
  private readonly lastStderr = new Map<string, string>();

  constructor(private readonly options: JobSupervisorOptions) {}

  reconcileAfterRestart(): number {
    return this.options.taskStore.reconcileAfterRestart();
  }

  /** Cancels every process this instance is currently supervising. Used on graceful shutdown. */
  shutdown(): void {
    for (const [taskId, entry] of this.active) {
      this.cancelRequested.add(taskId);
      entry.running.cancel();
    }
  }

  private adapterFor(provider: Provider): ProviderAdapter {
    const adapter = this.options.adapters[provider];
    if (!adapter) throw new TaskNotFoundError(`No adapter registered for provider: ${provider}`);
    return adapter;
  }

  private assertPromptSize(prompt: string): number {
    const bytes = Buffer.byteLength(prompt, "utf8");
    if (bytes > this.options.maxPromptBytes) {
      throw new PromptTooLargeError(`Prompt exceeds ${this.options.maxPromptBytes} bytes`);
    }
    return bytes;
  }

  private assertConcurrencyAvailable(provider: Provider): void {
    if (this.active.size >= this.options.maxConcurrentTotal) {
      throw new ConcurrencyLimitError("Total concurrent task limit reached");
    }
    let perProvider = 0;
    for (const entry of this.active.values()) if (entry.provider === provider) perProvider += 1;
    if (perProvider >= this.options.maxConcurrentPerProvider) {
      throw new ConcurrencyLimitError(`Concurrent task limit reached for provider ${provider}`);
    }
  }

  async start(request: StartRequest): Promise<BridgeTask> {
    const adapter = this.adapterFor(request.provider);
    await adapter.checkAvailable();
    const promptBytes = this.assertPromptSize(request.prompt);
    const cwd = await resolveAllowedDirectory(request.cwd, this.options.policy.files);
    this.assertConcurrencyAvailable(request.provider);

    const task = this.options.taskStore.create({ provider: request.provider, cwd, promptBytes });
    this.spawnFor(task, adapter, adapter.newInvocation({
      cwd,
      prompt: request.prompt,
      ...(request.model !== undefined ? { model: request.model } : {}),
    }));
    return task;
  }

  async continue(request: ContinueRequest): Promise<BridgeTask> {
    const parent = this.options.taskStore.get(request.taskId);
    if (!parent) throw new TaskNotFoundError(request.taskId);
    if (!isTerminalState(parent.state) && parent.state !== "waiting") {
      throw new TaskNotResumableError(`Task ${parent.id} is still ${parent.state}`);
    }
    if (!parent.providerSessionId) {
      throw new TaskNotResumableError(`Task ${parent.id} has no provider session to resume`);
    }

    const adapter = this.adapterFor(parent.provider);
    await adapter.checkAvailable();
    const promptBytes = this.assertPromptSize(request.message);
    this.assertConcurrencyAvailable(parent.provider);

    const child = this.options.taskStore.create({
      provider: parent.provider,
      cwd: parent.cwd,
      promptBytes,
      parentId: parent.id,
    });
    this.spawnFor(
      child,
      adapter,
      adapter.resumeInvocation({ cwd: parent.cwd, prompt: request.message, providerSessionId: parent.providerSessionId }),
    );
    return child;
  }

  cancel(taskId: string): BridgeTask {
    const task = this.options.taskStore.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const entry = this.active.get(taskId);
    if (entry) {
      this.cancelRequested.add(taskId);
      entry.running.cancel();
      return task;
    }
    if (isTerminalState(task.state)) {
      // Already finished on its own; cancelling afterward is a no-op, whatever it finished as.
      return task;
    }
    // Queued or waiting but not supervised by this process instance: cancel it outright.
    return this.options.taskStore.transition(taskId, "cancelled");
  }

  private spawnFor(task: BridgeTask, adapter: ProviderAdapter, invocation: ProviderInvocation): void {
    const env = { ...(this.options.baseEnv ?? {}), ...invocation.env };
    const running = startProcess({
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      stdin: invocation.stdin,
      env,
      onLine: (stream, line) => this.handleLine(task.id, adapter, stream, line),
      ...(this.options.gracefulTimeoutMs !== undefined
        ? { gracefulTimeoutMs: this.options.gracefulTimeoutMs }
        : {}),
    });

    this.active.set(task.id, { provider: task.provider, running });
    this.options.taskStore.transition(task.id, "running");

    void running.exited.then((exit) => this.handleExit(task.id, exit));
  }

  private handleLine(taskId: string, adapter: ProviderAdapter, stream: "stdout" | "stderr", line: string): void {
    if (stream === "stderr" && line.trim().length > 0) this.lastStderr.set(taskId, line.trim());

    let events;
    try {
      events = adapter.parseLine(stream, line);
    } catch {
      events = [{ type: "diagnostic", stream, note: "unparseable-line" }];
    }

    for (const event of events) {
      this.options.eventLog.append(taskId, event);
      const sessionId = event["session_id"];
      if (event["type"] === "session" && typeof sessionId === "string") {
        this.options.taskStore.updateProviderSessionId(taskId, sessionId);
      }
    }
  }

  private handleExit(taskId: string, exit: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.active.delete(taskId);
    const wasCancelled = this.cancelRequested.delete(taskId);
    const errorSummary = this.lastStderr.get(taskId) ?? null;
    this.lastStderr.delete(taskId);

    if (wasCancelled) {
      this.options.taskStore.transition(taskId, "cancelled", { exitCode: exit.code });
      return;
    }
    if (exit.code === 0) {
      this.options.taskStore.transition(taskId, "succeeded", { exitCode: exit.code });
      return;
    }
    this.options.taskStore.transition(taskId, "failed", { exitCode: exit.code, errorSummary });
  }
}
