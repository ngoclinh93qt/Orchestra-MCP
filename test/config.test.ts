import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveAllowedDirectory } from "../src/config.js";
import { PathNotAllowedError } from "../src/errors.js";
import { filesPolicyFor } from "./helpers/policy.js";

describe("loadConfig", () => {
  it("defaults to loopback and the approved public endpoint", () => {
    const config = loadConfig({ AGENT_BRIDGE_ALLOWED_ROOTS: "/Users/thief/nik" });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.publicUrl.href).toBe("https://mcp.markapidown.net/mcp");
  });

  it("rejects a non-loopback host", () => {
    expect(() => loadConfig({
      AGENT_BRIDGE_ALLOWED_ROOTS: "/Users/thief/nik",
      AGENT_BRIDGE_HOST: "0.0.0.0",
    })).toThrow("loopback");
  });
});

describe("resolveAllowedDirectory", () => {
  it("returns the canonical directory below an allowed root", async () => {
    const base = await mkdtemp(join(tmpdir(), "bridge-config-"));
    const root = join(base, "root");
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await expect(resolveAllowedDirectory(repo, filesPolicyFor(root))).resolves.toBe(await realpath(repo));
  });

  it("rejects a symlink escape", async () => {
    const base = await mkdtemp(join(tmpdir(), "bridge-config-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    const link = join(root, "escape");
    await mkdir(root); await mkdir(outside); await symlink(outside, link);
    await expect(resolveAllowedDirectory(link, filesPolicyFor(root))).rejects.toBeInstanceOf(PathNotAllowedError);
  });
});
