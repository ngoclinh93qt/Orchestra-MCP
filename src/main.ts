import { join } from "node:path";
import { BridgeOAuthProvider } from "./auth/oauth-provider.js";
import { OAuthStore } from "./auth/oauth-store.js";
import { createCombinedVerifier } from "./auth/middleware.js";
import { mountAuth } from "./auth/routes.js";
import { loadConfig } from "./config.js";
import { createApp, type CreateAppAuthOptions } from "./http/app.js";
import { configFilePath, ensureConfigFile, watchConfigFile } from "./policy/config-file.js";
import { AccessPolicy, policiesEqual } from "./policy/files-policy.js";
import { ClaudeAdapter } from "./providers/claude.js";
import { CodexAdapter } from "./providers/codex.js";
import { overrideVariable, resolveProviderRuntime } from "./providers/runtime.js";
import { SessionStore } from "./sessions/session-store.js";
import { EventLog } from "./store/event-log.js";
import { TaskStore } from "./store/task-store.js";
import { JobSupervisor } from "./supervisor/job-supervisor.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const policyPath = configFilePath(config.stateDir);
  const initial = await ensureConfigFile(policyPath, config.seedAllowedRoots);
  const policy = new AccessPolicy(initial.files);
  // eslint-disable-next-line no-console
  console.log(`Access policy: ${policyPath} (${policy.files.allow.length} allowed, ${policy.files.deny.length} denied)`);
  if (policy.files.allow.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`No folders are allowed yet. Add absolute paths to files.allow in ${policyPath}.`);
  }

  const stopWatchingPolicy = watchConfigFile(policyPath, {
    onReload: (next) => {
      // Creating the file at startup produces a watch event of its own, and some editors save a
      // file more than once. Only an actual change is worth applying or logging.
      if (policiesEqual(policy.files, next.files)) return;
      policy.update(next.files);
      // eslint-disable-next-line no-console
      console.log(
        `Access policy reloaded: ${next.files.allow.length} allowed, ${next.files.deny.length} denied.`,
      );
    },
    onError: (error) => {
      // eslint-disable-next-line no-console
      console.error(`Access policy reload rejected, keeping the previous policy: ${error.message}`);
    },
  });

  const runtime = await resolveProviderRuntime(process.env);
  for (const [label, provider, command] of [
    ["Codex CLI", "codex", runtime.codexCommand],
    ["Claude Code CLI", "claude", runtime.claudeCommand],
  ] as const) {
    if (command) {
      // eslint-disable-next-line no-console
      console.log(`${label}: ${command}`);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`${label} not found; agent tasks for it will fail. Set ${overrideVariable(provider)} to its absolute path.`);
    }
  }

  const taskStore = new TaskStore(join(config.stateDir, "bridge.sqlite3"));
  const eventLog = new EventLog(join(config.stateDir, "logs"));
  const oauthStore = new OAuthStore(join(config.stateDir, "bridge.sqlite3"));
  const sessionStore = new SessionStore({ policy });

  const supervisor = new JobSupervisor({
    taskStore,
    eventLog,
    adapters: {
      codex: new CodexAdapter(runtime.codexCommand ? { command: runtime.codexCommand } : {}),
      claude: new ClaudeAdapter(runtime.claudeCommand ? { command: runtime.claudeCommand } : {}),
    },
    baseEnv: runtime.childEnv,
    policy,
    maxConcurrentTotal: config.maxConcurrentTotal,
    maxConcurrentPerProvider: config.maxConcurrentPerProvider,
    maxPromptBytes: config.maxPromptBytes,
  });

  const interrupted = supervisor.reconcileAfterRestart();
  if (interrupted > 0) {
    // eslint-disable-next-line no-console
    console.log(`Marked ${interrupted} unsupervised active task(s) as interrupted after restart.`);
  }

  let auth: CreateAppAuthOptions | undefined;
  const oauthProvider = oauthStore.isEnrolled() ? new BridgeOAuthProvider(oauthStore) : undefined;
  if (oauthProvider) {
    auth = { verifier: createCombinedVerifier(oauthStore, oauthProvider), requiredScopes: ["agent:read"] };
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "No owner enrolled yet: /mcp is unauthenticated. Run `npm run enroll-owner` before exposing this " +
        "bridge beyond loopback.",
    );
  }

  const { app, shutdown: shutdownTransports } = createApp(
    { supervisor, taskStore, eventLog, policy, sessionStore },
    {
      maxRequestBytes: config.maxPromptBytes,
      ...(auth ? { auth } : {}),
      ...(oauthProvider
        ? {
            mountExtraRoutes: (mountedApp) =>
              mountAuth(mountedApp, oauthProvider, {
                issuerUrl: config.publicUrl,
                resourceServerUrl: config.publicUrl,
              }),
          }
        : {}),
    },
  );

  const server = app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`Agent Bridge MCP listening on http://${config.host}:${config.port}/mcp`);
  });

  let shuttingDown = false;
  async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down.`);
    stopWatchingPolicy();
    supervisor.shutdown();
    await shutdownTransports();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    taskStore.close();
    oauthStore.close();
    process.exit(0);
  }

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
