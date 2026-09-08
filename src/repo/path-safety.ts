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
