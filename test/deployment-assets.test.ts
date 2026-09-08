import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderPlists } from "../scripts/render-launch-agents.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function plutilToJson(path: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", path]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function renderIntoTemp(): Promise<{ targetDir: string; stateDir: string; results: { label: string; path: string }[] }> {
  const base = await mkdtemp(join(tmpdir(), "bridge-launchagents-"));
  const targetDir = join(base, "LaunchAgents");
  const stateDir = join(base, "state");
  const results = renderPlists({
    templateDir: join(repoRoot, "config"),
    targetDir,
    nodeBin: "/usr/local/bin/node",
    projectDir: repoRoot,
    allowedRoots: "/Users/example/projects",
    stateDir,
    publicUrl: "https://mcp.markapidown.net/mcp",
    cloudflaredBin: "/opt/homebrew/bin/cloudflared",
    cloudflaredConfig: join(base, "cloudflared-config.yml"),
  });
  return { targetDir, stateDir, results };
}

describe("rendered LaunchAgent plists", () => {
  it("renders the bridge plist with loopback-safe, absolute, secret-free configuration", async () => {
    const { results, stateDir } = await renderIntoTemp();
    const bridgePlist = results.find((r) => r.label === "net.markapidown.agent-bridge")!;
    const plist = await plutilToJson(bridgePlist.path);

    expect(plist.Label).toBe("net.markapidown.agent-bridge");
    expect(plist.RunAtLoad).toBe(true);
    const keepAlive = plist.KeepAlive as { SuccessfulExit: boolean; Crashed: boolean };
    expect(keepAlive.Crashed).toBe(true);
    expect(keepAlive.SuccessfulExit).toBe(false);

    const args = plist.ProgramArguments as string[];
    for (const arg of args) expect(arg.startsWith("/")).toBe(true);

    expect(plist.StandardOutPath).toBe(`${stateDir}/logs/agent-bridge.stdout.log`);
    expect(plist.StandardErrorPath).toBe(`${stateDir}/logs/agent-bridge.stderr.log`);

    const env = plist.EnvironmentVariables as Record<string, string>;
    const dump = JSON.stringify(env).toLowerCase();
    expect(dump).not.toMatch(/token|secret|api[_-]?key/);
  });

  it("renders the tunnel plist pointing at an absolute cloudflared binary and config", async () => {
    const { results } = await renderIntoTemp();
    const tunnelPlist = results.find((r) => r.label === "net.markapidown.agent-tunnel")!;
    const plist = await plutilToJson(tunnelPlist.path);

    expect(plist.Label).toBe("net.markapidown.agent-tunnel");
    expect(plist.RunAtLoad).toBe(true);
    const args = plist.ProgramArguments as string[];
    expect(args[0]).toBe("/opt/homebrew/bin/cloudflared");
    for (const arg of args) if (arg.includes("/")) expect(arg.startsWith("/")).toBe(true);
  });

  it("renders byte-identical output across repeated runs into the same directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "bridge-launchagents-idempotent-"));
    const targetDir = join(base, "LaunchAgents");
    const options = {
      templateDir: join(repoRoot, "config"),
      targetDir,
      nodeBin: "/usr/local/bin/node",
      projectDir: repoRoot,
      allowedRoots: "/Users/example/projects",
      stateDir: join(base, "state"),
      publicUrl: "https://mcp.markapidown.net/mcp",
      cloudflaredBin: "/opt/homebrew/bin/cloudflared",
      cloudflaredConfig: join(base, "cloudflared-config.yml"),
    };

    const first = renderPlists(options);
    const firstContent = await Promise.all(first.map((r) => readFile(r.path, "utf8")));
    const second = renderPlists(options);
    const secondContent = await Promise.all(second.map((r) => readFile(r.path, "utf8")));

    expect(secondContent).toEqual(firstContent);
  });
});

describe("cloudflared example config", () => {
  it("routes the public hostname to the loopback bridge and ends with a 404 catch-all", () => {
    const content = readFileSync(join(repoRoot, "config", "cloudflared.example.yml"), "utf8");
    expect(content).toContain("hostname: mcp.markapidown.net");
    expect(content).toContain("service: http://127.0.0.1:8787");

    const ingressBlock = content.slice(content.indexOf("ingress:"));
    const serviceLines = [...ingressBlock.matchAll(/^\s*(?:-\s*)?service:\s*(.+)$/gm)].map((m) => m[1]!.trim());
    expect(serviceLines.at(-1)).toBe("http_status:404");
  });

  it("never invites a Quick Tunnel for the completed setup", () => {
    const content = readFileSync(join(repoRoot, "config", "cloudflared.example.yml"), "utf8");
    expect(content.toLowerCase()).not.toContain("trycloudflare.com");
  });
});

