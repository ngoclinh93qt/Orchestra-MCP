import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseFilesPolicy, PolicyValidationError, type FilesPolicy } from "./files-policy.js";
import {
  DEFAULT_PROVIDER_POLICIES,
  parseExecutionProfiles,
  parseProviderPolicies,
  type ExecutionProfile,
  type ProviderPolicies,
} from "./execution-profiles.js";

export const CONFIG_FILE_NAME = "config.json";

export interface BridgeFileConfig {
  readonly files: FilesPolicy;
  /** Omitted only by old callers; parsed config is always version 2. */
  readonly version?: 2;
  readonly providers?: ProviderPolicies;
  readonly profiles?: readonly ExecutionProfile[];
}

/** Explains the file to whoever opens it, since JSON has no comments. Ignored by the parser. */
const README_LINES: readonly string[] = [
  "Agent Bridge MCP access policy. Edited by you, never by a connected client.",
  "files.allow: absolute paths the bridge may read and run agents in.",
  "files.deny: absolute paths carved back out of the above. Deny wins over allow.",
  "Saving this file applies the change immediately; no restart is needed.",
];

export function configFilePath(stateDir: string): string {
  return join(stateDir, CONFIG_FILE_NAME);
}

export function parseConfig(text: string): BridgeFileConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PolicyValidationError(`config is not valid JSON: ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PolicyValidationError("config must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  if (record.files === undefined) throw new PolicyValidationError("config must contain a files section");
  const providers = parseProviderPolicies(record.providers);
  return Object.freeze({
    version: 2 as const,
    files: parseFilesPolicy(record.files),
    providers,
    profiles: parseExecutionProfiles(record.profiles ?? [], providers),
  });
}

export function serializeConfig(config: BridgeFileConfig): string {
  return `${JSON.stringify(
    {
      version: 2,
      _readme: README_LINES,
      files: { allow: [...config.files.allow], deny: [...config.files.deny] },
      providers: config.providers ?? DEFAULT_PROVIDER_POLICIES,
      profiles: config.profiles ?? [],
    },
    null,
    2,
  )}\n`;
}

export async function readConfigFile(path: string): Promise<BridgeFileConfig> {
  return parseConfig(await readFile(path, "utf8"));
}

/** Writes via a temp file plus rename, so a reader (or the watcher) never sees a partial config. */
async function writeConfigAtomically(path: string, config: BridgeFileConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, serializeConfig(config), { mode: 0o600 });
  await rename(tmpPath, path);
}

/**
 * Returns the config at `path`, creating it first if it does not exist yet.
 *
 * A new file is seeded from `seedAllow` — the legacy `AGENT_BRIDGE_ALLOWED_ROOTS` environment
 * variable — purely so an existing deployment keeps the access it already had across the upgrade.
 * Once the file exists it is the only source of truth; the environment variable is never consulted
 * again, and editing it has no effect.
 */
export async function ensureConfigFile(path: string, seedAllow: readonly string[]): Promise<BridgeFileConfig> {
  try {
    return await readConfigFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const seeded: BridgeFileConfig = { files: { allow: [...seedAllow], deny: [] } };
  await writeConfigAtomically(path, seeded);
  return readConfigFile(path);
}

export interface WatchConfigHandlers {
  readonly onReload: (config: BridgeFileConfig) => void;
  readonly onError: (error: Error) => void;
}

/** Coalesces the burst of events a single save produces into one reload. */
const RELOAD_DEBOUNCE_MS = 150;

/**
 * Watches the config file for changes and reports each valid reload.
 *
 * Watches the containing *directory* rather than the file itself: editors and the atomic write
 * above both replace the file by rename, which severs a watch bound to the original inode. A
 * reload that fails to parse or validate calls `onError` and is otherwise ignored, leaving the
 * previously loaded policy in force — a malformed edit must never widen access, and must never
 * take the bridge down either.
 */
export function watchConfigFile(path: string, handlers: WatchConfigHandlers): () => void {
  const targetName = basename(path);
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const reload = (): void => {
    void readConfigFile(path).then(
      (config) => {
        if (!closed) handlers.onReload(config);
      },
      (error: unknown) => {
        if (!closed) handlers.onError(error as Error);
      },
    );
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename !== null && basename(filename) !== targetName) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, RELOAD_DEBOUNCE_MS);
    });
  } catch (error) {
    handlers.onError(error as Error);
    return () => undefined;
  }

  watcher.on("error", (error) => {
    if (!closed) handlers.onError(error);
  });

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
