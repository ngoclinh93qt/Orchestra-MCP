import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { Provider } from "../domain/task.js";

/**
 * Finding the provider CLIs, and the environment they run in, when the bridge itself runs under
 * launchd.
 *
 * A LaunchAgent starts with PATH `/usr/bin:/bin:/usr/sbin:/sbin` and nothing from the owner's
 * shell profile, so neither CLI is reachable by bare name: Claude Code installs to
 * `~/.local/bin`, and the Codex CLI ships inside the ChatGPT desktop app's bundle. Both are
 * resolved to absolute paths once at startup instead.
 */

/** The only parent variables a provider process inherits; everything else is withheld. */
const INHERITED_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Relocated provider state directories, when the owner uses them.
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
] as const;

/** launchd's own default PATH, used when the parent has none at all. */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const OVERRIDE_ENV: Readonly<Record<Provider, string>> = {
  codex: "AGENT_BRIDGE_CODEX_BIN",
  claude: "AGENT_BRIDGE_CLAUDE_BIN",
};

/** Where each CLI's standard installers put it, checked after PATH. */
export function defaultCandidates(home: string): Readonly<Record<Provider, readonly string[]>> {
  return {
    codex: [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      join(home, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ],
    claude: [
      join(home, ".local", "bin", "claude"),
      join(home, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ],
  };
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export interface LocateOptions {
  /** An owner-supplied absolute path. When set it is the only thing considered. */
  readonly override?: string | undefined;
  readonly pathEnv: string | undefined;
  readonly candidates: readonly string[];
}

/** Resolves a CLI to an absolute executable path: override, else PATH, else known locations. */
export async function locateCommand(name: string, options: LocateOptions): Promise<string | undefined> {
  if (options.override !== undefined) {
    return isAbsolute(options.override) && (await isExecutableFile(options.override)) ? options.override : undefined;
  }
  const onPath = (options.pathEnv ?? "").split(delimiter).filter(isAbsolute).map((dir) => join(dir, name));
  for (const path of [...onPath, ...options.candidates]) {
    if (await isExecutableFile(path)) return path;
  }
  return undefined;
}

/**
 * The environment a provider process runs with: the allowlisted parent variables, plus a PATH
 * with `extraPathDirs` ahead of the inherited one. Agents run node, npm, git and whatever else
 * the owner installed, so launchd's bare system PATH is not enough for them to do real work.
 */
export function buildChildEnv(
  source: NodeJS.ProcessEnv,
  extraPathDirs: readonly string[],
  fallbackHome: string = homedir(),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  env.HOME ??= fallbackHome;

  const inherited = source.PATH ? source.PATH.split(delimiter) : SYSTEM_PATH;
  env.PATH = [...new Set([...extraPathDirs, ...inherited].filter(Boolean))].join(delimiter);
  return env;
}

export interface ProviderRuntime {
  readonly codexCommand: string | undefined;
  readonly claudeCommand: string | undefined;
  readonly childEnv: Readonly<Record<string, string>>;
}

export interface ResolveRuntimeOptions {
  /** The running node binary; its directory gives agents the same node/npm the bridge uses. */
  readonly execPath?: string;
  readonly candidates?: Readonly<Record<Provider, readonly string[]>>;
}

export async function resolveProviderRuntime(
  env: NodeJS.ProcessEnv,
  options: ResolveRuntimeOptions = {},
): Promise<ProviderRuntime> {
  const home = env.HOME || homedir();
  const candidates = options.candidates ?? defaultCandidates(home);
  const locate = (provider: Provider): Promise<string | undefined> =>
    locateCommand(provider, {
      override: env[OVERRIDE_ENV[provider]] || undefined,
      pathEnv: env.PATH,
      candidates: candidates[provider],
    });

  const extraPathDirs = [
    dirname(options.execPath ?? process.execPath),
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];

  return {
    codexCommand: await locate("codex"),
    claudeCommand: await locate("claude"),
    childEnv: Object.freeze(buildChildEnv(env, extraPathDirs, home)),
  };
}

/** The variable an owner sets to point the bridge at a CLI it cannot find on its own. */
export function overrideVariable(provider: Provider): string {
  return OVERRIDE_ENV[provider];
}

/** Tells whoever reads a spawn ENOENT what the owner has to do about it. */
export function notFoundHint(provider: Provider): string {
  return (
    `The bridge found no ${provider} executable on its PATH or in the usual install locations; ` +
    `set ${OVERRIDE_ENV[provider]} to its absolute path and restart the bridge.`
  );
}
