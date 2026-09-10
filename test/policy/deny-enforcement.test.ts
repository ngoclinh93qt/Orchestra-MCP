import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAllowedDirectory } from "../../src/config.js";
import { PathNotAllowedError } from "../../src/errors.js";
import { createToolHandlers } from "../../src/mcp/register-tools.js";
import { AccessPolicy } from "../../src/policy/files-policy.js";
import { listDirectory, readFileLines, searchRepo } from "../../src/repo/repo-reader.js";
import { SessionStore } from "../../src/sessions/session-store.js";

/**
 * An allowed project containing one denied subdirectory. `secrets/` holds a distinctive string so a
 * search that leaks it is unambiguous.
 */
async function buildFixture(): Promise<{ root: string; secrets: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "deny-enforce-")));
  const root = join(base, "project");
  const secrets = join(root, "secrets");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(secrets, { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const marker = 1;\n");
  await writeFile(join(secrets, "keys.txt"), "marker-should-never-be-visible\n");
  return { root, secrets };
}

function policyFor(root: string, secrets: string) {
  return { allow: [root], deny: [secrets] };
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected a text content block");
  }
  return first.text;
}

describe("deny enforcement in the read tools", () => {
  it("refuses to read a file inside a denied directory", async () => {
    const { root, secrets } = await buildFixture();
    await expect(readFileLines(join(secrets, "keys.txt"), policyFor(root, secrets), {})).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("still reads an allowed file in the same project", async () => {
    const { root, secrets } = await buildFixture();
    const result = await readFileLines(join(root, "src", "index.ts"), policyFor(root, secrets), {});
    expect(result.lines[0]).toBe("export const marker = 1;");
  });

  it("refuses to list a denied directory directly", async () => {
    const { root, secrets } = await buildFixture();
    await expect(listDirectory(secrets, policyFor(root, secrets), {})).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it("hides a denied child when listing its allowed parent", async () => {
    const { root, secrets } = await buildFixture();
    const result = await listDirectory(root, policyFor(root, secrets), { depth: 5 });
    const paths = result.entries.map((entry) => entry.path);
    expect(paths).toContain("src");
    expect(paths).not.toContain("secrets");
    expect(paths.some((path) => path.startsWith("secrets"))).toBe(false);
  });

  it("excludes denied files from a search started at the allowed parent", async () => {
    const { root, secrets } = await buildFixture();
    const result = await searchRepo(root, policyFor(root, secrets), "marker", { limit: 50 });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((match) => !match.file.startsWith("secrets"))).toBe(true);
    expect(result.matches.every((match) => !match.text.includes("never-be-visible"))).toBe(true);
  });
});

describe("deny enforcement for agent working directories", () => {
  it("refuses a denied directory as a working directory", async () => {
    const { root, secrets } = await buildFixture();
    await expect(resolveAllowedDirectory(secrets, policyFor(root, secrets))).rejects.toBeInstanceOf(
      PathNotAllowedError,
    );
  });

  it("still accepts an allowed directory in the same project", async () => {
    const { root, secrets } = await buildFixture();
    await expect(resolveAllowedDirectory(join(root, "src"), policyFor(root, secrets))).resolves.toBe(
      join(root, "src"),
    );
  });
});

describe("policy changes take effect without rebuilding the tool wiring", () => {
  it("applies an updated policy to handlers built before the change", async () => {
    const { root, secrets } = await buildFixture();
    const policy = new AccessPolicy({ allow: [root], deny: [] });
    const handlers = createToolHandlers({
      supervisor: undefined as never,
      taskStore: undefined as never,
      eventLog: undefined as never,
      policy,
      sessionStore: new SessionStore({ policy }),
    });

    const before = await handlers.repo_read({ path: join(secrets, "keys.txt") }, {});
    expect(before.isError).not.toBe(true);

    // Exactly what a config-file save does at runtime.
    policy.update({ allow: [root], deny: [secrets] });

    const after = await handlers.repo_read({ path: join(secrets, "keys.txt") }, {});
    expect(after.isError).toBe(true);
    expect(textOf(after as never)).toContain("outside allowed roots");
  });

  it("widens access the same way when a root is added", async () => {
    const { root, secrets } = await buildFixture();
    const policy = new AccessPolicy({ allow: [], deny: [] });
    const handlers = createToolHandlers({
      supervisor: undefined as never,
      taskStore: undefined as never,
      eventLog: undefined as never,
      policy,
      sessionStore: new SessionStore({ policy }),
    });

    const before = await handlers.repo_read({ path: join(root, "src", "index.ts") }, {});
    expect(before.isError).toBe(true);

    policy.update({ allow: [root], deny: [secrets] });

    const after = await handlers.repo_read({ path: join(root, "src", "index.ts") }, {});
    expect(after.isError).not.toBe(true);
  });
});
