import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AccessPolicy,
  containsPath,
  EMPTY_FILES_POLICY,
  isDeniedPath,
  parseFilesPolicy,
  PolicyValidationError,
} from "../../src/policy/files-policy.js";

describe("parseFilesPolicy", () => {
  it("normalizes allow and deny to resolved absolute paths", () => {
    const policy = parseFilesPolicy({ allow: ["/a/b/"], deny: ["/a/b/secrets/."] });
    expect(policy.allow).toEqual(["/a/b"]);
    expect(policy.deny).toEqual(["/a/b/secrets"]);
  });

  it("defaults a missing deny list to empty", () => {
    expect(parseFilesPolicy({ allow: ["/a"] }).deny).toEqual([]);
  });

  it("accepts an empty allow list as the fail-closed starting state", () => {
    const policy = parseFilesPolicy({ allow: [] });
    expect(policy.allow).toEqual([]);
  });

  it("rejects a relative path", () => {
    expect(() => parseFilesPolicy({ allow: ["relative/path"] })).toThrow(PolicyValidationError);
  });

  it("rejects a non-array allow", () => {
    expect(() => parseFilesPolicy({ allow: "/a" })).toThrow(PolicyValidationError);
  });

  it("rejects a non-string entry", () => {
    expect(() => parseFilesPolicy({ allow: [42] })).toThrow(PolicyValidationError);
  });

  it("rejects an empty-string entry", () => {
    expect(() => parseFilesPolicy({ allow: ["  "] })).toThrow(PolicyValidationError);
  });

  it("rejects a non-object files section", () => {
    expect(() => parseFilesPolicy(["/a"])).toThrow(PolicyValidationError);
    expect(() => parseFilesPolicy(null)).toThrow(PolicyValidationError);
  });
});

describe("containsPath", () => {
  it("treats a path as containing itself", () => {
    expect(containsPath("/a/b", "/a/b")).toBe(true);
  });

  it("recognizes a descendant", () => {
    expect(containsPath("/a/b", "/a/b/c/d")).toBe(true);
  });

  it("rejects a sibling that merely shares a name prefix", () => {
    expect(containsPath("/a/b", "/a/bc")).toBe(false);
  });

  it("rejects an ancestor", () => {
    expect(containsPath("/a/b", "/a")).toBe(false);
  });
});

describe("isDeniedPath", () => {
  it("denies the configured path itself and everything under it", async () => {
    await expect(isDeniedPath("/a/secrets", ["/a/secrets"])).resolves.toBe(true);
    await expect(isDeniedPath("/a/secrets/key.txt", ["/a/secrets"])).resolves.toBe(true);
  });

  it("allows a path outside every deny entry", async () => {
    await expect(isDeniedPath("/a/src/index.ts", ["/a/secrets"])).resolves.toBe(false);
  });

  it("denies a path that does not exist on disk yet", async () => {
    // The owner can deny a directory before creating it; the rule must already be in force.
    await expect(isDeniedPath("/nowhere/at/all/file", ["/nowhere/at/all"])).resolves.toBe(true);
  });

  it("denies through a symlinked deny entry", async () => {
    const base = await mkdtemp(join(tmpdir(), "deny-symlink-"));
    const real = join(base, "real-secrets");
    const link = join(base, "linked-secrets");
    await mkdir(real, { recursive: true });
    await symlink(real, link);
    // The deny list names the symlink; a caller reaching the canonical path must still be denied.
    // Callers always pass an already-canonicalized path, so the probe is canonicalized too.
    await expect(isDeniedPath(join(await realpath(real), "key.txt"), [link])).resolves.toBe(true);
  });

  it("denies nothing when the deny list is empty", async () => {
    await expect(isDeniedPath("/a/b", [])).resolves.toBe(false);
  });
});

describe("AccessPolicy", () => {
  it("starts fail-closed by default", () => {
    expect(new AccessPolicy().files).toEqual(EMPTY_FILES_POLICY);
  });

  it("exposes replacements through the same object identity", () => {
    const policy = new AccessPolicy({ allow: ["/a"], deny: [] });
    const captured = policy; // what the wiring holds onto at startup
    policy.update({ allow: ["/b"], deny: ["/b/secrets"] });
    expect(captured.files.allow).toEqual(["/b"]);
    expect(captured.files.deny).toEqual(["/b/secrets"]);
  });
});
