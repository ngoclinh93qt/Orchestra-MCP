import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createToolHandlers } from "../src/mcp/register-tools.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { accessPolicyFor } from "./helpers/policy.js";

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected a text content block");
  }
  return first.text;
}

async function buildHarness() {
  const base = await mkdtemp(join(tmpdir(), "repo-session-tools-"));
  const root = join(base, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");

  const claudeProjectsDir = join(base, "claude-projects", "-slug");
  await mkdir(claudeProjectsDir, { recursive: true });
  await writeFile(join(claudeProjectsDir, "session-1.jsonl"), `${JSON.stringify({ type: "system", cwd: root })}\n`);

  const codexSessionsDir = join(base, "codex-sessions");
  const sessionStore = new SessionStore({
    policy: accessPolicyFor(root),
    claudeProjectsDir: join(base, "claude-projects"),
    codexSessionsDir,
  });

  const handlers = createToolHandlers({
    supervisor: undefined as never,
    taskStore: undefined as never,
    eventLog: undefined as never,
    policy: accessPolicyFor(root),
    sessionStore,
  });

  return { root, handlers };
}

describe("repo_list / repo_read / repo_search handlers", () => {
  it("lists, reads, and searches within the allowed root", async () => {
    const { root, handlers } = await buildHarness();

    const listed = JSON.parse(textOf(await handlers.repo_list({ path: root }, {})));
    expect(listed.entries.map((e: { path: string }) => e.path)).toContain("src");

    const read = JSON.parse(
      textOf(await handlers.repo_read({ path: join(root, "src", "index.ts") }, {})),
    );
    expect(read.lines[0]).toBe("export const value = 1;");

    const searched = JSON.parse(textOf(await handlers.repo_search({ path: root, query: "value" }, {})));
    expect(searched.matches).toHaveLength(1);
    expect(searched.matches[0].file).toBe("src/index.ts");
  });

  it("rejects a path outside the allowed root as a tool error, not a crash", async () => {
    const { handlers } = await buildHarness();
    const result = await handlers.repo_list({ path: "/etc" }, {});
    expect(result.isError).toBe(true);
  });
});

describe("session_list / session_read handlers", () => {
  it("lists and reads sessions scoped to the allowed root", async () => {
    const { handlers } = await buildHarness();
    const listed = JSON.parse(textOf(await handlers.session_list({}, {})));
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].sessionId).toBe("session-1");

    const read = JSON.parse(textOf(await handlers.session_read({ provider: "claude", sessionId: "session-1" }, {})));
    expect(read.events).toHaveLength(1);
  });
});
