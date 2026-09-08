# Repo and Session Read Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five read-only MCP tools (`repo_list`, `repo_read`, `repo_search`, `session_list`, `session_read`) so ChatGPT can read the repository and prior Claude Code/Codex terminal-session history on its own, without spinning up a task just to look at something.

**Architecture:** Two new independent read-only subsystems — a repo reader confined to the existing allowlisted roots, and a session store that discovers Claude Code's and Codex's own on-disk session files and filters them to sessions whose recorded `cwd` falls inside an allowlisted root — both built on a shared redaction utility extracted from the existing event log, then wired into the existing MCP tool registry alongside the six tools already there.

**Tech Stack:** Same as the rest of the project: TypeScript/Node 20+ (this machine's node_modules are built for Node 26 — see `.nvmrc`), Vitest, Zod, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-repo-and-session-read-tools-design.md`

## Global Constraints

- All five tools are `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, scoped to `agent:read` — no new write tool, no new scope.
- `repo_list`/`repo_read`/`repo_search` only ever resolve paths inside the existing `AGENT_BRIDGE_ALLOWED_ROOTS` — reuse `resolveAllowedDirectory` from `src/config.ts` for directories; never invent a second allowlist.
- Fixed ignore list for repo tools: `.git`, `.env`, `.env.*`, `node_modules`, `dist`, `build`, `.next`, `__pycache__`, `.venv`, `target`, `.DS_Store`. Not configurable per request.
- `repo_read` refuses `.env`/`.env.*` outright and refuses binary files.
- `repo_search` is a pure Node directory walk — no `ripgrep` or other external process.
- `session_list`/`session_read` only return sessions whose own recorded `cwd` resolves inside an allowlisted root. A session whose cwd cannot be determined is excluded.
- Secret-looking content is redacted the same way in both new subsystems as it already is in task event logs — via one shared utility, not two divergent implementations.
- `lastModifiedAt`/`lastEventHint` on session results are documented as heuristics, never presented as authoritative state.

---

### Task 1: Shared redaction utility, ignore list, and file-path safety

**Files:**
- Create: `src/security/redact.ts`
- Modify: `src/store/event-log.ts`
- Create: `src/repo/ignore-list.ts`, `src/repo/path-safety.ts`
- Test: `test/security/redact.test.ts`, `test/repo/path-safety.test.ts`

**Interfaces:**
- Consumes: `PathNotAllowedError` from `src/errors.ts`; `resolveAllowedDirectory` from `src/config.ts` (not called here, but this task's `isWithinAllowedRoots` mirrors its containment logic for later tasks to compose with it)
- Produces: `redactJsonValue(value: unknown): unknown`, `redactTextLine(line: string): string`, `REDACTED` (from `src/security/redact.ts`); `isIgnoredName(name: string): boolean`, `isEnvFileName(name: string): boolean` (from `src/repo/ignore-list.ts`); `resolveAllowedFile(requested: string, allowedRoots: readonly string[]): Promise<string>`, `isWithinAllowedRoots(candidatePath: string, allowedRoots: readonly string[]): Promise<boolean>` (from `src/repo/path-safety.ts`)

- [ ] **Step 1: Write failing tests for the extracted redaction utility**

```ts
// test/security/redact.test.ts
import { describe, expect, it } from "vitest";
import { redactJsonValue, redactTextLine } from "../../src/security/redact.js";

describe("redactJsonValue", () => {
  it("redacts known secret keys at any depth", () => {
    expect(redactJsonValue({ token: "abc", nested: { Authorization: "Bearer x" } })).toEqual({
      token: "[REDACTED]",
      nested: { Authorization: "[REDACTED]" },
    });
  });

  it("leaves non-secret keys untouched", () => {
    expect(redactJsonValue({ type: "final", text: "safe" })).toEqual({ type: "final", text: "safe" });
  });
});

describe("redactTextLine", () => {
  it("redacts an assignment-shaped secret in source text", () => {
    expect(redactTextLine('const apiKey = "sk-live-abc123";')).toBe('const apiKey = "[REDACTED]";');
    expect(redactTextLine("AUTH_TOKEN: 'xyz789'")).toBe("AUTH_TOKEN: '[REDACTED]'");
  });

  it("leaves ordinary code untouched", () => {
    expect(redactTextLine("const total = price * quantity;")).toBe("const total = price * quantity;");
  });
});
```

- [ ] **Step 2: Confirm red**

Run: `npm test -- test/security/redact.test.ts`
Expected: FAIL — `src/security/redact.ts` does not exist yet.

- [ ] **Step 3: Implement the shared redaction utility**

```ts
// src/security/redact.ts
const REDACTED_KEYS = new Set(["token", "authorization", "api_key", "cookie"]);
export const REDACTED = "[REDACTED]";

/** Recursively redacts known secret-named keys in a JSON-shaped value. Case-insensitive on keys. */
export function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redactJsonValue(inner);
    }
    return out;
  }
  return value;
}

const SECRET_LINE_PATTERN =
  /\b([\w.-]*(?:token|secret|password|api[_-]?key|authorization|cookie)[\w.-]*)(\s*[:=]\s*)(['"]?)([^'"\s]+)(['"]?)/gi;

