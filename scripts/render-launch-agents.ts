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
}

export interface RenderedPlist {
  readonly label: string;
  readonly path: string;
}

interface Template {
  readonly file: string;
  readonly label: string;
}

const TEMPLATES: readonly Template[] = [
  { file: "net.markapidown.agent-bridge.plist.template", label: "net.markapidown.agent-bridge" },
  { file: "net.markapidown.agent-tunnel.plist.template", label: "net.markapidown.agent-tunnel" },
];

/**
 * Renders both LaunchAgent plists from their templates into `targetDir`, writing each via a
 * temp file plus atomic rename so a reader never observes a half-written plist. Idempotent:
 * rendering twice into the same directory produces byte-identical output both times.
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

  return TEMPLATES.map((template) => {
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
  });

  for (const result of results) {
    // eslint-disable-next-line no-console
    console.log(`Rendered ${result.label} -> ${result.path}`);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isMain) main();
