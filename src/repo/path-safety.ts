import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { resolveAllowedDirectory } from "../config.js";
import { PathNotAllowedError } from "../errors.js";
import { isEnvFileName, isIgnoredName } from "./ignore-list.js";

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
 * Throws if any path segment between the matched allowed root and `canonical` is an ignored name.
 *
 * The directory walk in `repo-reader` filters ignored names out of the children it discovers, but
 * that never covered a path the caller asked for *directly* — `<root>/.git/config` and
 * `<root>/node_modules` reached the readers untouched. This is the check for the requested path
 * itself; it must be applied after containment has already been established.
 */
export async function assertNoIgnoredSegment(canonical: string, allowedRoots: readonly string[]): Promise<void> {
  for (const root of allowedRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
    } catch {
      continue;
    }
    const rel = relative(canonicalRoot, canonical);
    const isInsideThisRoot = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (!isInsideThisRoot) continue;
    const segments = rel.split(sep).filter(Boolean);
    if (segments.some((segment) => isIgnoredName(segment))) {
      throw new PathNotAllowedError("Path is inside an ignored directory");
    }
    return;
  }
}

/**
 * Resolves a requested file path for `repo_read`: must be absolute, must not be an env file
 * (checked both as requested and after symlink resolution), must exist as a regular file, must
 * resolve inside one of the allowed roots after symlink resolution, and must not sit under an
 * ignored directory such as `.git` or `node_modules`.
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
  await assertNoIgnoredSegment(canonical, allowedRoots);
  return canonical;
}

/**
 * Like `resolveAllowedDirectory`, but additionally refuses a path inside an ignored directory and
 * converts any raw filesystem error (e.g. ENOENT for a nonexistent path) into a typed
 * `PathNotAllowedError`, so a caller never sees an untyped error escape.
 *
 * `resolveAllowedDirectory` itself is shared with `agent_start` and is deliberately left alone;
 * the stricter read-tool policy lives here instead.
 */
export async function resolveAllowedDirectoryStrict(
  requested: string,
  allowedRoots: readonly string[],
): Promise<string> {
  let canonical: string;
  try {
    canonical = await resolveAllowedDirectory(requested, allowedRoots);
  } catch (error) {
    if (error instanceof PathNotAllowedError) throw error;
    throw new PathNotAllowedError(`Path is not accessible: ${requested}`);
  }
  await assertNoIgnoredSegment(canonical, allowedRoots);
  return canonical;
}
