import { readFileSync, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/mcp/tool-schemas.js";
import { renderPluginMcpConfig } from "../scripts/render-launch-agents.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

interface MarketplacePluginEntry {
  readonly name: string;
  readonly source: { readonly source: string; readonly path: string };
}

interface MarketplaceManifest {
  readonly name: string;
  readonly plugins: readonly MarketplacePluginEntry[];
}

interface PluginManifest {
  readonly name: string;
  readonly mcpServers: string;
  readonly skills: string;
}

interface McpServersFile {
  readonly mcpServers: Record<string, { readonly type: string; readonly url: string; readonly oauth_resource?: string }>;
}

const TRACKED_PLUGIN_FILES = [
  ".agents/plugins/marketplace.json",
  "plugins/agent-bridge/.codex-plugin/plugin.json",
  "plugins/agent-bridge/.mcp.json.template",
  "plugins/agent-bridge/skills/agent-bridge/SKILL.md",
  "config/codex.local.example.toml",
  "docs/CONNECT_CHATGPT.md",
];

describe("plugin package manifests", () => {
  it("parses the marketplace manifest and references exactly the agent-bridge plugin", () => {
    const manifest = readJson(".agents/plugins/marketplace.json") as MarketplaceManifest;
    expect(manifest.plugins).toHaveLength(1);
    const entry = manifest.plugins[0]!;
    expect(entry.name).toBe("agent-bridge");
    expect(entry.source.source).toBe("local");
    expect(entry.source.path).toBe("./plugins/agent-bridge");
  });

  it("resolves the marketplace's plugin path to a real directory", () => {
    const manifest = readJson(".agents/plugins/marketplace.json") as MarketplaceManifest;
    const pluginPath = manifest.plugins[0]!.source.path;
    // Verified against the real Codex CLI: a plugin path is relative to the marketplace
    // *source root* (the argument to `codex plugin marketplace add`), not to marketplace.json's
    // own directory — so this resolves from the repo root, not from .agents/plugins/.
    expect(existsSync(join(repoRoot, pluginPath))).toBe(true);
    expect(existsSync(join(repoRoot, pluginPath, ".codex-plugin", "plugin.json"))).toBe(true);
  });

  it("parses plugin.json and points at real, existing mcpServers and skills paths", () => {
    const plugin = readJson("plugins/agent-bridge/.codex-plugin/plugin.json") as PluginManifest;
    expect(plugin.name).toBe("agent-bridge");
    expect(plugin.mcpServers).toBe("./.mcp.json");
    expect(plugin.skills).toBe("./skills/");

    const pluginDir = join(repoRoot, "plugins", "agent-bridge");
    // `.mcp.json` itself is rendered per deployment (it carries that machine's public URL) and
    // is git-ignored, so what ships in the repository is its template.
    expect(existsSync(join(pluginDir, `${plugin.mcpServers}.template`))).toBe(true);
    expect(existsSync(join(pluginDir, plugin.skills, "agent-bridge", "SKILL.md"))).toBe(true);
  });

  it("renders this deployment's own public URL into the plugin's MCP config", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "bridge-plugin-render-"));
    const pluginDir = join(projectDir, "plugins", "agent-bridge");
    await mkdir(pluginDir, { recursive: true });
    await copyFile(
      join(repoRoot, "plugins", "agent-bridge", ".mcp.json.template"),
      join(pluginDir, ".mcp.json.template"),
    );

    const rendered = renderPluginMcpConfig(projectDir, "https://mcp.example.com/mcp");

    const mcp = JSON.parse(readFileSync(rendered, "utf8")) as McpServersFile;
    const server = mcp.mcpServers["agent-bridge"];
    expect(server).toBeDefined();
    expect(server!.type).toBe("http");
    expect(server!.url).toBe("https://mcp.example.com/mcp");
    expect(server!.oauth_resource).toBe("https://mcp.example.com/mcp");
  });

  it("never declares an auto-approval override for any tool", () => {
    // Approval is decided by the MCP client from each tool's readOnlyHint annotation
    // (src/mcp/tool-schemas.ts); nothing in the plugin package should try to short-circuit that.
    // This looks for config-key-shaped strings, not prose (plugin.json's own description text
    // says it "never bypasses" sandboxing — a real match there would be a false positive).
    const pluginRaw = readFileSync(join(repoRoot, "plugins/agent-bridge/.codex-plugin/plugin.json"), "utf8");
    const mcpRaw = readFileSync(join(repoRoot, "plugins/agent-bridge/.mcp.json.template"), "utf8");
    const overridePattern = /auto[_-]?approve|skip[_-]?approval|bypass[_-]?(approval|permission)/i;
    for (const raw of [pluginRaw, mcpRaw]) {
      expect(raw).not.toMatch(overridePattern);
    }
  });

  it("agrees with the live tool schemas about which tools mutate state", () => {
    const writers = TOOL_DEFINITIONS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
    expect(writers.sort()).toEqual(["agent_cancel", "agent_continue", "agent_start"]);
  });
});

describe("no credentials in tracked plugin/docs files", () => {
  const SECRET_PATTERN = /(bearer [a-z0-9._-]{16,}|api[_-]?key\s*[:=]|tunnel[_-]?token|client[_-]?secret\s*[:=])/i;

  it.each(TRACKED_PLUGIN_FILES)("%s contains no credential-looking string", (relativePath) => {
    const content = readFileSync(join(repoRoot, relativePath), "utf8");
    expect(content).not.toMatch(SECRET_PATTERN);
  });
});
