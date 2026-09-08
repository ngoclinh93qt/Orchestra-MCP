import { mkdtemp, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
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
