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
