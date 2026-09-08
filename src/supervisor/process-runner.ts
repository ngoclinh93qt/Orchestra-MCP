import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ProcessRunnerOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly onLine: (stream: "stdout" | "stderr", line: string) => void;
  /** Delay between SIGTERM and SIGKILL when cancelling. Defaults to 5000ms per spec. */
  readonly gracefulTimeoutMs?: number;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RunningProcess {
  readonly pid: number;
  readonly exited: Promise<ProcessExit>;
  /** Sends SIGTERM to the exact process group, escalating to SIGKILL after the grace period. */
  cancel(): void;
}

/**
 * Spawns exactly one child process with no shell, as its own detached process group, so
 * cancellation can terminate the whole group without ever targeting an unrelated process.
 */
export function startProcess(options: ProcessRunnerOptions): RunningProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: true,
  });

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("Failed to spawn provider process");
  }

  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => options.onLine("stdout", line));
  }
  if (child.stderr) {
    createInterface({ input: child.stderr }).on("line", (line) => options.onLine("stderr", line));
  }

  child.stdin?.end(options.stdin);

  const exited = new Promise<ProcessExit>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  function signalGroup(target: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-target, signal);
    } catch {
      // Process group already gone; nothing left to signal.
    }
  }

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  function cancel(): void {
    if (killTimer) return; // already cancelling
    // Verified defined above; TS does not carry that narrowing into these closures.
    signalGroup(pid as number, "SIGTERM");
    killTimer = setTimeout(() => signalGroup(pid as number, "SIGKILL"), options.gracefulTimeoutMs ?? 5000);
    void exited.then(() => clearTimeout(killTimer));
  }

  return { pid, exited, cancel };
}
