import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configFilePath,
  ensureConfigFile,
  parseConfig,
  readConfigFile,
  serializeConfig,
  watchConfigFile,
  type BridgeFileConfig,
} from "../../src/policy/config-file.js";
import { PolicyValidationError } from "../../src/policy/files-policy.js";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bridge-policy-"));
}

/** Saves the way an editor does — write a temp file, then rename over the target. */
async function saveAtomically(path: string, config: BridgeFileConfig): Promise<void> {
  const tmpPath = `${path}.editor-tmp`;
  await writeFile(tmpPath, serializeConfig(config));
  await rename(tmpPath, path);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Performs `act` until `read` yields a value.
 *
 * A freshly created `fs.watch` takes a moment to arm on macOS, so a save issued immediately after
 * the watch is established can be missed entirely — reliably so when the machine is busy running
 * the rest of the suite. Repeating the save until the watcher reacts tests the steady-state
 * behavior that matters without depending on an arbitrary startup delay.
 */
async function waitForAfter<T>(act: () => Promise<void>, read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await act();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const value = read();
      if (value !== undefined) return value;
      await sleep(25);
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for a config event");
  }
}

describe("parseConfig", () => {
  it("reads a valid config", () => {
    const config = parseConfig('{"files":{"allow":["/a"],"deny":["/a/x"]}}');
    expect(config.files.allow).toEqual(["/a"]);
    expect(config.files.deny).toEqual(["/a/x"]);
  });

  it("ignores the explanatory _readme key", () => {
    expect(parseConfig('{"_readme":["anything"],"files":{"allow":["/a"]}}').files.allow).toEqual(["/a"]);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseConfig("{not json")).toThrow(PolicyValidationError);
  });

  it("rejects a config with no files section", () => {
    expect(() => parseConfig('{"other":1}')).toThrow(PolicyValidationError);
  });

  it("rejects a top-level array", () => {
    expect(() => parseConfig("[]")).toThrow(PolicyValidationError);
  });
});

describe("ensureConfigFile", () => {
  it("creates a config seeded from the legacy environment roots", async () => {
    const path = configFilePath(await freshDir());
    const created = await ensureConfigFile(path, ["/Users/example/projects"]);
    expect(created.files.allow).toEqual(["/Users/example/projects"]);
    expect(created.files.deny).toEqual([]);
    await expect(readConfigFile(path)).resolves.toEqual(created);
  });

  it("creates a fail-closed config when there is nothing to seed from", async () => {
    const path = configFilePath(await freshDir());
    expect((await ensureConfigFile(path, [])).files.allow).toEqual([]);
  });

  it("writes a file that explains itself", async () => {
    const path = configFilePath(await freshDir());
    await ensureConfigFile(path, ["/a"]);
    expect(await readFile(path, "utf8")).toContain("_readme");
  });

  it("leaves an existing config untouched, ignoring the seed entirely", async () => {
    const path = configFilePath(await freshDir());
    await ensureConfigFile(path, ["/first"]);
    const second = await ensureConfigFile(path, ["/second-should-be-ignored"]);
    expect(second.files.allow).toEqual(["/first"]);
  });

  it("surfaces a genuinely invalid existing config rather than overwriting it", async () => {
    const path = configFilePath(await freshDir());
    await writeFile(path, "{oops");
    await expect(ensureConfigFile(path, ["/a"])).rejects.toBeInstanceOf(PolicyValidationError);
  });
});

describe("watchConfigFile", () => {
  it("reports a policy change saved by an atomic rename", async () => {
    const path = configFilePath(await freshDir());
    await ensureConfigFile(path, ["/a"]);

    let latest: BridgeFileConfig | undefined;
    const stop = watchConfigFile(path, { onReload: (config) => void (latest = config), onError: () => undefined });
    try {
      const reloaded = await waitForAfter(
        () => saveAtomically(path, { files: { allow: ["/a", "/b"], deny: ["/b/secrets"] } }),
        () => latest,
      );
      expect(reloaded.files.allow).toEqual(["/a", "/b"]);
      expect(reloaded.files.deny).toEqual(["/b/secrets"]);
    } finally {
      stop();
    }
  });

  it("reports an error and no reload when the saved config is invalid", async () => {
    const path = configFilePath(await freshDir());
    await ensureConfigFile(path, ["/a"]);

    let reloads = 0;
    let failure: Error | undefined;
    const stop = watchConfigFile(path, {
      onReload: () => void (reloads += 1),
      onError: (error) => void (failure = error),
    });
    try {
      await waitForAfter(
        () => writeFile(path, '{"files":{"allow":["not-absolute"]}}'),
        () => failure,
      );
      expect(reloads).toBe(0);
    } finally {
      stop();
    }
  });

  it("stops reporting once stopped", async () => {
    const path = configFilePath(await freshDir());
    await ensureConfigFile(path, ["/a"]);

    let reloads = 0;
    const stop = watchConfigFile(path, { onReload: () => void (reloads += 1), onError: () => undefined });
    stop();
    await saveAtomically(path, { files: { allow: ["/changed"], deny: [] } });
    await sleep(400);
    expect(reloads).toBe(0);
  });
});