/** Best-effort redaction of an assignment-shaped secret in one line of arbitrary text. */
export function redactTextLine(line: string): string {
  return line.replace(SECRET_LINE_PATTERN, (_match, key, sep, openQuote, _value, closeQuote) => {
    return `${key}${sep}${openQuote}${REDACTED}${closeQuote}`;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/security/redact.test.ts`
Expected: PASS

- [ ] **Step 5: Point event-log.ts at the shared utility instead of its own copy**

In `src/store/event-log.ts`, delete the local `REDACTED_KEYS`, `REDACTED`, and `redact` definitions, add `import { redactJsonValue } from "../security/redact.js";` near the top, and change the one call site from `redact(event)` to `redactJsonValue(event)`.

Run: `npm test -- test/event-log.test.ts`
Expected: PASS, unchanged behavior (this is a pure extraction, not a behavior change).

- [ ] **Step 6: Write failing tests for the ignore list and file path safety**

```ts
// test/repo/path-safety.test.ts
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isEnvFileName, isIgnoredName } from "../../src/repo/ignore-list.js";
import { isWithinAllowedRoots, resolveAllowedFile } from "../../src/repo/path-safety.js";
import { PathNotAllowedError } from "../../src/errors.js";

describe("ignore-list", () => {
  it("recognizes fixed ignored names", () => {
    expect(isIgnoredName("node_modules")).toBe(true);
    expect(isIgnoredName(".git")).toBe(true);
    expect(isIgnoredName("src")).toBe(false);
  });

  it("recognizes env files by prefix", () => {
    expect(isEnvFileName(".env")).toBe(true);
    expect(isEnvFileName(".env.production")).toBe(true);
    expect(isEnvFileName("environment.ts")).toBe(false);
  });
});

describe("resolveAllowedFile", () => {
  it("returns the canonical path for a file inside an allowed root", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    await mkdir(root, { recursive: true });
    const file = join(root, "index.ts");
    await writeFile(file, "export {}");
    await expect(resolveAllowedFile(file, [root])).resolves.toBe(file);
  });

  it("rejects a file outside every allowed root", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    const outside = join(base, "outside.ts");
    await mkdir(root, { recursive: true });
    await writeFile(outside, "export {}");
    await expect(resolveAllowedFile(outside, [root])).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("rejects a symlink escape", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    const outside = join(base, "outside.ts");
    await mkdir(root, { recursive: true });
    await writeFile(outside, "export {}");
    const link = join(root, "escape.ts");
    await symlink(outside, link);
    await expect(resolveAllowedFile(link, [root])).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("refuses an .env file even when it is inside an allowed root", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    await mkdir(root, { recursive: true });
    const envFile = join(root, ".env");
    await writeFile(envFile, "SECRET=1");
    await expect(resolveAllowedFile(envFile, [root])).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("rejects a directory passed where a file is expected", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    const dir = join(root, "subdir");
    await mkdir(dir, { recursive: true });
    await expect(resolveAllowedFile(dir, [root])).rejects.toBeInstanceOf(PathNotAllowedError);
  });
});

describe("isWithinAllowedRoots", () => {
  it("returns true for a path inside a root and false outside it", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    const inside = join(root, "project");
    const outside = join(base, "elsewhere");
    await mkdir(inside, { recursive: true });
    await mkdir(outside, { recursive: true });
    await expect(isWithinAllowedRoots(inside, [root])).resolves.toBe(true);
    await expect(isWithinAllowedRoots(outside, [root])).resolves.toBe(false);
  });

  it("returns false for a path that does not exist", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    await expect(isWithinAllowedRoots(join(base, "does-not-exist"), [base])).resolves.toBe(false);
  });
});
```

- [ ] **Step 7: Confirm red**

Run: `npm test -- test/repo/path-safety.test.ts`
Expected: FAIL — `src/repo/ignore-list.ts` and `src/repo/path-safety.ts` do not exist yet.

- [ ] **Step 8: Implement the ignore list**

```ts
// src/repo/ignore-list.ts
const IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "target",
  ".DS_Store",
]);

export function isEnvFileName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

/** True if this basename should never appear in a listing or search result. */
export function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name) || isEnvFileName(name);
}
```

- [ ] **Step 9: Implement file-path safety**

```ts
// src/repo/path-safety.ts
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import { PathNotAllowedError } from "../errors.js";
import { isEnvFileName } from "./ignore-list.js";

/** Non-throwing containment check: does this existing path resolve inside any allowed root? */
export async function isWithinAllowedRoots(candidatePath: string, allowedRoots: readonly string[]): Promise<boolean> {
  let canonical: string;
  try {
    canonical = await realpath(candidatePath);
  } catch {
    return false;
  }
  for (const root of allowedRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
    } catch {
      continue;
    }
    const rel = relative(canonicalRoot, canonical);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

/**
 * Resolves a requested file path for `repo_read`: must be absolute, must not be an env file
 * (checked both as requested and after symlink resolution), must exist as a regular file, and
 * must resolve inside one of the allowed roots after symlink resolution.
 */
export async function resolveAllowedFile(requested: string, allowedRoots: readonly string[]): Promise<string> {
  if (!isAbsolute(requested)) throw new PathNotAllowedError("File path must be absolute");
  if (isEnvFileName(basename(requested))) throw new PathNotAllowedError("Refusing to read an env file");

  const canonical = await realpath(requested);
  if (isEnvFileName(basename(canonical))) throw new PathNotAllowedError("Refusing to read an env file");

  const info = await stat(canonical);
  if (!info.isFile()) throw new PathNotAllowedError("Path is not a file");

  if (!(await isWithinAllowedRoots(canonical, allowedRoots))) {
    throw new PathNotAllowedError("File is outside allowed roots");
  }
  return canonical;
}
```

- [ ] **Step 10: Run tests to verify they pass, then commit**

Run: `npm test -- test/security/redact.test.ts test/repo/path-safety.test.ts test/event-log.test.ts && npm run typecheck`

```bash
git add src/security/redact.ts src/store/event-log.ts src/repo/ignore-list.ts src/repo/path-safety.ts test/security/redact.test.ts test/repo/path-safety.test.ts
git commit -m "feat: extract shared redaction and add file-path safety for repo tools"
```

---

### Task 2: Repo reader (list, read, search)

**Files:**
- Create: `src/errors.ts` (modify — add one error class), `src/repo/repo-reader.ts`
- Test: `test/repo/repo-reader.test.ts`

**Interfaces:**
- Consumes: `resolveAllowedDirectory` from `src/config.ts`; `resolveAllowedFile`, `isWithinAllowedRoots` from `src/repo/path-safety.js` (Task 1); `isIgnoredName` from `src/repo/ignore-list.js` (Task 1); `redactTextLine` from `src/security/redact.js` (Task 1); `PathNotAllowedError` from `src/errors.js`
- Produces: `BinaryFileError` (added to `src/errors.ts`); `listDirectory`, `readFileLines`, `searchRepo` and their result types (from `src/repo/repo-reader.ts`), consumed by Task 6

- [ ] **Step 1: Add the one new error class**

In `src/errors.ts`, add:

```ts
export class BinaryFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryFileError";
  }
}
```

- [ ] **Step 2: Write failing tests for listDirectory and readFileLines**

```ts
// test/repo/repo-reader.test.ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BinaryFileError, PathNotAllowedError } from "../../src/errors.js";
import { listDirectory, readFileLines, searchRepo } from "../../src/repo/repo-reader.js";

async function buildFixtureRepo(): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "repo-reader-"));
  const root = join(base, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "README.md"), "# demo\n");
  await writeFile(join(root, ".env"), "SECRET=1\n");
  await writeFile(join(root, "src", "index.ts"), "export const total = price * quantity;\nconst apiKey = \"sk-live-abc\";\n");
  await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = {};\n");
  return { base, root };
}

