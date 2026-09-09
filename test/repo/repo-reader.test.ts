import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BinaryFileError,
  FileTooLargeError,
  PathNotAllowedError,
  SearchTimeoutError,
} from "../../src/errors.js";
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

  it("rejects being pointed directly at node_modules", async () => {
    const { root } = await buildFixtureRepo();
    await expect(listDirectory(join(root, "node_modules"), [root], {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("rejects being pointed directly at .git", async () => {
    const { root } = await buildFixtureRepo();
    await expect(listDirectory(join(root, ".git"), [root], {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("rejects a nested path under an ignored directory", async () => {
    const { root } = await buildFixtureRepo();
    await expect(listDirectory(join(root, "node_modules", "left-pad"), [root], {})).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("wraps a nonexistent directory's raw ENOENT into a typed error", async () => {
    const { root } = await buildFixtureRepo();
    await expect(listDirectory(join(root, "no-such-dir"), [root], {})).rejects.toBeInstanceOf(PathNotAllowedError);
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

  it("wraps a nonexistent file's raw ENOENT into a typed error", async () => {
    const { root } = await buildFixtureRepo();
    await expect(readFileLines(join(root, "does-not-exist.ts"), [root], {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("refuses to read a file inside .git even though it is in an allowed root", async () => {
    const { root } = await buildFixtureRepo();
    const gitConfig = join(root, ".git", "config");
    await writeFile(gitConfig, '[credential]\n\thelper = store\n\tpassword = hunter2supersecret\n');
    await expect(readFileLines(gitConfig, [root], {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("refuses to read a file inside node_modules", async () => {
    const { root } = await buildFixtureRepo();
    await expect(
      readFileLines(join(root, "node_modules", "left-pad", "index.js"), [root], {}),
    ).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("refuses a file larger than the read size cap", async () => {
    const { root } = await buildFixtureRepo();
    const bigPath = join(root, "huge.log");
    // 5 MB cap; write just over it. Non-binary content, so only the size check can reject it.
    await writeFile(bigPath, "x".repeat(5 * 1024 * 1024 + 1));
    await expect(readFileLines(bigPath, [root], {})).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("still reads a file comfortably under the size cap", async () => {
    const { root } = await buildFixtureRepo();
    const okPath = join(root, "medium.log");
    await writeFile(okPath, "line one\nline two\n");
    const page = await readFileLines(okPath, [root], {});
    expect(page.lines).toEqual(["line one", "line two"]);
  });
});

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

  it("rejects being pointed directly at an ignored directory", async () => {
    const { root } = await buildFixtureRepo();
    await expect(searchRepo(join(root, "node_modules"), [root], "module.exports", {})).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
    await expect(searchRepo(join(root, ".git"), [root], "credential", {})).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("wraps a nonexistent search path's raw ENOENT into a typed error", async () => {
    const { root } = await buildFixtureRepo();
    await expect(searchRepo(join(root, "no-such-dir"), [root], "anything", {})).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("rejects a nested-quantifier regex immediately instead of backtracking catastrophically", async () => {
    const { root } = await buildFixtureRepo();
    // A line that cannot match, which is what makes (a+)+$ pathological. Before the fix this
    // exact shape blocked the single-threaded server for minutes on a tiny file.
    await writeFile(join(root, "pathological.txt"), `${"a".repeat(33)}!\n`);
    const started = Date.now();
    await expect(searchRepo(root, [root], "(a+)+$", { regex: true, limit: 1 })).rejects.toBeInstanceOf(
      SearchTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("completes a benign multi-thousand-line regex search quickly (regression for per-line vm context creation)", async () => {
    const { root } = await buildFixtureRepo();
    // 3000 lines that never match, so the search must scan every single line under the regex
    // path rather than short-circuiting on an early hit. Before the fix, safeRegexTest created a
    // brand-new vm context per line (~4000x the cost of a plain RegExp.test), which made even this
    // benign, non-catastrophic search take multiple seconds; after hoisting context creation to
    // once per searchRepo call, this should complete in well under a second.
    const lines: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      lines.push(`line number ${i} contains ordinary, benign content with no secrets`);
    }
    await writeFile(join(root, "big.txt"), `${lines.join("\n")}\n`);

    const started = Date.now();
    const result = await searchRepo(root, [root], "no-such-token-[0-9]{4}-present", {
      regex: true,
      limit: 1_000_000,
    });
    const elapsed = Date.now() - started;

    expect(result.matches).toHaveLength(0);
    expect(result.truncated).toBe(false);
    // Generous enough not to be flaky on a slow CI box (measured 200-700ms across runs in this
    // repo's own vitest environment), tight enough to catch a per-line context-creation
    // regression, which pushed the equivalent search to 4-5x this cost (multiple seconds).
    expect(elapsed).toBeLessThan(2000);
  });

  it("bounds a catastrophic pattern that the static pre-check does not catch", async () => {
    const { root } = await buildFixtureRepo();
    // (a|a)+$ has no nested quantifier inside the group, so it slips past hasObviousCatastrophicShape
    // and must be stopped by the vm execution timeout instead.
    await writeFile(join(root, "pathological2.txt"), `${"a".repeat(40)}!\n`);
    const started = Date.now();
    await expect(searchRepo(root, [root], "(a|a)+$", { regex: true, limit: 1 })).rejects.toBeInstanceOf(
      SearchTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("skips an oversized file but still finds matches in normal files", async () => {
    const { root } = await buildFixtureRepo();
    await writeFile(join(root, "huge.log"), `${"x".repeat(5 * 1024 * 1024 + 1)}\nneedle in the haystack\n`);
    await writeFile(join(root, "small.txt"), "needle in the haystack\n");
    const result = await searchRepo(root, [root], "needle", {});
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
    const result = await searchRepo(root, [root], "sk-very-long-unique", {});
    expect(result.matches).toHaveLength(1);
    const matchText = result.matches[0]!.text;
    // Verify redaction happened (should contain [REDACTED], not the partial secret)
    expect(matchText).toContain("[REDACTED]");
    expect(matchText).not.toContain("sk-very-long-unique");
    // Verify truncation happened (300 char limit)
    expect(matchText.length).toBeLessThanOrEqual(300);
  });
});
