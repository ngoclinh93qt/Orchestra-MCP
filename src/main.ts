import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { ClaudeAdapter } from "./providers/claude.js";
import { CodexAdapter } from "./providers/codex.js";
import { EventLog } from "./store/event-log.js";
import { TaskStore } from "./store/task-store.js";
import { JobSupervisor } from "./supervisor/job-supervisor.js";

function main(): void {
  const config = loadConfig(process.env);

  const taskStore = new TaskStore(join(config.stateDir, "bridge.sqlite3"));
  const eventLog = new EventLog(join(config.stateDir, "logs"));

  const supervisor = new JobSupervisor({
    taskStore,
    eventLog,
    adapters: { codex: new CodexAdapter(), claude: new ClaudeAdapter() },
    allowedRoots: config.allowedRoots,
    maxConcurrentTotal: config.maxConcurrentTotal,
    maxConcurrentPerProvider: config.maxConcurrentPerProvider,
    maxPromptBytes: config.maxPromptBytes,
  });

  const interrupted = supervisor.reconcileAfterRestart();
  if (interrupted > 0) {
    // eslint-disable-next-line no-console
    console.log(`Marked ${interrupted} unsupervised active task(s) as interrupted after restart.`);
  }

  const { app, shutdown: shutdownTransports } = createApp(
    { supervisor, taskStore, eventLog },
    { maxRequestBytes: config.maxPromptBytes },
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
    supervisor.shutdown();
    await shutdownTransports();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    taskStore.close();
    process.exit(0);
  }

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
}

main();
