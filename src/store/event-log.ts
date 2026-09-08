import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ProviderEvent = Readonly<Record<string, unknown>>;

export interface OutputPage {
  readonly events: readonly ProviderEvent[];
  readonly nextCursor: number;
}

export interface EventLogOptions {
  /** Maximum events retained per task log; oldest events are dropped once exceeded. */
  readonly maxEventsPerTask?: number;
}

const REDACTED_KEYS = new Set(["token", "authorization", "api_key", "cookie"]);
const REDACTED = "[REDACTED]";

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redact(inner);
    }
    return out;
  }
  return value;
}

/**
 * Append-only, owner-only JSON Lines event log per task. Bounded by a maximum event count
 * so large output cannot grow storage unboundedly; oldest events are dropped on rotation.
 */
export class EventLog {
  private readonly logsDir: string;
  private readonly maxEventsPerTask: number;

  constructor(logsDir: string, options: EventLogOptions = {}) {
    this.logsDir = logsDir;
    this.maxEventsPerTask = options.maxEventsPerTask ?? 5000;
    mkdirSync(this.logsDir, { recursive: true, mode: 0o700 });
  }

  private pathFor(taskId: string): string {
    return join(this.logsDir, `${taskId}.jsonl`);
  }

  private readLines(taskId: string): string[] {
    const path = this.pathFor(taskId);
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf8");
    return content.length === 0 ? [] : content.split("\n").filter((line) => line.length > 0);
  }

  append(taskId: string, event: ProviderEvent): void {
    const path = this.pathFor(taskId);
    const sanitized = redact(event);
    const isNew = !existsSync(path);
    appendFileSync(path, `${JSON.stringify(sanitized)}\n`, { mode: 0o600 });
    if (isNew) chmodSync(path, 0o600);

    const lines = this.readLines(taskId);
    if (lines.length > this.maxEventsPerTask) {
      const trimmed = lines.slice(lines.length - this.maxEventsPerTask);
      const tmpPath = `${path}.tmp`;
      writeFileSync(tmpPath, `${trimmed.join("\n")}\n`, { mode: 0o600 });
      renameSync(tmpPath, path);
    }
  }

  read(taskId: string, options: { cursor: number; limit: number }): OutputPage {
    const lines = this.readLines(taskId);
    const start = Math.max(0, options.cursor);
    const slice = lines.slice(start, start + options.limit);
    const events = slice.map((line) => JSON.parse(line) as ProviderEvent);
    return { events, nextCursor: start + events.length };
  }
}
