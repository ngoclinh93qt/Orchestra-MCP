import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { PathNotAllowedError } from "./errors.js";
import { containsPath, isDeniedPath, type FilesPolicy } from "./policy/files-policy.js";

export type BridgeConfig = Readonly<{
  host: "127.0.0.1";
  port: number;
  stateDir: string;
  /**
   * Legacy `AGENT_BRIDGE_ALLOWED_ROOTS`, used only to seed `config.json` the first time it is
   * created. Once that file exists it is the sole source of truth for file access; this value is
   * never consulted again. Empty when the variable is unset.
   */
  seedAllowedRoots: readonly string[];
  publicUrl: URL;
  maxConcurrentTotal: number;
  maxConcurrentPerProvider: number;
  maxPromptBytes: number;
}>;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const host = env.AGENT_BRIDGE_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("Agent Bridge host must be loopback 127.0.0.1");
  const roots = (env.AGENT_BRIDGE_ALLOWED_ROOTS ?? "").split(":").filter(Boolean);
  if (roots.some((root) => !isAbsolute(root))) {
    throw new Error("AGENT_BRIDGE_ALLOWED_ROOTS must contain absolute paths");
  }
  const publicUrl = new URL(env.AGENT_BRIDGE_PUBLIC_URL ?? "https://mcp.markapidown.net/mcp");
  if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/mcp") {
    throw new Error("Public URL must be an HTTPS /mcp endpoint");
  }
  return Object.freeze({
    host,
    port: positiveInteger(env.AGENT_BRIDGE_PORT, 8787, "AGENT_BRIDGE_PORT"),
    stateDir: resolve(env.AGENT_BRIDGE_STATE_DIR ?? `${homedir()}/Library/Application Support/Agent Bridge MCP`),
    seedAllowedRoots: Object.freeze([...roots]),
    publicUrl,
    maxConcurrentTotal: positiveInteger(env.AGENT_BRIDGE_MAX_CONCURRENT_TOTAL, 2, "max total concurrency"),
    maxConcurrentPerProvider: positiveInteger(env.AGENT_BRIDGE_MAX_CONCURRENT_PER_PROVIDER, 1, "max provider concurrency"),
    maxPromptBytes: positiveInteger(env.AGENT_BRIDGE_MAX_PROMPT_BYTES, 131072, "max prompt bytes"),
  });
}

/**
 * Resolves a working directory against the owner's file policy. Shared by `agent_start` and, via
 * `resolveAllowedDirectoryStrict`, by the read tools — so a denied folder can be neither read
 * directly nor handed to an agent as its working directory.
 */
export async function resolveAllowedDirectory(requested: string, policy: FilesPolicy): Promise<string> {
  if (!isAbsolute(requested)) throw new PathNotAllowedError("Working directory must be absolute");
  const canonical = await realpath(requested);
  if (!(await stat(canonical)).isDirectory()) throw new PathNotAllowedError("Working path is not a directory");
  for (const root of policy.allow) {
    const canonicalRoot = await realpath(root);
    if (!containsPath(canonicalRoot, canonical)) continue;
    if (await isDeniedPath(canonical, policy.deny)) {
      throw new PathNotAllowedError("Working directory is inside a denied path");
    }
    return canonical;
  }
  throw new PathNotAllowedError("Working directory is outside allowed roots");
}
