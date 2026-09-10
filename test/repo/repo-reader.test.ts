import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BinaryFileError, FileTooLargeError, PathNotAllowedError } from "../../src/errors.js";
import { listDirectory, readFileLines, searchRepo } from "../../src/repo/repo-reader.js";
import { filesPolicyFor } from "../helpers/policy.js";

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
    const result = await listDirectory(root, filesPolicyFor(root), {});
    const names = result.entries.map((e) => e.path).sort();
    expect(names).toEqual(["README.md", "src"]);
  });

  it("rejects a path outside the allowed roots", async () => {
    const { base, root } = await buildFixtureRepo();
    await expect(listDirectory(base, filesPolicyFor(root), {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("rejects being pointed directly at node_modules", async () => {
    const { root } = await buildFixtureRepo();
    await expect(listDirectory(join(root, "node_modules"), filesPolicyFor(root), {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("rejects being pointed directly at .git", async () => {
    const { root } = await buildFixtureRepo();
    await expect(listDirectory(join(root, ".git"), filesPolicyFor(root), {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("rejects a nested path under an ignored directory", async () => {
    const { root } = await buildFixtureRepo();
    await expect(listDirectory(join(root, "node_modules", "left-pad"), filesPolicyFor(root), {})).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("wraps a nonexistent directory's raw ENOENT into a typed error", async () => {
    const { root } = await buildFixtureRepo();
    await expect(listDirectory(join(root, "no-such-dir"), filesPolicyFor(root), {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });
});

describe("readFileLines", () => {
  it("returns the requested line range with pagination", async () => {
    const { root } = await buildFixtureRepo();
    const file = join(root, "src", "index.ts");
    const first = await readFileLines(file, filesPolicyFor(root), { cursor: 0, limit: 1 });
    expect(first.lines).toEqual(["export const total = price * quantity;"]);
    expect(first.nextCursor).toBe(1);
    expect(first.totalLines).toBe(2);
  });

  it("redacts a secret-looking assignment", async () => {
    const { root } = await buildFixtureRepo();
    const file = join(root, "src", "index.ts");
    const page = await readFileLines(file, filesPolicyFor(root), { cursor: 1, limit: 1 });
    expect(page.lines[0]).toBe('const apiKey = "[REDACTED]";');
  });

  it("refuses to read an .env file", async () => {
    const { root } = await buildFixtureRepo();
    await expect(readFileLines(join(root, ".env"), filesPolicyFor(root), {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("refuses to read a binary file", async () => {
    const { root } = await buildFixtureRepo();
    const binaryPath = join(root, "src", "image.bin");
    await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    await expect(readFileLines(binaryPath, filesPolicyFor(root), {})).rejects.toBeInstanceOf(BinaryFileError);
  });

  it("wraps a nonexistent file's raw ENOENT into a typed error", async () => {
    const { root } = await buildFixtureRepo();
    await expect(readFileLines(join(root, "does-not-exist.ts"), filesPolicyFor(root), {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("refuses to read a file inside .git even though it is in an allowed root", async () => {
    const { root } = await buildFixtureRepo();
    const gitConfig = join(root, ".git", "config");
    await writeFile(gitConfig, '[credential]\n\thelper = store\n\tpassword = hunter2supersecret\n');
    await expect(readFileLines(gitConfig, filesPolicyFor(root), {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("refuses to read a file inside node_modules", async () => {
    const { root } = await buildFixtureRepo();
    await expect(
      readFileLines(join(root, "node_modules", "left-pad", "index.js"), filesPolicyFor(root), {}),
    ).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("refuses a file larger than the read size cap", async () => {
    const { root } = await buildFixtureRepo();
    const bigPath = join(root, "huge.log");
    // 5 MB cap; write just over it. Non-binary content, so only the size check can reject it.
    await writeFile(bigPath, "x".repeat(5 * 1024 * 1024 + 1));
    await expect(readFileLines(bigPath, filesPolicyFor(root), {})).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("still reads a file comfortably under the size cap", async () => {
    const { root } = await buildFixtureRepo();
    const okPath = join(root, "medium.log");
    await writeFile(okPath, "line one\nline two\n");
    const page = await readFileLines(okPath, filesPolicyFor(root), {});
    expect(page.lines).toEqual(["line one", "line two"]);
  });
});

describe("searchRepo", () => {
  it("finds a literal match and redacts it", async () => {
    const { root } = await buildFixtureRepo();
    const result = await searchRepo(root, filesPolicyFor(root), "apiKey", {});
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toEqual({ file: "src/index.ts", line: 2, text: 'const apiKey = "[REDACTED]";' });
    expect(result.truncated).toBe(false);
  });

  it("never searches inside ignored directories", async () => {
    const { root } = await buildFixtureRepo();
    const result = await searchRepo(root, filesPolicyFor(root), "module.exports", {});
    expect(result.matches).toHaveLength(0);
  });

  it("caps results at the given limit and reports truncation", async () => {
    const { root } = await buildFixtureRepo();
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(root, `extra-${i}.txt`), "needle here\n");
    }
    const result = await searchRepo(root, filesPolicyFor(root), "needle", { limit: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects being pointed directly at an ignored directory", async () => {
    const { root } = await buildFixtureRepo();
    await expect(searchRepo(join(root, "node_modules"), filesPolicyFor(root), "module.exports", {})).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
    await expect(searchRepo(join(root, ".git"), filesPolicyFor(root), "credential", {})).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("wraps a nonexistent search path's raw ENOENT into a typed error", async () => {
    const { root } = await buildFixtureRepo();
    await expect(searchRepo(join(root, "no-such-dir"), filesPolicyFor(root), "anything", {})).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("skips an oversized file but still finds matches in normal files", async () => {
    const { root } = await buildFixtureRepo();
    await writeFile(join(root, "huge.log"), `${"x".repeat(5 * 1024 * 1024 + 1)}\nneedle in the haystack\n`);
    await writeFile(join(root, "small.txt"), "needle in the haystack\n");
    const result = await searchRepo(root, filesPolicyFor(root), "needle", {});
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.file).toBe("small.txt");
  });

  it("redacts secrets even when line is longer than MAX_MATCH_TEXT_LENGTH", async () => {
    const { root } = await buildFixtureRepo();
    // Create a line longer than 300 characters where the secret assignment's
    // closing quote falls past character 300. This tests that we redact the full
    // line BEFORE truncating, not the other way around (which would miss the closing quote).
    const longLineWithSecret = `const x = 1; ${" ".repeat(250)}const longSecret = "sk-very-long-unique-secret-value-that-starts-before-300-but-closes-after-300-chars";`;
    await writeFile(join(root, "long-secret.ts"), longLineWithSecret);
    const result = await searchRepo(root, filesPolicyFor(root), "sk-very-long-unique", {});
    expect(result.matches).toHaveLength(1);
    const matchText = result.matches[0]!.text;
    // Verify redaction happened (should contain [REDACTED], not the partial secret)
    expect(matchText).toContain("[REDACTED]");
    expect(matchText).not.toContain("sk-very-long-unique");
    // Verify truncation happened (300 char limit)
    expect(matchText.length).toBeLessThanOrEqual(300);
  });
});
