import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createContext, Script } from "node:vm";
import { BinaryFileError, FileTooLargeError, PathNotAllowedError, SearchTimeoutError } from "../errors.js";
import { isIgnoredName } from "./ignore-list.js";
import { resolveAllowedDirectoryStrict, resolveAllowedFile } from "./path-safety.js";
import { redactTextLine } from "../security/redact.js";

/** Largest file the read tools will pull into memory. Checked via stat() before any read. */
const MAX_READABLE_FILE_BYTES = 5 * 1024 * 1024;

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
  const canonical = await resolveAllowedDirectoryStrict(path, allowedRoots);
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
  let canonical: string;
  try {
    canonical = await resolveAllowedFile(path, allowedRoots);
  } catch (err: unknown) {
    // resolveAllowedFile throws PathNotAllowedError for most cases, but may let
    // untyped ENOENT escape from realpath/stat. Wrap any non-PathNotAllowedError.
    if (err instanceof PathNotAllowedError) {
      throw err;
    }
    throw new PathNotAllowedError(`File not found or not accessible: ${path}`);
  }

  // Size-check before reading: otherwise a large log/CSV/dump is fully allocated in memory before
  // looksBinary ever gets a chance to reject it.
  const info = await stat(canonical);
  if (info.size > MAX_READABLE_FILE_BYTES) {
    throw new FileTooLargeError(`File exceeds the ${MAX_READABLE_FILE_BYTES}-byte read limit: ${path}`);
  }

  const buffer = await readFile(canonical);
  if (looksBinary(buffer)) throw new BinaryFileError(`Refusing to read binary file: ${path}`);

  let allLines = buffer.toString("utf8").split("\n");
  // Remove trailing empty line that results from split if file ends with newline
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines = allLines.slice(0, -1);
  }
  const totalLines = allLines.length;
  const cursor = options.cursor ?? 0;
  const limit = options.limit ?? 500;
  const page = allLines.slice(cursor, cursor + limit).map(redactTextLine);
  return { lines: page, nextCursor: cursor + page.length, totalLines };
}

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

/**
 * Rejects the classic nested-quantifier ReDoS shape, e.g. `(a+)+`, `(a*)*`, `(a+)*`. Deliberately
 * a cheap syntactic heuristic, NOT an exhaustive ReDoS detector — plenty of catastrophic patterns
 * (`(a|a)+`, nested alternation) sail straight past it. It exists only to reject the most common
 * shape instantly; `safeRegexTest` below is the layer that actually bounds cost in all cases.
 */
function hasObviousCatastrophicShape(pattern: string): boolean {
  return /\([^()]*[+*][^()]*\)[+*]/.test(pattern);
}

const REGEX_TEST_SCRIPT = new Script("__result = __pattern.test(__text);");
const REGEX_TEST_TIMEOUT_MS = 250;

/**
 * Runs one `pattern.test(text)` under a hard wall-clock bound.
 *
 * This is a real bound, not a cosmetic wrapper: `vm`'s timeout terminates execution via V8's
 * interrupt mechanism, which does interrupt native RegExp backtracking (verified against the
 * pathological `(a|a)+$` case, which the static pre-check above does not catch). Together the two
 * layers cap a single line's evaluation at ~250ms rather than leaving it unbounded; they are not a
 * mathematically complete ReDoS proof, and a search over very many lines can still be slow in
 * aggregate — the per-line bound is what keeps the single-threaded server responsive.
 */
function safeRegexTest(pattern: RegExp, text: string): boolean {
  const context = createContext({ __pattern: pattern, __text: text, __result: false });
  try {
    REGEX_TEST_SCRIPT.runInContext(context, { timeout: REGEX_TEST_TIMEOUT_MS });
  } catch {
    throw new SearchTimeoutError("Search pattern took too long to evaluate on one line");
  }
  return Boolean(context.__result);
}

export async function searchRepo(
  path: string,
  allowedRoots: readonly string[],
  query: string,
  options: SearchOptions,
): Promise<SearchResult> {
  const canonical = await resolveAllowedDirectoryStrict(path, allowedRoots);
  if (options.regex && hasObviousCatastrophicShape(query)) {
    throw new SearchTimeoutError("Search pattern has a nested-quantifier shape that is unsafe to evaluate");
  }
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
      // Skip oversized files the same way binary files are skipped: one huge file in the tree
      // should not fail the whole search, and must not be allocated in memory to find that out.
      const info = await stat(fullPath);
      if (info.size > MAX_READABLE_FILE_BYTES) continue;
      buffer = await readFile(fullPath);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;

    const lines = buffer.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      // String.includes has no backtracking risk; only the regex path needs the bound.
      const isMatch = pattern ? safeRegexTest(pattern, line) : line.includes(query);
      if (!isMatch) continue;
      matches.push({
        file: entry.path,
        line: i + 1,
        text: redactTextLine(line).slice(0, MAX_MATCH_TEXT_LENGTH),
      });
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
  }

  return { matches, truncated };
}
