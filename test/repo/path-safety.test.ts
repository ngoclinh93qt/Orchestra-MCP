import { mkdtemp, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isEnvFileName, isIgnoredName } from "../../src/repo/ignore-list.js";
import {
  isWithinAllowedRoots,
  resolveAllowedDirectoryStrict,
  resolveAllowedFile,
} from "../../src/repo/path-safety.js";
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
    const canonicalFile = await realpath(file);
    await expect(resolveAllowedFile(file, [root])).resolves.toBe(canonicalFile);
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

  it("refuses a file directly requested inside .git, even though it is in an allowed root", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    await mkdir(join(root, ".git"), { recursive: true });
    const gitConfig = join(root, ".git", "config");
    await writeFile(gitConfig, "[credential]\n\thelper = store\n");
    await expect(resolveAllowedFile(gitConfig, [root])).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("refuses a file nested deep inside node_modules", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    const file = join(root, "node_modules", "left-pad", "index.js");
    await writeFile(file, "module.exports = {};\n");
    await expect(resolveAllowedFile(file, [root])).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("still allows an ordinary nested file whose segments are not ignored", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    await mkdir(join(root, "src", "lib"), { recursive: true });
    const file = join(root, "src", "lib", "util.ts");
    await writeFile(file, "export {}");
    await expect(resolveAllowedFile(file, [root])).resolves.toBe(await realpath(file));
  });
});

describe("resolveAllowedDirectoryStrict", () => {
  it("returns the canonical path for an ordinary directory inside an allowed root", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    const dir = join(root, "src");
    await mkdir(dir, { recursive: true });
    await expect(resolveAllowedDirectoryStrict(dir, [root])).resolves.toBe(await realpath(dir));
  });

  it("refuses a directory that is itself an ignored name", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await expect(resolveAllowedDirectoryStrict(join(root, "node_modules"), [root])).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("refuses a directory nested under an ignored segment", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    await mkdir(join(root, ".git", "refs"), { recursive: true });
    await expect(resolveAllowedDirectoryStrict(join(root, ".git", "refs"), [root])).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("converts a nonexistent path's raw ENOENT into a typed PathNotAllowedError", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    await mkdir(root, { recursive: true });
    await expect(resolveAllowedDirectoryStrict(join(root, "nope"), [root])).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("still refuses a directory outside every allowed root", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-safety-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await expect(resolveAllowedDirectoryStrict(outside, [root])).rejects.toBeInstanceOf(PathNotAllowedError);
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