describe("listDirectory", () => {
  it("lists top-level entries and hides ignored names", async () => {
    const { root } = await buildFixtureRepo();
    const result = await listDirectory(root, [root], {});
    const names = result.entries.map((e) => e.path).sort();
    expect(names).toEqual(["README.md", "src"]);
  });

  it("rejects a path outside the allowed roots", async () => {
    const { base, root } = await buildFixtureRepo();
    await expect(listDirectory(base, [root], {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });
});

describe("readFileLines", () => {
  it("returns the requested line range with pagination", async () => {
    const { root } = await buildFixtureRepo();
    const file = join(root, "src", "index.ts");
    const first = await readFileLines(file, [root], { cursor: 0, limit: 1 });
    expect(first.lines).toEqual(["export const total = price * quantity;"]);
    expect(first.nextCursor).toBe(1);
    expect(first.totalLines).toBe(2);
  });

  it("redacts a secret-looking assignment", async () => {
    const { root } = await buildFixtureRepo();
    const file = join(root, "src", "index.ts");
    const page = await readFileLines(file, [root], { cursor: 1, limit: 1 });
    expect(page.lines[0]).toBe('const apiKey = "[REDACTED]";');
  });

  it("refuses to read an .env file", async () => {
    const { root } = await buildFixtureRepo();
    await expect(readFileLines(join(root, ".env"), [root], {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("refuses to read a binary file", async () => {
    const { root } = await buildFixtureRepo();
    const binaryPath = join(root, "src", "image.bin");
    await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    await expect(readFileLines(binaryPath, [root], {})).rejects.toBeInstanceOf(BinaryFileError);
  });
});
```

- [ ] **Step 3: Confirm red**

Run: `npm test -- test/repo/repo-reader.test.ts`
Expected: FAIL — `src/repo/repo-reader.ts` does not exist yet.

- [ ] **Step 4: Implement listDirectory and readFileLines**

```ts
// src/repo/repo-reader.ts
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { BinaryFileError } from "../errors.js";
import { resolveAllowedDirectory } from "../config.js";
import { isIgnoredName } from "./ignore-list.js";
import { resolveAllowedFile } from "./path-safety.js";
import { redactTextLine } from "../security/redact.js";

export interface DirectoryEntry {
  readonly path: string;
  readonly type: "file" | "directory";
}

export interface ListDirectoryResult {
  readonly entries: readonly DirectoryEntry[];
  readonly nextCursor: number;
}

export interface ListDirectoryOptions {
  readonly depth?: number;
  readonly cursor?: number;
  readonly limit?: number;
}

async function walk(root: string, current: string, depth: number, out: DirectoryEntry[]): Promise<void> {
  const dirents = await readdir(current, { withFileTypes: true });
  for (const dirent of dirents) {
    if (isIgnoredName(dirent.name)) continue;
    const fullPath = join(current, dirent.name);
    const relPath = relative(root, fullPath);
    if (dirent.isDirectory()) {
      out.push({ path: relPath, type: "directory" });
      if (depth > 1) await walk(root, fullPath, depth - 1, out);
    } else if (dirent.isFile()) {
      out.push({ path: relPath, type: "file" });
    }
  }
}

export async function listDirectory(
  path: string,
  allowedRoots: readonly string[],
  options: ListDirectoryOptions,
): Promise<ListDirectoryResult> {
  const canonical = await resolveAllowedDirectory(path, allowedRoots);
  const all: DirectoryEntry[] = [];
  await walk(canonical, canonical, options.depth ?? 1, all);
  all.sort((a, b) => a.path.localeCompare(b.path));

  const cursor = options.cursor ?? 0;
  const limit = options.limit ?? 200;
  const page = all.slice(cursor, cursor + limit);
  return { entries: page, nextCursor: cursor + page.length };
}

export interface ReadFileResult {
  readonly lines: readonly string[];
  readonly nextCursor: number;
  readonly totalLines: number;
}

export interface ReadFileOptions {
  readonly cursor?: number;
  readonly limit?: number;
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

export async function readFileLines(
  path: string,
  allowedRoots: readonly string[],
  options: ReadFileOptions,
): Promise<ReadFileResult> {
  const canonical = await resolveAllowedFile(path, allowedRoots);
  const buffer = await readFile(canonical);
  if (looksBinary(buffer)) throw new BinaryFileError(`Refusing to read binary file: ${path}`);

  const allLines = buffer.toString("utf8").split("\n");
  const cursor = options.cursor ?? 0;
  const limit = options.limit ?? 500;
  const page = allLines.slice(cursor, cursor + limit).map(redactTextLine);
  return { lines: page, nextCursor: cursor + page.length, totalLines: allLines.length };
}
```

- [ ] **Step 5: Run tests to verify listDirectory/readFileLines pass**

Run: `npm test -- test/repo/repo-reader.test.ts`
Expected: PASS for `listDirectory` and `readFileLines` tests (search tests below still fail — added next).

- [ ] **Step 6: Write failing tests for searchRepo**

Append to `test/repo/repo-reader.test.ts`:

```ts
describe("searchRepo", () => {
  it("finds a literal match and redacts it", async () => {
    const { root } = await buildFixtureRepo();
    const result = await searchRepo(root, [root], "apiKey", {});
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toEqual({ file: "src/index.ts", line: 2, text: 'const apiKey = "[REDACTED]";' });
    expect(result.truncated).toBe(false);
  });

  it("supports a regex query", async () => {
    const { root } = await buildFixtureRepo();
    const result = await searchRepo(root, [root], "total\\s*=", { regex: true });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.file).toBe("src/index.ts");
  });

  it("never searches inside ignored directories", async () => {
    const { root } = await buildFixtureRepo();
    const result = await searchRepo(root, [root], "module.exports", {});
    expect(result.matches).toHaveLength(0);
  });

  it("caps results at the given limit and reports truncation", async () => {
    const { root } = await buildFixtureRepo();
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(root, `extra-${i}.txt`), "needle here\n");
    }
    const result = await searchRepo(root, [root], "needle", { limit: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects an invalid regex", async () => {
    const { root } = await buildFixtureRepo();
    await expect(searchRepo(root, [root], "(", { regex: true })).rejects.toThrow();
  });
});
```

- [ ] **Step 7: Confirm red**

Run: `npm test -- test/repo/repo-reader.test.ts`
Expected: FAIL — `searchRepo` is not exported yet.

- [ ] **Step 8: Implement searchRepo**

Append to `src/repo/repo-reader.ts`:

```ts
export interface SearchMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchOptions {
  readonly regex?: boolean;
  readonly limit?: number;
}

export interface SearchResult {
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
}

const MAX_MATCH_TEXT_LENGTH = 300;

export async function searchRepo(
  path: string,
  allowedRoots: readonly string[],
  query: string,
  options: SearchOptions,
): Promise<SearchResult> {
  const canonical = await resolveAllowedDirectory(path, allowedRoots);
  const pattern = options.regex ? new RegExp(query) : null;
  const limit = options.limit ?? 50;

  const files: DirectoryEntry[] = [];
  await walk(canonical, canonical, Number.POSITIVE_INFINITY, files);

  const matches: SearchMatch[] = [];
  let truncated = false;

  for (const entry of files) {
    if (entry.type !== "file") continue;
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    const fullPath = join(canonical, entry.path);
    let buffer: Buffer;
    try {
      buffer = await readFile(fullPath);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;

    const lines = buffer.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const isMatch = pattern ? pattern.test(line) : line.includes(query);
      if (!isMatch) continue;
      matches.push({
        file: entry.path,
        line: i + 1,
        text: redactTextLine(line.slice(0, MAX_MATCH_TEXT_LENGTH)),
      });
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
  }

  return { matches, truncated };
}
```

- [ ] **Step 9: Run tests to verify they pass, then commit**

Run: `npm test -- test/repo/repo-reader.test.ts && npm run typecheck`

```bash
git add src/errors.ts src/repo/repo-reader.ts test/repo/repo-reader.test.ts
git commit -m "feat: add repo list/read/search core logic"
```

---

### Task 3: Claude Code session discovery and reading

**Files:**
- Create: `src/sessions/types.ts`, `src/sessions/claude-sessions.ts`
- Test: `test/sessions/claude-sessions.test.ts`

**Interfaces:**
- Consumes: `redactJsonValue` from `src/security/redact.js` (Task 1)
- Produces: `SessionSummary`, `SessionPage` (from `src/sessions/types.ts`), consumed by Tasks 4 and 5; `listClaudeSessions(baseDir: string): Promise<SessionSummary[]>`, `readClaudeSession(baseDir: string, sessionId: string, options: {cursor?: number; limit?: number}): Promise<SessionPage>` (from `src/sessions/claude-sessions.ts`), consumed by Task 5

- [ ] **Step 1: Define the shared session types**

```ts
// src/sessions/types.ts
export type SessionProvider = "codex" | "claude";

export interface SessionSummary {
  readonly provider: SessionProvider;
  readonly sessionId: string;
  readonly cwd: string;
  readonly lastModifiedAt: string;
  /** Best-effort description of the last recorded event. Never authoritative — see spec §7. */
  readonly lastEventHint: string | null;
}

export interface SessionPage {
  readonly events: readonly Record<string, unknown>[];
  readonly nextCursor: number;
}
```

- [ ] **Step 2: Write failing tests against a fixture Claude project directory**

Claude Code stores one directory per project under `~/.claude/projects/`, named by a slug of
the project path, holding one `.jsonl` file per session. The slug is lossy, so the real `cwd`
is read from a `cwd` field recorded inside the session's own content, not the directory name.

```ts
// test/sessions/claude-sessions.test.ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listClaudeSessions, readClaudeSession } from "../../src/sessions/claude-sessions.js";

async function buildFixtureProjectsDir(): Promise<string> {
  const baseDir = await mkdtemp(join(tmpdir(), "claude-projects-"));
  const projectDir = join(baseDir, "-Users-thief-nik-demo");
  await mkdir(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "system", cwd: "/Users/thief/nik/demo", sessionId: "session-1", timestamp: "2026-09-01T00:00:00Z" }),
    JSON.stringify({ type: "user", cwd: "/Users/thief/nik/demo", sessionId: "session-1", text: "hello" }),
    JSON.stringify({ type: "assistant", cwd: "/Users/thief/nik/demo", sessionId: "session-1", token: "sk-abc" }),
  ];
  await writeFile(join(projectDir, "session-1.jsonl"), `${lines.join("\n")}\n`);

  // A session with no determinable cwd must be excluded by callers, not guessed at.
  const undetectableDir = join(baseDir, "-some-other-project");
  await mkdir(undetectableDir, { recursive: true });
  await writeFile(join(undetectableDir, "session-2.jsonl"), `${JSON.stringify({ type: "system", timestamp: "2026-09-01T00:00:00Z" })}\n`);

  return baseDir;
}

describe("listClaudeSessions", () => {
  it("discovers sessions and reads cwd from content, not the directory slug", async () => {
    const baseDir = await buildFixtureProjectsDir();
    const sessions = await listClaudeSessions(baseDir);
    const withCwd = sessions.find((s) => s.sessionId === "session-1");
    expect(withCwd?.cwd).toBe("/Users/thief/nik/demo");
    expect(withCwd?.provider).toBe("claude");
    expect(withCwd?.lastEventHint).toBe("assistant");
  });

  it("excludes a session whose cwd cannot be determined", async () => {
    const baseDir = await buildFixtureProjectsDir();
    const sessions = await listClaudeSessions(baseDir);
    expect(sessions.some((s) => s.sessionId === "session-2")).toBe(false);
  });
});

describe("readClaudeSession", () => {
  it("returns paginated, redacted session content", async () => {
    const baseDir = await buildFixtureProjectsDir();
    const page = await readClaudeSession(baseDir, "session-1", { cursor: 2, limit: 1 });
    expect(page.events).toEqual([{ type: "assistant", cwd: "/Users/thief/nik/demo", sessionId: "session-1", token: "[REDACTED]" }]);
    expect(page.nextCursor).toBe(3);
  });
});
```

- [ ] **Step 3: Confirm red**

Run: `npm test -- test/sessions/claude-sessions.test.ts`
Expected: FAIL — `src/sessions/claude-sessions.ts` does not exist yet.

- [ ] **Step 4: Implement Claude Code session discovery and reading**

```ts
// src/sessions/claude-sessions.ts
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
```

- [ ] **Step 5: Run tests to verify they pass, then commit**

Run: `npm test -- test/sessions/claude-sessions.test.ts && npm run typecheck`

```bash
git add src/sessions/types.ts src/sessions/claude-sessions.ts test/sessions/claude-sessions.test.ts
git commit -m "feat: discover and read Claude Code sessions"
```

---

### Task 4: Codex session discovery and reading

**Files:**
- Create: `src/sessions/codex-sessions.ts`
- Test: `test/sessions/codex-sessions.test.ts`

**Interfaces:**
- Consumes: `SessionSummary`, `SessionPage` from `src/sessions/types.js` (Task 3); `redactJsonValue` from `src/security/redact.js` (Task 1)
- Produces: `listCodexSessions(baseDir: string): Promise<SessionSummary[]>`, `readCodexSession(baseDir: string, sessionId: string, options: {cursor?: number; limit?: number}): Promise<SessionPage>`, consumed by Task 5

- [ ] **Step 1: Verify the real rollout record shape before writing the parser**

Codex stores rollout files at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Each line has a
top-level `type` and a nested `payload`; the `turn_context` line's payload carries `cwd`.
Confirm this against a real file on the development machine before proceeding — do not assume
the shape from this plan alone, the way earlier adapter work in this project found the design
doc's assumed shapes didn't match the real CLI:

```bash
python3 -c "
import json, glob
for path in glob.glob('$HOME/.codex/sessions/**/*.jsonl', recursive=True)[:1]:
    with open(path) as f:
        for line in f:
            d = json.loads(line)
            if d.get('type') == 'turn_context':
                print(json.dumps(d, indent=2)[:400]); break
"
```

Expected shape: `{"type": "turn_context", "payload": {"cwd": "...", ...}}`. If the real output
differs, adjust Step 4 below to match what was actually observed before implementing it.

- [ ] **Step 2: Write failing tests against a fixture rollout directory**

```ts
// test/sessions/codex-sessions.test.ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listCodexSessions, readCodexSession } from "../../src/sessions/codex-sessions.js";

async function buildFixtureSessionsDir(): Promise<string> {
  const baseDir = await mkdtemp(join(tmpdir(), "codex-sessions-"));
  const dateDir = join(baseDir, "2026", "09", "03");
  await mkdir(dateDir, { recursive: true });

  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id: "rollout-1" } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", cwd: "/Users/thief/nik/demo" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", token: "sk-abc" } }),
  ];
  await writeFile(join(dateDir, "rollout-2026-09-03T00-00-00-rollout-1.jsonl"), `${lines.join("\n")}\n`);

  // No turn_context at all: cwd cannot be determined, must be excluded.
  await writeFile(
    join(dateDir, "rollout-2026-09-03T00-01-00-rollout-2.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { id: "rollout-2" } })}\n`,
  );

  return baseDir;
}

describe("listCodexSessions", () => {
  it("discovers rollouts across date directories and extracts cwd from turn_context", async () => {
    const baseDir = await buildFixtureSessionsDir();
    const sessions = await listCodexSessions(baseDir);
    const withCwd = sessions.find((s) => s.sessionId === "rollout-2026-09-03T00-00-00-rollout-1");
    expect(withCwd?.cwd).toBe("/Users/thief/nik/demo");
    expect(withCwd?.provider).toBe("codex");
    expect(withCwd?.lastEventHint).toBe("task_complete");
  });

  it("excludes a rollout with no turn_context cwd", async () => {
    const baseDir = await buildFixtureSessionsDir();
    const sessions = await listCodexSessions(baseDir);
    expect(sessions.some((s) => s.sessionId === "rollout-2026-09-03T00-01-00-rollout-2")).toBe(false);
  });
});

describe("readCodexSession", () => {
  it("returns paginated, redacted rollout content", async () => {
    const baseDir = await buildFixtureSessionsDir();
    const page = await readCodexSession(baseDir, "rollout-2026-09-03T00-00-00-rollout-1", { cursor: 3, limit: 1 });
    expect(page.events).toEqual([{ type: "event_msg", payload: { type: "task_complete", token: "[REDACTED]" } }]);
  });
});
```

- [ ] **Step 3: Confirm red**

Run: `npm test -- test/sessions/codex-sessions.test.ts`
Expected: FAIL — `src/sessions/codex-sessions.ts` does not exist yet.

- [ ] **Step 4: Implement Codex session discovery and reading**

Adjust the `payload.cwd` / `payload.type` access paths here if Step 1's real-file check found a
different shape.

```ts
// src/sessions/codex-sessions.ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { redactJsonValue } from "../security/redact.js";
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
  return base.slice("rollout-".length, -".jsonl".length);
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
  const page = lines.slice(cursor, cursor + limit).map((line) => redactJsonValue(JSON.parse(line)) as Record<string, unknown>);
  return { events: page, nextCursor: cursor + page.length };
}
```

- [ ] **Step 5: Run tests to verify they pass, then commit**

Run: `npm test -- test/sessions/codex-sessions.test.ts && npm run typecheck`

```bash
git add src/sessions/codex-sessions.ts test/sessions/codex-sessions.test.ts
git commit -m "feat: discover and read Codex sessions"
```

---

### Task 5: Unified, allowlist-filtered session store

**Files:**
- Create: `src/sessions/session-store.ts`
- Test: `test/sessions/session-store.test.ts`

**Interfaces:**
- Consumes: `listClaudeSessions`, `readClaudeSession` from `src/sessions/claude-sessions.js` (Task 3); `listCodexSessions`, `readCodexSession` from `src/sessions/codex-sessions.js` (Task 4); `SessionSummary`, `SessionPage`, `SessionProvider` from `src/sessions/types.js` (Task 3); `isWithinAllowedRoots` from `src/repo/path-safety.js` (Task 1)
- Produces: `SessionStore` class with `list(filter): Promise<SessionSummary[]>` and `read(provider, sessionId, options): Promise<SessionPage>`, consumed by Task 6

- [ ] **Step 1: Write failing tests for allowlist filtering and provider routing**

```ts
// test/sessions/session-store.test.ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/sessions/session-store.js";

async function buildFixtures() {
  const base = await mkdtemp(join(tmpdir(), "session-store-"));
  const allowedRoot = join(base, "allowed-project");
  await mkdir(allowedRoot, { recursive: true });

  const claudeBaseDir = join(base, "claude-projects");
  const claudeProjectDir = join(claudeBaseDir, "-slug-does-not-matter");
  await mkdir(claudeProjectDir, { recursive: true });
  await writeFile(
    join(claudeProjectDir, "in-scope.jsonl"),
    `${JSON.stringify({ type: "system", cwd: allowedRoot })}\n`,
  );
  await writeFile(
    join(claudeProjectDir, "out-of-scope.jsonl"),
    `${JSON.stringify({ type: "system", cwd: join(base, "unrelated-project") })}\n`,
  );

  const codexBaseDir = join(base, "codex-sessions");
  const dateDir = join(codexBaseDir, "2026", "09", "03");
  await mkdir(dateDir, { recursive: true });
  await writeFile(
    join(dateDir, "rollout-2026-09-03T00-00-00-codex-1.jsonl"),
    `${JSON.stringify({ type: "turn_context", payload: { cwd: allowedRoot } })}\n`,
  );

  return { base, allowedRoot, claudeBaseDir, codexBaseDir };
}

describe("SessionStore.list", () => {
  it("includes sessions inside an allowed root and excludes ones outside it", async () => {
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ allowedRoots: [allowedRoot], claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    const sessions = await store.list({});
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain("in-scope");
    expect(ids).not.toContain("out-of-scope");
  });

  it("filters by provider", async () => {
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ allowedRoots: [allowedRoot], claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    const codexOnly = await store.list({ provider: "codex" });
    expect(codexOnly.every((s) => s.provider === "codex")).toBe(true);
    expect(codexOnly.length).toBeGreaterThan(0);
  });
});

describe("SessionStore.read", () => {
  it("routes to the correct provider and still enforces the allowlist", async () => {
    const { allowedRoot, claudeBaseDir, codexBaseDir } = await buildFixtures();
    const store = new SessionStore({ allowedRoots: [allowedRoot], claudeProjectsDir: claudeBaseDir, codexSessionsDir: codexBaseDir });
    const page = await store.read("claude", "in-scope", {});
    expect(page.events).toHaveLength(1);

    const outOfScope = await store.read("claude", "out-of-scope", {});
    expect(outOfScope.events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Confirm red**

Run: `npm test -- test/sessions/session-store.test.ts`
Expected: FAIL — `src/sessions/session-store.ts` does not exist yet.

- [ ] **Step 3: Implement SessionStore**

```ts
// src/sessions/session-store.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { listClaudeSessions, readClaudeSession } from "./claude-sessions.js";
import { listCodexSessions, readCodexSession } from "./codex-sessions.js";
import { isWithinAllowedRoots } from "../repo/path-safety.js";
import type { SessionPage, SessionProvider, SessionSummary } from "./types.js";

export interface SessionStoreOptions {
  readonly allowedRoots: readonly string[];
  readonly claudeProjectsDir?: string;
  readonly codexSessionsDir?: string;
}

export interface SessionListFilter {
  readonly provider?: SessionProvider;
  readonly limit?: number;
}

export interface SessionReadOptions {
  readonly cursor?: number;
  readonly limit?: number;
}

export class SessionStore {
  private readonly allowedRoots: readonly string[];
  private readonly claudeProjectsDir: string;
  private readonly codexSessionsDir: string;

  constructor(options: SessionStoreOptions) {
    this.allowedRoots = options.allowedRoots;
    this.claudeProjectsDir = options.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
    this.codexSessionsDir = options.codexSessionsDir ?? join(homedir(), ".codex", "sessions");
  }

  async list(filter: SessionListFilter): Promise<SessionSummary[]> {
    const wantClaude = filter.provider === undefined || filter.provider === "claude";
    const wantCodex = filter.provider === undefined || filter.provider === "codex";

    const [claudeSessions, codexSessions] = await Promise.all([
      wantClaude ? listClaudeSessions(this.claudeProjectsDir) : Promise.resolve([]),
      wantCodex ? listCodexSessions(this.codexSessionsDir) : Promise.resolve([]),
    ]);

    const all = [...claudeSessions, ...codexSessions];
    const inScope: SessionSummary[] = [];
    for (const session of all) {
      if (await isWithinAllowedRoots(session.cwd, this.allowedRoots)) inScope.push(session);
    }

    inScope.sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
    const limit = filter.limit ?? 100;
    return inScope.slice(0, limit);
  }

  async read(provider: SessionProvider, sessionId: string, options: SessionReadOptions): Promise<SessionPage> {
    const [claudeSessions, codexSessions] = await Promise.all([
      provider === "claude" ? listClaudeSessions(this.claudeProjectsDir) : Promise.resolve([]),
      provider === "codex" ? listCodexSessions(this.codexSessionsDir) : Promise.resolve([]),
    ]);
    const summary = [...claudeSessions, ...codexSessions].find((s) => s.sessionId === sessionId);
    if (!summary || !(await isWithinAllowedRoots(summary.cwd, this.allowedRoots))) {
      return { events: [], nextCursor: options.cursor ?? 0 };
    }

    return provider === "claude"
      ? readClaudeSession(this.claudeProjectsDir, sessionId, options)
      : readCodexSession(this.codexSessionsDir, sessionId, options);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass, then commit**

Run: `npm test -- test/sessions/session-store.test.ts && npm run typecheck`

```bash
git add src/sessions/session-store.ts test/sessions/session-store.test.ts
git commit -m "feat: unify session discovery behind an allowlist-filtered store"
```

---

### Task 6: MCP tool schemas, handlers, and wiring

**Files:**
- Modify: `src/mcp/tool-schemas.ts`, `src/mcp/register-tools.ts`, `src/main.ts`
- Test: `test/mcp-tools.test.ts` (modify), `test/repo-session-tools.test.ts` (create)

**Interfaces:**
- Consumes: `listDirectory`, `readFileLines`, `searchRepo` from `src/repo/repo-reader.js` (Task 2); `SessionStore` from `src/sessions/session-store.js` (Task 5); `BinaryFileError` from `src/errors.js` (Task 2); existing `TOOL_DEFINITIONS`, `createToolHandlers`, `registerTools`, `RegisterToolsDeps`, `ToolExtra` from `src/mcp/register-tools.js` / `src/mcp/tool-schemas.js`
- Produces: `RegisterToolsDeps` extended with `allowedRoots: readonly string[]` and `sessionStore: SessionStore`; five new tool handlers exposed the same way `agent_start` etc. already are

- [ ] **Step 1: Write failing tests asserting the tool surface grew correctly**

In `test/mcp-tools.test.ts`, update the "exposes exactly six tools" test and its neighbors:

```ts
it("exposes exactly eleven tools", () => {
  expect(TOOL_NAMES).toHaveLength(11);
  expect(TOOL_NAMES).toEqual(
    expect.arrayContaining(["repo_list", "repo_read", "repo_search", "session_list", "session_read"]),
  );
});

it("marks every new tool read-only and scoped the same way as agent_list", () => {
  const byName = Object.fromEntries(TOOL_DEFINITIONS.map((d) => [d.name, d]));
  for (const name of ["repo_list", "repo_read", "repo_search", "session_list", "session_read"] as const) {
    expect(byName[name]?.annotations.readOnlyHint).toBe(true);
    expect(byName[name]?.annotations.destructiveHint).toBe(false);
  }
});
```

Create `test/repo-session-tools.test.ts` for handler behavior:

```ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createToolHandlers } from "../src/mcp/register-tools.js";
import { SessionStore } from "../src/sessions/session-store.js";

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected a text content block");
  }
  return first.text;
}

async function buildHarness() {
  const base = await mkdtemp(join(tmpdir(), "repo-session-tools-"));
  const root = join(base, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");

  const claudeProjectsDir = join(base, "claude-projects", "-slug");
  await mkdir(claudeProjectsDir, { recursive: true });
  await writeFile(join(claudeProjectsDir, "session-1.jsonl"), `${JSON.stringify({ type: "system", cwd: root })}\n`);

  const codexSessionsDir = join(base, "codex-sessions");
  const sessionStore = new SessionStore({
    allowedRoots: [root],
    claudeProjectsDir: join(base, "claude-projects"),
    codexSessionsDir,
  });

  const handlers = createToolHandlers({
    supervisor: undefined as never,
    taskStore: undefined as never,
    eventLog: undefined as never,
    allowedRoots: [root],
    sessionStore,
  });

  return { root, handlers };
}

describe("repo_list / repo_read / repo_search handlers", () => {
  it("lists, reads, and searches within the allowed root", async () => {
    const { root, handlers } = await buildHarness();

    const listed = JSON.parse(textOf(await handlers.repo_list({ path: root }, {})));
    expect(listed.entries.map((e: { path: string }) => e.path)).toContain("src");

    const read = JSON.parse(
      textOf(await handlers.repo_read({ path: join(root, "src", "index.ts") }, {})),
    );
    expect(read.lines[0]).toBe("export const value = 1;");

    const searched = JSON.parse(textOf(await handlers.repo_search({ path: root, query: "value" }, {})));
    expect(searched.matches).toHaveLength(1);
    expect(searched.matches[0].file).toBe("src/index.ts");
  });

  it("rejects a path outside the allowed root as a tool error, not a crash", async () => {
    const { handlers } = await buildHarness();
    const result = await handlers.repo_list({ path: "/etc" }, {});
    expect(result.isError).toBe(true);
  });
});

describe("session_list / session_read handlers", () => {
  it("lists and reads sessions scoped to the allowed root", async () => {
    const { handlers } = await buildHarness();
    const listed = JSON.parse(textOf(await handlers.session_list({}, {})));
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].sessionId).toBe("session-1");

    const read = JSON.parse(textOf(await handlers.session_read({ provider: "claude", sessionId: "session-1" }, {})));
    expect(read.events).toHaveLength(1);
  });
});
```

`repo_search` requires `path` explicitly, the same way `agent_start` requires an explicit `cwd`
rather than defaulting across multiple allowed roots — the test above already reflects this.

- [ ] **Step 2: Confirm red**

Run: `npm test -- test/mcp-tools.test.ts test/repo-session-tools.test.ts`
Expected: FAIL — new tool names/handlers do not exist yet.

- [ ] **Step 3: Add the five tool definitions**

In `src/mcp/tool-schemas.ts`, extend `TOOL_NAMES` and `TOOL_DEFINITIONS`:

```ts
export const TOOL_NAMES = [
  "agent_start",
  "agent_list",
  "agent_status",
  "agent_output",
  "agent_continue",
  "agent_cancel",
  "repo_list",
  "repo_read",
  "repo_search",
  "session_list",
  "session_read",
] as const;
```

Add to the `TOOL_DEFINITIONS` array (after the existing six):

```ts
  {
    name: "repo_list",
    description: "List files and directories under an allowlisted path. Hides .git, node_modules, .env*, and build/cache directories.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path inside an allowlisted root"),
      depth: z.number().int().positive().max(5).optional(),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "repo_read",
    description: "Read a file's content by line range. Refuses .env files and binary files.",
    inputSchema: {
      path: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().positive().max(2000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "repo_search",
    description: "Search for a literal string or regular expression across an allowlisted path, bounded to a result limit.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path inside an allowlisted root to search under"),
      query: z.string().min(1),
      regex: z.boolean().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "session_list",
    description: "List Claude Code and Codex terminal sessions whose working directory is inside an allowlisted root. lastEventHint is a best-effort heuristic, not authoritative status.",
    inputSchema: {
      provider: z.enum(["codex", "claude"]).optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "session_read",
    description: "Read the content of one Claude Code or Codex session, paginated.",
    inputSchema: {
      provider: z.enum(["codex", "claude"]),
      sessionId: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
```

- [ ] **Step 4: Extend RegisterToolsDeps and add the five handlers**

In `src/mcp/register-tools.ts`:

1. Add imports:

```ts
import { BinaryFileError } from "../errors.js";
import { listDirectory, readFileLines, searchRepo } from "../repo/repo-reader.js";
import type { SessionStore } from "../sessions/session-store.js";
```

2. Extend `RegisterToolsDeps`:

```ts
export interface RegisterToolsDeps {
  readonly supervisor: JobSupervisor;
  readonly taskStore: TaskStore;
  readonly eventLog: EventLog;
  readonly allowedRoots: readonly string[];
  readonly sessionStore: SessionStore;
}
```

3. Add `BinaryFileError` to `EXPECTED_ERROR_TYPES`.

4. Add five new argument interfaces next to the existing `AgentStartArgs` etc.:

```ts
export interface RepoListArgs {
  readonly path: string;
  readonly depth?: number;
  readonly cursor?: number;
  readonly limit?: number;
}

export interface RepoReadArgs {
  readonly path: string;
  readonly cursor?: number;
  readonly limit?: number;
}

export interface RepoSearchArgs {
  readonly path: string;
  readonly query: string;
  readonly regex?: boolean;
  readonly limit?: number;
}

export interface SessionListArgs {
  readonly provider?: "codex" | "claude";
  readonly limit?: number;
}

export interface SessionReadArgs {
  readonly provider: "codex" | "claude";
  readonly sessionId: string;
  readonly cursor?: number;
  readonly limit?: number;
}
```

5. Add five handlers to the object returned by `createToolHandlers`:

```ts
    async repo_list(args: RepoListArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      try {
        const result = await listDirectory(args.path, deps.allowedRoots, {
          depth: args.depth,
          cursor: args.cursor,
          limit: args.limit,
        });
        return jsonResult(result);
      } catch (error) {
        if (isExpectedError(error)) return errorResult(error);
        throw error;
      }
    },

    async repo_read(args: RepoReadArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      try {
        const result = await readFileLines(args.path, deps.allowedRoots, { cursor: args.cursor, limit: args.limit });
        return jsonResult(result);
      } catch (error) {
        if (isExpectedError(error)) return errorResult(error);
        throw error;
      }
    },

    async repo_search(args: RepoSearchArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      try {
        const result = await searchRepo(args.path, deps.allowedRoots, args.query, {
          regex: args.regex,
          limit: args.limit,
        });
        return jsonResult(result);
      } catch (error) {
        if (isExpectedError(error)) return errorResult(error);
        throw error;
      }
    },

    async session_list(args: SessionListArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      const sessions = await deps.sessionStore.list({ provider: args.provider, limit: args.limit });
      return jsonResult({ sessions });
    },

    async session_read(args: SessionReadArgs, extra?: ToolExtra): Promise<CallToolResult> {
      if (!hasScope(extra, "agent:read")) return insufficientScope("agent:read");
      const page = await deps.sessionStore.read(args.provider, args.sessionId, {
        cursor: args.cursor,
        limit: args.limit,
      });
      return jsonResult(page);
    },
```

(Leave the existing `registerTools` loop untouched — it already iterates `TOOL_DEFINITIONS` and
looks up `handlers[definition.name]`, so the five new entries are picked up automatically.)

- [ ] **Step 5: Wire allowedRoots and sessionStore into main.ts**

In `src/main.ts`, add the import and construct the store, then include both new fields in the
`createApp` deps object:

```ts
import { SessionStore } from "./sessions/session-store.js";
```

```ts
const sessionStore = new SessionStore({ allowedRoots: config.allowedRoots });
```

```ts
const { app, shutdown: shutdownTransports } = createApp(
  { supervisor, taskStore, eventLog, allowedRoots: config.allowedRoots, sessionStore },
  { maxRequestBytes: config.maxPromptBytes, ...(auth ? { auth } : {}) },
);
```

- [ ] **Step 6: Fix the three existing test files that build `RegisterToolsDeps` directly**

`RegisterToolsDeps` now has two more required fields. Three existing test files construct it
across five call sites total, and all five will fail to typecheck until fixed. Every one of
these harnesses already creates a temp dir called `base` and already passes `allowedRoots:
[base]` to its `JobSupervisor` — reuse that same `base` for the new fields, and point
`claudeProjectsDir`/`codexSessionsDir` at empty, non-existent subdirectories of it (the
`SessionStore` treats a missing directory as "no sessions found," never as an error) so these
tests never touch the real machine's actual `~/.claude` or `~/.codex` session history.

Add this import to all three files:

```ts
import { SessionStore } from "../src/sessions/session-store.js";
```

Then, at each call site below, change the object passed to `createToolHandlers`/`createApp`
from `{ supervisor, taskStore, eventLog }` (or `{ supervisor, taskStore, eventLog, ... }`) to
also include:

```ts
allowedRoots: [base],
sessionStore: new SessionStore({
  allowedRoots: [base],
  claudeProjectsDir: join(base, "claude-projects"),
  codexSessionsDir: join(base, "codex-sessions"),
}),
```

The five call sites:

1. `test/mcp-tools.test.ts` — the `createToolHandlers({ supervisor, taskStore, eventLog })` call
   inside `buildHarness()`.
2. `test/http-transport.test.ts` — the `createApp({ supervisor, taskStore, eventLog }, ...)` call
   inside `buildHarness()`.
3. `test/auth-middleware.test.ts` — the `createToolHandlers({ supervisor, taskStore, eventLog })`
   call inside the `"lets a read-scoped token call read tools but not write tools"` test.
4. `test/auth-middleware.test.ts` — the `createApp({ supervisor, taskStore, eventLog }, { auth:
   ... })` call inside the `"rejects an unauthenticated request with 401..."` test.
5. `test/auth-middleware.test.ts` — the `createApp({ supervisor, taskStore, eventLog }, {
   mountExtraRoutes: ... })` call inside the `"keeps OAuth discovery routes reachable..."` test.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- test/mcp-tools.test.ts test/repo-session-tools.test.ts test/http-transport.test.ts test/auth-middleware.test.ts && npm run typecheck`
Expected: PASS — all four files, full typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tool-schemas.ts src/mcp/register-tools.ts src/main.ts test/mcp-tools.test.ts test/repo-session-tools.test.ts test/http-transport.test.ts test/auth-middleware.test.ts
git commit -m "feat: expose repo and session read tools over MCP"
```

---

### Task 7: End-to-end verification and docs

**Files:**
- Modify: `plugins/agent-bridge/skills/agent-bridge/SKILL.md`, `docs/OPERATIONS.md`

**Interfaces:**
- Consumes: the full built server from Tasks 1–6

- [ ] **Step 1: Run the complete automated suite and build**

Run: `npm run verify`
Expected: PASS — typecheck, all tests (existing 104 plus this feature's new ones), and build all succeed.

- [ ] **Step 2: Live smoke test against the actual running dev server**

Start the built server against a real fixture, then exercise all five new tools with real HTTP
calls (mirroring how earlier tasks in this project verified MCP tools live rather than trusting
tests alone):

```bash
node dist/main.js &
# then, with a valid session established the same way earlier live smoke tests in this
# project did (see docs/OPERATIONS.md's health-check section for the exact curl sequence):
# call repo_list on an allowed root, repo_read a known file, repo_search for a known string,
# session_list, and session_read on a session it returns. Confirm each returns 200 with the
# expected shape, and that a path outside the allowed root returns an isError tool result
# rather than crashing the process.
```

- [ ] **Step 3: Update the workflow skill with the new tools**

In `plugins/agent-bridge/skills/agent-bridge/SKILL.md`, add a short new section (after "While a
task runs") documenting the five new tools:

```markdown
## Reading context directly

Before starting a task, or whenever more context would help, read the
repository or prior session history directly instead of guessing:

- `repo_list` / `repo_read` / `repo_search` — browse and read files inside an
  allowlisted root. `.git`, `node_modules`, `.env*`, and build/cache
  directories are never shown or readable.
- `session_list` / `session_read` — see and read Claude Code/Codex sessions
  that were run directly in a terminal, not through this connector, but only
  ones whose working directory is inside an allowlisted root. The
  `lastEventHint` and `lastModifiedAt` fields on a session are best-effort
  signals, not a reliable finished/not-finished status — for that, use
  `agent_start`/`agent_continue` and `agent_status` instead.

None of these five tools require approval; none of them can write, delete,
or move anything.
```

- [ ] **Step 4: Note the new tools in operations docs**

In `docs/OPERATIONS.md`, under the existing verification section, add one line noting the tool
count changed from six to eleven, so the health-check section's expectations stay accurate for
anyone following it later.

- [ ] **Step 5: Final verify and commit**

Run: `npm run verify`

```bash
git add plugins/agent-bridge/skills/agent-bridge/SKILL.md docs/OPERATIONS.md
git commit -m "docs: document repo and session read tools in the workflow skill"
```

## Completion Evidence

Report: focused test output for each task, final `npm run verify`, the live smoke-test
transcript from Task 7 Step 2 (all five tools called for real against the running server, with
one out-of-allowlist call shown returning a tool error rather than crashing), and clean `git
status`.
