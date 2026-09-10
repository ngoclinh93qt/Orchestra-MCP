import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * The owner's file-access policy: which absolute paths the bridge may touch (`allow`), and which
 * subtrees are carved back out of them (`deny`). Deny always wins — a path inside both an allowed
 * root and a denied path is refused.
 *
 * This is the single authorization surface for every path-taking tool, read (`repo_*`) and write
 * (`agent_start`) alike. A folder the owner denies cannot be read directly *or* handed to an agent
 * as a working directory, which would otherwise let the agent read it on the caller's behalf.
 */
export interface FilesPolicy {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/** Fail-closed default: nothing is reachable until the owner allows something. */
export const EMPTY_FILES_POLICY: FilesPolicy = Object.freeze({
  allow: Object.freeze([]) as readonly string[],
  deny: Object.freeze([]) as readonly string[],
});

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

function validatePathList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PolicyValidationError(`files.${field} must be an array of absolute paths`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new PolicyValidationError(`files.${field}[${index}] must be a non-empty string`);
    }
    if (!isAbsolute(entry)) {
      throw new PolicyValidationError(`files.${field}[${index}] must be an absolute path, got ${entry}`);
    }
    return resolve(entry);
  });
}

/**
 * Validates and normalizes the `files` section of the config file.
 *
 * An empty `allow` list is valid, not an error: that is the fail-closed state a freshly created
 * config starts in, and the owner is told to edit it. Rejecting it here would instead crash the
 * bridge on first boot.
 */
export function parseFilesPolicy(raw: unknown): FilesPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PolicyValidationError("files must be an object");
  }
  const record = raw as Record<string, unknown>;
  return Object.freeze({
    allow: Object.freeze(validatePathList(record.allow, "allow")) as readonly string[],
    deny: Object.freeze(validatePathList(record.deny, "deny")) as readonly string[],
  });
}

/** True if `child` is `parent` itself or sits underneath it. Purely lexical — no filesystem access. */
export function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Expands each deny entry into every prefix worth comparing paths against: the literal configured
 * path, plus its canonical form when it exists on disk and differs.
 *
 * Keeping both matters in each direction. The canonical form catches a caller who reaches a denied
 * directory by its real path while the config names a symlink. The literal form keeps a deny
 * meaningful for a path that does not exist yet — the owner can deny a directory before creating
 * it, and the rule takes effect the moment it appears.
 *
 * Resolving once up front lets a directory walk apply deny with cheap lexical comparisons instead
 * of a `realpath` call per entry visited.
 */
export async function expandDenyPrefixes(deny: readonly string[]): Promise<string[]> {
  const prefixes: string[] = [];
  for (const entry of deny) {
    prefixes.push(entry);
    try {
      const canonical = await realpath(entry);
      if (canonical !== entry) prefixes.push(canonical);
    } catch {
      // Not on disk; the literal prefix above is the only one that can apply.
    }
  }
  return prefixes;
}

/** True if a path falls under any expanded deny prefix. Purely lexical — no filesystem access. */
export function isDeniedByPrefixes(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => containsPath(prefix, path));
}

/** True if an already-canonicalized path is denied. */
export async function isDeniedPath(canonical: string, deny: readonly string[]): Promise<boolean> {
  return isDeniedByPrefixes(canonical, await expandDenyPrefixes(deny));
}

/**
 * Holds the policy currently in force behind a stable object identity, so the wiring built once at
 * startup keeps working while the underlying policy is replaced on config reload. Everything that
 * enforces access reads `.files` at call time rather than capturing the array at construction.
 */
export class AccessPolicy {
  #files: FilesPolicy;

  constructor(initial: FilesPolicy = EMPTY_FILES_POLICY) {
    this.#files = initial;
  }

  get files(): FilesPolicy {
    return this.#files;
  }

  update(next: FilesPolicy): void {
    this.#files = next;
  }
}
