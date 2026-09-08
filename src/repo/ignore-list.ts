const IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "target",
  ".DS_Store",
]);

export function isEnvFileName(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

/** True if this basename should never appear in a listing or search result. */
export function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name) || isEnvFileName(name);
}
