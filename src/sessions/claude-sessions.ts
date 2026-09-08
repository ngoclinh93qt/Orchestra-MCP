import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { redactJsonValue } from "../security/redact.js";
import type { SessionPage, SessionSummary } from "./types.js";

const CWD_SCAN_LIMIT = 20;

async function findCwd(lines: readonly string[]): Promise<string | null> {
  for (const line of lines.slice(0, CWD_SCAN_LIMIT)) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.cwd === "string") return parsed.cwd;
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
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.type === "string") return parsed.type;
    } catch {
      continue;
    }
  }
  return null;
}

async function findSessionFile(baseDir: string, sessionId: string): Promise<string | null> {
  const projectDirs = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const candidate = join(baseDir, dirent.name, `${sessionId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function listClaudeSessions(baseDir: string): Promise<SessionSummary[]> {
  const projectDirs = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const summaries: SessionSummary[] = [];

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const projectPath = join(baseDir, projectDir.name);
    const files = await readdir(projectPath, { withFileTypes: true }).catch(() => []);

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const fullPath = join(projectPath, file.name);
      const [content, info] = await Promise.all([readFile(fullPath, "utf8"), stat(fullPath)]);
      const lines = content.split("\n");
      const cwd = await findCwd(lines);
      if (cwd === null) continue;

      summaries.push({
        provider: "claude",
        sessionId: file.name.slice(0, -".jsonl".length),
        cwd,
        lastModifiedAt: info.mtime.toISOString(),
        lastEventHint: lastEventHint(lines),
      });
    }
  }

  return summaries;
}

export async function readClaudeSession(
  baseDir: string,
  sessionId: string,
  options: { cursor?: number; limit?: number },
): Promise<SessionPage> {
  const filePath = await findSessionFile(baseDir, sessionId);
  if (filePath === null) return { events: [], nextCursor: options.cursor ?? 0 };

  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n").filter((line) => line.length > 0);
  const cursor = options.cursor ?? 0;
  const limit = options.limit ?? 100;
  const page = lines.slice(cursor, cursor + limit).map((line) => redactJsonValue(JSON.parse(line)) as Record<string, unknown>);
  return { events: page, nextCursor: cursor + page.length };
}
