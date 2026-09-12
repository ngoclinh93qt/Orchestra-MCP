import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProviderUnavailableError } from "../errors.js";
import type { ContinueInput, ProviderAdapter, ProviderEvent, ProviderInvocation, StartInput } from "./provider.js";
import { notFoundHint } from "./runtime.js";

const execFileAsync = promisify(execFile);

export interface ClaudeAdapterOptions {
  /** Path or name of the Claude Code CLI binary. Defaults to "claude" (resolved via PATH). */
  readonly command?: string;
  readonly probeTimeoutMs?: number;
}

function extractAssistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
    .filter((block) => block["type"] === "text" && typeof block["text"] === "string")
    .map((block) => block["text"] as string);
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Adapter for the Claude Code CLI's `-p --output-format stream-json` event stream, verified
 * against the installed binary. Two corrections versus the naive flag list: `--output-format
 * stream-json` with `-p` is rejected unless `--verbose` is also present, and the prompt is a
 * direct trailing argument rather than stdin. Events use `type: "system"|"assistant"|"user"|
 * "result"`, with the session id present on every event as `session_id`.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude" as const;
  private readonly command: string;
  private readonly probeTimeoutMs: number;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.command = options.command ?? "claude";
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5000;
  }

  async checkAvailable(): Promise<void> {
    try {
      await execFileAsync(this.command, ["--version"], { timeout: this.probeTimeoutMs });
    } catch (error) {
      const hint = (error as NodeJS.ErrnoException).code === "ENOENT" ? ` ${notFoundHint("claude")}` : "";
      throw new ProviderUnavailableError(`Claude Code CLI is not available: ${(error as Error).message}.${hint}`);
    }
  }

  newInvocation(input: StartInput): ProviderInvocation {
    return {
      command: this.command,
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "acceptEdits",
        "--permission-prompts",
        "none",
        "--verbose",
        input.prompt,
      ],
      cwd: input.cwd,
      stdin: "",
      env: {},
    };
  }

  resumeInvocation(input: ContinueInput): ProviderInvocation {
    return {
      command: this.command,
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "acceptEdits",
        "--permission-prompts",
        "none",
        "--verbose",
        "--resume",
        input.providerSessionId,
        input.prompt,
      ],
      cwd: input.cwd,
      stdin: "",
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
    const sessionId = event["session_id"];

    switch (event["type"]) {
      case "system": {
        if (event["subtype"] === "init" && typeof sessionId === "string") {
          return [{ type: "session", session_id: sessionId }];
        }
        return [{ type: "unknown", raw: event }];
      }
      case "assistant":
      case "user": {
        const text = extractAssistantText(event["message"]);
        return [{ type: "progress", text: text ?? "" }];
      }
      case "result": {
        const isError = event["is_error"] === true;
        const resultText = typeof event["result"] === "string" ? event["result"] : "";
        return isError ? [{ type: "error", message: resultText }] : [{ type: "final", text: resultText }];
      }
      default:
        return [{ type: "unknown", raw: event }];
    }
  }
}
