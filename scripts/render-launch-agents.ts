import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

export interface RenderOptions {
  readonly templateDir: string;
  readonly targetDir: string;
  readonly nodeBin: string;
  readonly projectDir: string;
  readonly allowedRoots: string;
  readonly stateDir: string;
  readonly publicUrl: string;
  readonly cloudflaredBin: string;
  readonly cloudflaredConfig: string;
  readonly ingress: IngressProfile;
}

export type IngressProfile = "cloudflare" | "external";

export interface RenderedPlist {
  readonly label: string;
  readonly path: string;
}

interface Template {
  readonly file: string;
  readonly label: string;
}

const TEMPLATES: readonly Template[] = [
  { file: "local.agent-bridge.bridge.plist.template", label: "local.agent-bridge.bridge" },
  { file: "local.agent-bridge.tunnel.plist.template", label: "local.agent-bridge.tunnel" },
];

export function parseIngressProfile(value: string | undefined): IngressProfile {
  const profile = value ?? "cloudflare";
  if (profile === "cloudflare" || profile === "external") return profile;
  throw new Error(`AGENT_BRIDGE_INGRESS must be "cloudflare" or "external", got: ${profile}`);
}

/**
 * Renders the bridge plist and, for the Cloudflare profile, its managed tunnel plist into
 * `targetDir`. Each file is written via a temp file plus atomic rename so a reader never
 * observes a half-written plist. Rendering twice produces byte-identical output.
 */
export function renderPlists(options: RenderOptions): RenderedPlist[] {
  const substitutions: Readonly<Record<string, string>> = {
    __NODE_BIN__: options.nodeBin,
    __PROJECT_DIR__: options.projectDir,
    __ALLOWED_ROOTS__: options.allowedRoots,
    __STATE_DIR__: options.stateDir,
    __PUBLIC_URL__: options.publicUrl,
    __CLOUDFLARED_BIN__: options.cloudflaredBin,
    __CLOUDFLARED_CONFIG__: options.cloudflaredConfig,
  };

  mkdirSync(options.targetDir, { recursive: true });

  const templates = options.ingress === "cloudflare" ? TEMPLATES : TEMPLATES.slice(0, 1);
  return templates.map((template) => {
    const templatePath = join(options.templateDir, template.file);
    let content = readFileSync(templatePath, "utf8");
    for (const [placeholder, value] of Object.entries(substitutions)) {
      content = content.split(placeholder).join(value);
    }

    const finalPath = join(options.targetDir, `${template.label}.plist`);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, content, { mode: 0o644 });
    renameSync(tmpPath, finalPath);
    return { label: template.label, path: finalPath };
  });
}

/**
 * Renders the Codex plugin's `.mcp.json` from its template. The rendered file carries this
 * deployment's own public URL, so it is git-ignored rather than committed — the repository keeps
 * only the template.
 */
export function renderPluginMcpConfig(projectDir: string, publicUrl: string): string {
  const pluginDir = join(projectDir, "plugins", "agent-bridge");
  const template = readFileSync(join(pluginDir, ".mcp.json.template"), "utf8");
  const finalPath = join(pluginDir, ".mcp.json");
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, template.split("__PUBLIC_URL__").join(publicUrl), { mode: 0o644 });
  renameSync(tmpPath, finalPath);
  return finalPath;
}

function findCloudflaredBin(): string {
  for (const candidate of ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]) {
    if (existsSync(candidate)) return candidate;
  }
  // launchd runs with a minimal PATH, so a bare command name is unreliable there; this is a
  // last-resort fallback for a machine where neither common Homebrew prefix has cloudflared yet.
  return "cloudflared";
}

function main(): void {
  const config = loadConfig(process.env);
  const projectDir = process.env.RENDER_PROJECT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const targetDir = process.env.RENDER_TARGET_DIR ?? join(homedir(), "Library", "LaunchAgents");
  const nodeBin = process.env.RENDER_NODE_BIN ?? process.execPath;
  const cloudflaredBin = process.env.RENDER_CLOUDFLARED_BIN ?? findCloudflaredBin();
  const cloudflaredConfig = process.env.RENDER_CLOUDFLARED_CONFIG ?? join(homedir(), ".cloudflared", "config.yml");
  const ingress = parseIngressProfile(process.env.AGENT_BRIDGE_INGRESS);

  const results = renderPlists({
    templateDir: join(projectDir, "config"),
    targetDir,
    nodeBin,
    projectDir,
    allowedRoots: config.seedAllowedRoots.join(":"),
    stateDir: config.stateDir,
    publicUrl: config.publicUrl.toString(),
    cloudflaredBin,
    cloudflaredConfig,
    ingress,
  });

  for (const result of results) {
    // eslint-disable-next-line no-console
    console.log(`Rendered ${result.label} -> ${result.path}`);
  }

  const mcpPath = renderPluginMcpConfig(projectDir, config.publicUrl.toString());
  // eslint-disable-next-line no-console
  console.log(`Rendered plugin MCP config -> ${mcpPath}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isMain) main();