describe("install/uninstall scripts", () => {
  async function makeFakeLaunchctl(binDir: string, logPath: string): Promise<void> {
    const script = `#!/usr/bin/env bash\necho "launchctl $*" >> "${logPath}"\nexit 0\n`;
    const path = join(binDir, "launchctl");
    await writeFile(path, script);
    await chmod(path, 0o755);
  }

  /**
   * A launchctl stand-in whose `bootstrap` fails with the real, observed transient error
   * (bootout hasn't finished releasing the label yet) for the first `failCount` calls per
   * label, then succeeds — reproducing the exact race that install-services.sh must retry
   * through rather than leave a service down.
   */
  async function makeFlakyFakeLaunchctl(binDir: string, logPath: string, countersDir: string, failCount: number): Promise<void> {
    const script = `#!/usr/bin/env bash
echo "launchctl $*" >> "${logPath}"
if [ "$1" = "bootstrap" ]; then
  LABEL="$(basename "$3" .plist)"
  COUNTER_FILE="${countersDir}/$LABEL.count"
  COUNT=0
  [ -f "$COUNTER_FILE" ] && COUNT="$(cat "$COUNTER_FILE")"
  COUNT=$((COUNT + 1))
  echo "$COUNT" > "$COUNTER_FILE"
  if [ "$COUNT" -le ${failCount} ]; then
    echo "launchctl: Input/output error" >&2
    exit 5
  fi
fi
exit 0
`;
    const path = join(binDir, "launchctl");
    await writeFile(path, script);
    await chmod(path, 0o755);
  }

  it("is idempotent: installing twice ends with both labels bootstrapped and no error", async () => {
    const base = await mkdtemp(join(tmpdir(), "bridge-install-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const stateDir = join(base, "state");
    const fakeBinDir = join(base, "fakebin");
    const logPath = join(base, "launchctl.log");
    await mkdir(fakeBinDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await makeFakeLaunchctl(fakeBinDir, logPath);

    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      LAUNCH_AGENTS_DIR: launchAgentsDir,
      AGENT_BRIDGE_ALLOWED_ROOTS: base,
      AGENT_BRIDGE_STATE_DIR: stateDir,
    };

    await execFileAsync("bash", [join(repoRoot, "scripts", "install-services.sh")], { env });
    await execFileAsync("bash", [join(repoRoot, "scripts", "install-services.sh")], { env });

    expect(existsSync(join(launchAgentsDir, "net.markapidown.agent-bridge.plist"))).toBe(true);
    expect(existsSync(join(launchAgentsDir, "net.markapidown.agent-tunnel.plist"))).toBe(true);

    const log = await readFile(logPath, "utf8");
    const bootstrapCalls = log.split("\n").filter((line) => line.includes("bootstrap"));
    expect(bootstrapCalls.length).toBe(4); // 2 labels x 2 install runs
    expect(log).toContain("net.markapidown.agent-bridge");
    expect(log).toContain("net.markapidown.agent-tunnel");
  }, 30000);

  it("retries through a transient bootstrap EIO instead of leaving a service down", async () => {
    const base = await mkdtemp(join(tmpdir(), "bridge-install-flaky-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const stateDir = join(base, "state");
    const fakeBinDir = join(base, "fakebin");
    const countersDir = join(base, "counters");
    const logPath = join(base, "launchctl.log");
    await mkdir(fakeBinDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await mkdir(countersDir, { recursive: true });
    await makeFlakyFakeLaunchctl(fakeBinDir, logPath, countersDir, 2);

    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      LAUNCH_AGENTS_DIR: launchAgentsDir,
      AGENT_BRIDGE_ALLOWED_ROOTS: base,
      AGENT_BRIDGE_STATE_DIR: stateDir,
    };

    await execFileAsync("bash", [join(repoRoot, "scripts", "install-services.sh")], { env });

    const log = await readFile(logPath, "utf8");
    const bootstrapAttempts = log.split("\n").filter((line) => line.includes("bootstrap"));
    // 2 labels, each failing twice before succeeding on the 3rd attempt.
    expect(bootstrapAttempts.length).toBe(6);
  }, 30000);

  it("uninstall removes the plists and unloads both labels but never touches bridge state", async () => {
    const base = await mkdtemp(join(tmpdir(), "bridge-uninstall-"));
    const launchAgentsDir = join(base, "LaunchAgents");
    const stateDir = join(base, "state");
    const fakeBinDir = join(base, "fakebin");
    const logPath = join(base, "launchctl.log");
    await mkdir(fakeBinDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await makeFakeLaunchctl(fakeBinDir, logPath);

    const sentinel = join(stateDir, "bridge.sqlite3");
    await writeFile(sentinel, "not a real database, just a marker");

    const env = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      LAUNCH_AGENTS_DIR: launchAgentsDir,
      AGENT_BRIDGE_ALLOWED_ROOTS: base,
      AGENT_BRIDGE_STATE_DIR: stateDir,
    };

    await execFileAsync("bash", [join(repoRoot, "scripts", "install-services.sh")], { env });
    await execFileAsync("bash", [join(repoRoot, "scripts", "uninstall-services.sh")], { env });

    expect(existsSync(join(launchAgentsDir, "net.markapidown.agent-bridge.plist"))).toBe(false);
    expect(existsSync(join(launchAgentsDir, "net.markapidown.agent-tunnel.plist"))).toBe(false);

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("bootout");

    // The whole point of a recoverable rollback: state survives uninstall untouched.
    expect(existsSync(sentinel)).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("not a real database, just a marker");
  }, 30000);
});

describe("script hygiene", () => {
  it.each(["install-cloudflared.sh", "install-services.sh", "uninstall-services.sh"])(
    "%s uses strict mode and passes a shell syntax check",
    async (name) => {
      const path = join(repoRoot, "scripts", name);
      const content = readFileSync(path, "utf8");
      expect(content).toContain("set -euo pipefail");
      await expect(execFileAsync("bash", ["-n", path])).resolves.toBeDefined();
    },
  );
});
