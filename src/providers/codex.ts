import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProviderUnavailableError } from "../errors.js";
import type { ContinueInput, ProviderAdapter, ProviderEvent, ProviderInvocation, StartInput } from "./provider.js";
import { notFoundHint } from "./runtime.js";

const execFileAsync = promisify(execFile);

export interface CodexAdapterOptions {
  /** Path or name of the Codex CLI binary. Defaults to "codex" (resolved via PATH). */
  readonly command?: string;
  readonly probeTimeoutMs?: number;
}

function extractErrorMessage(event: Readonly<Record<string, unknown>>): string {
  if (typeof event["message"] === "string") return event["message"];
  const nested = event["error"];
  if (nested && typeof nested === "object") {
    const message = (nested as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  return "Unknown Codex error";
}

/**
 * Adapter for the Codex CLI's `exec --json` event stream. Verified against the installed
 * binary (`codex --version` / `codex exec --help` / `codex exec resume --help`): the JSONL
 * stream uses dot-separated event names (`thread.started`, `turn.started`, `item.completed`,
 * `turn.completed`, `turn.failed`) with the session id carried as `thread_id`. This is a
 * different vocabulary from the underlying `~/.codex/sessions/*.jsonl` rollout format, which
 * uses underscore-separated names and is not what this adapter parses.
 */
export class CodexAdapter implements ProviderAdapter {
  readonly name = "codex" as const;
  private readonly command: string;
  private readonly probeTimeoutMs: number;

  constructor(options: CodexAdapterOptions = {}) {
    this.command = options.command ?? "codex";
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5000;
  }

  async checkAvailable(): Promise<void> {
    try {
      await execFileAsync(this.command, ["--version"], { timeout: this.probeTimeoutMs });
    } catch (error) {
      const hint = (error as NodeJS.ErrnoException).code === "ENOENT" ? ` ${notFoundHint("codex")}` : "";
      throw new ProviderUnavailableError(`Codex CLI is not available: ${(error as Error).message}.${hint}`);
    }
  }

  newInvocation(input: StartInput): ProviderInvocation {
    return {
      command: this.command,
      args: ["exec", "--json", "--sandbox", "workspace-write", ...(input.model ? ["--model", input.model] : []), "-C", input.cwd, "-"],
      cwd: input.cwd,
      stdin: input.prompt,
      env: {},
    };
  }

  resumeInvocation(input: ContinueInput): ProviderInvocation {
    return {
      command: this.command,
      args: ["exec", "resume", input.providerSessionId, "--json", "-"],
      cwd: input.cwd,
      stdin: input.prompt,
      env: {},
    };
  }

  parseLine(stream: "stdout" | "stderr", line: string): readonly ProviderEvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];
    if (stream === "stderr") return [{ type: "unknown", stream: "stderr", text: trimmed }];

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [{ type: "unknown", text: trimmed }];
    }
    if (typeof parsed !== "object" || parsed === null) return [{ type: "unknown", text: trimmed }];
    const event = parsed as Record<string, unknown>;

    switch (event["type"]) {
      case "thread.started": {
        const threadId = event["thread_id"];
        return typeof threadId === "string"
          ? [{ type: "session", session_id: threadId }]
          : [{ type: "unknown", raw: event }];
      }
      case "turn.started":
        return [{ type: "progress", note: "turn-started" }];
      case "item.completed":
        return [{ type: "progress", item: event["item"] ?? null }];
      case "turn.completed":
        return [{ type: "final", usage: event["usage"] ?? null }];
      case "turn.failed":
      case "error":
        return [{ type: "error", message: extractErrorMessage(event) }];
      default:
        return [{ type: "unknown", raw: event }];
    }
  }
}
