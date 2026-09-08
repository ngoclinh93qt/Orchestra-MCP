import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { redactJsonValue, redactTextLine } from "../security/redact.js";
import type { SessionPage, SessionSummary } from "./types.js";

async function findRolloutFiles(baseDir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }
  await walk(baseDir);
  return results;
}

function sessionIdFor(filePath: string): string {
  const base = filePath.split("/").pop()!;
  return base.slice(0, -".jsonl".length);
}

function findCwd(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; payload?: { cwd?: unknown } };
      if (parsed.type === "turn_context" && typeof parsed.payload?.cwd === "string") {
        return parsed.payload.cwd;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function lastEventHint(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; payload?: { type?: unknown } };
      if (parsed.type === "event_msg" && typeof parsed.payload?.type === "string") return parsed.payload.type;
      if (typeof parsed.type === "string") return parsed.type;
    } catch {
      continue;
    }
  }
  return null;
}

export async function listCodexSessions(baseDir: string): Promise<SessionSummary[]> {
  const files = await findRolloutFiles(baseDir);
  const summaries: SessionSummary[] = [];

  for (const filePath of files) {
    const [content, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    const lines = content.split("\n");
    const cwd = findCwd(lines);
    if (cwd === null) continue;

    summaries.push({
      provider: "codex",
      sessionId: sessionIdFor(filePath),
      cwd,
      lastModifiedAt: info.mtime.toISOString(),
      lastEventHint: lastEventHint(lines),
    });
  }

  return summaries;
}

export async function readCodexSession(
  baseDir: string,
  sessionId: string,
  options: { cursor?: number; limit?: number },
): Promise<SessionPage> {
  const files = await findRolloutFiles(baseDir);
  const filePath = files.find((f) => sessionIdFor(f) === sessionId) ?? null;
  if (filePath === null) return { events: [], nextCursor: options.cursor ?? 0 };

  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n").filter((line) => line.length > 0);
  const cursor = options.cursor ?? 0;
  const limit = options.limit ?? 100;
  const page = lines.slice(cursor, cursor + limit).map((line) => {
    try {
      return redactJsonValue(JSON.parse(line)) as Record<string, unknown>;
    } catch {
      return { type: "unparsed", raw: redactTextLine(line).slice(0, 200) } as Record<string, unknown>;
    }
  });
  return { events: page, nextCursor: cursor + page.length };
}
