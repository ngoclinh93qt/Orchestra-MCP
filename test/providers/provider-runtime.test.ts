import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildChildEnv, locateCommand, resolveProviderRuntime } from "../../src/providers/runtime.js";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bridge-runtime-"));
}

async function executable(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

describe("locateCommand", () => {
  it("finds a command on PATH", async () => {
    const bin = join(await freshDir(), "bin");
    const found = await executable(join(bin, "tool"));
    await expect(locateCommand("tool", { pathEnv: `/nonexistent:${bin}`, candidates: [] })).resolves.toBe(found);
  });

  it("falls back to a known install location when PATH lacks the command", async () => {
    // The launchd case: PATH is only /usr/bin:/bin, and the CLI lives somewhere else entirely.
    const found = await executable(join(await freshDir(), "App.app", "Contents", "Resources", "tool"));
    await expect(locateCommand("tool", { pathEnv: "/usr/bin:/bin", candidates: [found] })).resolves.toBe(found);
  });

  it("skips a file on PATH that is not executable", async () => {
    const bin = join(await freshDir(), "bin");
    await mkdir(bin);
    await writeFile(join(bin, "tool"), "not executable");
    const fallback = await executable(join(await freshDir(), "tool"));
    await expect(locateCommand("tool", { pathEnv: bin, candidates: [fallback] })).resolves.toBe(fallback);
  });

  it("returns undefined when the command is nowhere", async () => {
    await expect(locateCommand("tool", { pathEnv: "/usr/bin:/bin", candidates: ["/nonexistent/tool"] })).resolves.toBeUndefined();
  });

  it("uses an explicit override and nothing else", async () => {
    const override = await executable(join(await freshDir(), "custom-tool"));
    const onPath = join(await freshDir(), "bin");
    await executable(join(onPath, "tool"));
    await expect(locateCommand("tool", { override, pathEnv: onPath, candidates: [] })).resolves.toBe(override);
  });

  it("does not silently replace a broken override with something else", async () => {
    // An owner who names a binary explicitly wants that binary; running a different one found on
    // PATH instead would hide the misconfiguration.
    const onPath = join(await freshDir(), "bin");
    await executable(join(onPath, "tool"));
    await expect(
      locateCommand("tool", { override: "/nonexistent/tool", pathEnv: onPath, candidates: [] }),
    ).resolves.toBeUndefined();
  });
});

describe("buildChildEnv", () => {
  const source = {
    HOME: "/Users/example",
    USER: "example",
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin",
    OPENAI_API_KEY: "sk-should-not-leak",
    AGENT_BRIDGE_STATE_DIR: "/state",
    RANDOM_VAR: "x",
  };

  it("keeps the variables a CLI needs to find its own login and config", () => {
    const env = buildChildEnv(source, []);
    expect(env.HOME).toBe("/Users/example");
    expect(env.USER).toBe("example");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("passes nothing outside the allowlist", () => {
    const env = buildChildEnv(source, []);
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("AGENT_BRIDGE_STATE_DIR");
    expect(env).not.toHaveProperty("RANDOM_VAR");
  });

  it("puts extra directories ahead of the inherited PATH, without duplicates", () => {
    const env = buildChildEnv(source, ["/opt/homebrew/bin", "/usr/bin", "/opt/homebrew/bin"]);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("still produces a PATH and HOME when the parent has neither", () => {
    const env = buildChildEnv({}, ["/extra"], "/Users/fallback");
    expect(env.PATH).toBe("/extra:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(env.HOME).toBe("/Users/fallback");
  });
});

describe("resolveProviderRuntime", () => {
  it("finds both CLIs and a usable child environment under a launchd-style PATH", async () => {
    const home = await freshDir();
    const claude = await executable(join(home, ".local", "bin", "claude"));
    const codex = await executable(join(home, "Apps", "ChatGPT.app", "Contents", "Resources", "codex"));

    const runtime = await resolveProviderRuntime(
      { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      { execPath: "/opt/node/bin/node", candidates: { claude: [claude], codex: [codex] } },
    );

    expect(runtime.claudeCommand).toBe(claude);
    expect(runtime.codexCommand).toBe(codex);
    expect(runtime.childEnv.HOME).toBe(home);
    // The agents themselves run node/npm and user-installed tools, so they need more than /usr/bin.
    expect(runtime.childEnv.PATH?.split(":")).toEqual(
      expect.arrayContaining(["/opt/node/bin", join(home, ".local", "bin"), "/usr/bin"]),
    );
  });

  it("honors the AGENT_BRIDGE_*_BIN overrides", async () => {
    const home = await freshDir();
    const codex = await executable(join(home, "custom", "codex"));
    const runtime = await resolveProviderRuntime(
      { HOME: home, PATH: "/usr/bin:/bin", AGENT_BRIDGE_CODEX_BIN: codex },
      { execPath: "/opt/node/bin/node", candidates: { claude: [], codex: [] } },
    );
    expect(runtime.codexCommand).toBe(codex);
    expect(runtime.claudeCommand).toBeUndefined();
  });
});
