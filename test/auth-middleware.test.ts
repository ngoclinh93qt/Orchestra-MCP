import DatabaseConstructor from "better-sqlite3";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeOAuthProvider } from "../src/auth/oauth-provider.js";
import { OAuthStore } from "../src/auth/oauth-store.js";
import { createCombinedVerifier } from "../src/auth/middleware.js";
import { mountAuth } from "../src/auth/routes.js";
import { createToolHandlers } from "../src/mcp/register-tools.js";
import { createApp, type BridgeApp } from "../src/http/app.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { EventLog } from "../src/store/event-log.js";
import { TaskStore } from "../src/store/task-store.js";
import { JobSupervisor } from "../src/supervisor/job-supervisor.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RECOVERY_CODE = "ABCDE-FGHJK-LMNPQ-RSTUV";
const LOCAL_BEARER_TOKEN = "local-secret-token-value-0123456789";

describe("no plaintext bearer material at rest", () => {
  it("never stores the recovery code, local bearer token, codes, or access/refresh tokens in the clear", () => {
    const store = new OAuthStore(":memory:");
    store.setRecoveryCode(RECOVERY_CODE);
    store.setLocalBearerToken(LOCAL_BEARER_TOKEN);
    const code = store.createAuthorizationCode({
      clientId: "client-1",
      codeChallenge: "challenge-abc",
      redirectUri: "http://127.0.0.1:9/callback",
      scope: "agent:read",
      resource: null,
    });
    const issued = store.issueTokenPair({ clientId: "client-1", scope: "agent:read", resource: null });

    // Reach into the raw database the way an attacker with file access would.
    const raw = (store as unknown as { db: InstanceType<typeof DatabaseConstructor> }).db;
    const dump = JSON.stringify({
      owner: raw.prepare("SELECT * FROM owner").all(),
      codes: raw.prepare("SELECT * FROM oauth_codes").all(),
      tokens: raw.prepare("SELECT * FROM oauth_tokens").all(),
    });

    expect(dump).not.toContain(RECOVERY_CODE);
    expect(dump).not.toContain(LOCAL_BEARER_TOKEN);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(issued.accessToken);
    expect(dump).not.toContain(issued.refreshToken);

    store.close();
  });
});

describe("combined verifier", () => {
  it("accepts the local bearer token with full scope", async () => {
    const store = new OAuthStore(":memory:");
    store.setLocalBearerToken(LOCAL_BEARER_TOKEN);
    const provider = new BridgeOAuthProvider(store);
    const verifier = createCombinedVerifier(store, provider);

    const info = await verifier.verifyAccessToken(LOCAL_BEARER_TOKEN);
    expect(info.scopes).toEqual(expect.arrayContaining(["agent:read", "agent:write"]));
    store.close();
  });

  it("rejects an unknown token", async () => {
    const store = new OAuthStore(":memory:");
    const provider = new BridgeOAuthProvider(store);
    const verifier = createCombinedVerifier(store, provider);

    await expect(verifier.verifyAccessToken("not-a-real-token")).rejects.toThrow();
    store.close();
  });
});

describe("per-tool scope enforcement", () => {
  it("lets a read-scoped token call read tools but not write tools", async () => {
    const base = await mkdtemp(join(tmpdir(), "bridge-auth-"));
    const taskStore = new TaskStore(":memory:");
    const eventLog = new EventLog(join(base, "logs"));
    const supervisor = new JobSupervisor({
      taskStore,
      eventLog,
      adapters: {},
      allowedRoots: [base],
      maxConcurrentTotal: 1,
      maxConcurrentPerProvider: 1,
      maxPromptBytes: 1000,
    });
    const handlers = createToolHandlers({
      supervisor,
      taskStore,
      eventLog,
      allowedRoots: [base],
      sessionStore: new SessionStore({
        allowedRoots: [base],
        claudeProjectsDir: join(base, "claude-projects"),
        codexSessionsDir: join(base, "codex-sessions"),
      }),
    });
    const readOnlyExtra = { authInfo: { token: "t", clientId: "c", scopes: ["agent:read"] } };

    const listResult = await handlers.agent_list({}, readOnlyExtra);
    expect(listResult.isError).toBeFalsy();

    const startResult = await handlers.agent_start({ provider: "codex", cwd: base, prompt: "hi" }, readOnlyExtra);
    expect(startResult.isError).toBe(true);
    expect((startResult.content[0] as { text: string }).text).toContain("agent:write");

    taskStore.close();
  });
});

describe("loopback /mcp requires a token once auth is configured", () => {
  interface Harness {
    readonly bridgeApp: BridgeApp;
    readonly server: Server;
    readonly baseUrl: URL;
    readonly taskStore: TaskStore;
  }
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      await h.bridgeApp.shutdown();
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      h.taskStore.close();
    }
  });

  it("rejects an unauthenticated request with 401, and accepts the local bearer token", async () => {
    const base = await mkdtemp(join(tmpdir(), "bridge-auth-http-"));
    const store = new OAuthStore(":memory:");
    store.setLocalBearerToken(LOCAL_BEARER_TOKEN);
    const provider = new BridgeOAuthProvider(store);
    const verifier = createCombinedVerifier(store, provider);

    const taskStore = new TaskStore(":memory:");
    const eventLog = new EventLog(join(base, "logs"));
    const supervisor = new JobSupervisor({
      taskStore,
      eventLog,
      adapters: {},
      allowedRoots: [base],
      maxConcurrentTotal: 1,
      maxConcurrentPerProvider: 1,
      maxPromptBytes: 1000,
    });
    const bridgeApp = createApp(
      {
        supervisor,
        taskStore,
        eventLog,
        allowedRoots: [base],
        sessionStore: new SessionStore({
          allowedRoots: [base],
          claudeProjectsDir: join(base, "claude-projects"),
          codexSessionsDir: join(base, "codex-sessions"),
        }),
      },
      { auth: { verifier, requiredScopes: ["agent:read"] } },
    );
    const server = await new Promise<Server>((resolve) => {
      const s = bridgeApp.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    const baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
    harnesses.push({ bridgeApp, server, baseUrl, taskStore });

    const unauthenticated = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(unauthenticated.status).toBe(401);

    const withBadToken = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not-the-right-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    });
    expect(withBadToken.status).toBe(401);

    const withGoodToken = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${LOCAL_BEARER_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    });
    expect(withGoodToken.status).toBe(200);

    store.close();
  });
});

describe("mountExtraRoutes ordering", () => {
  interface MountOrderHarness {
    readonly bridgeApp: BridgeApp;
    readonly server: Server;
    readonly baseUrl: URL;
    readonly taskStore: TaskStore;
    readonly store: OAuthStore;
  }
  const mountOrderHarnesses: MountOrderHarness[] = [];

  afterEach(async () => {
    for (const h of mountOrderHarnesses.splice(0)) {
      await h.bridgeApp.shutdown();
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      h.taskStore.close();
      h.store.close();
    }
  });

  it("keeps OAuth discovery routes reachable alongside /mcp and /healthz, and still 404s everything else", async () => {
    const base = await mkdtemp(join(tmpdir(), "bridge-mount-order-"));
    const store = new OAuthStore(":memory:");
    const provider = new BridgeOAuthProvider(store);
    const taskStore = new TaskStore(":memory:");
    const eventLog = new EventLog(join(base, "logs"));
    const supervisor = new JobSupervisor({
      taskStore,
      eventLog,
      adapters: {},
      allowedRoots: [base],
      maxConcurrentTotal: 1,
      maxConcurrentPerProvider: 1,
      maxPromptBytes: 1000,
    });

    // This must be built the same way main.ts builds it: mounting the OAuth router via
    // mountExtraRoutes, never by reaching into `app` after createApp() has already returned,
    // since createApp's own 404 catch-all would otherwise shadow anything mounted afterward.
    const bridgeApp = createApp(
      {
        supervisor,
        taskStore,
        eventLog,
        allowedRoots: [base],
        sessionStore: new SessionStore({
          allowedRoots: [base],
          claudeProjectsDir: join(base, "claude-projects"),
          codexSessionsDir: join(base, "codex-sessions"),
        }),
      },
      {
        mountExtraRoutes: (app) =>
          mountAuth(app, provider, {
            issuerUrl: new URL("https://example.test"),
            resourceServerUrl: new URL("https://example.test"),
          }),
      },
    );
    const server = await new Promise<Server>((resolve) => {
      const s = bridgeApp.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
    mountOrderHarnesses.push({ bridgeApp, server, baseUrl, taskStore, store });

    const metadata = await fetch(new URL("/.well-known/oauth-authorization-server", baseUrl));
    expect(metadata.status).toBe(200);

    const health = await fetch(new URL("/healthz", baseUrl));
    expect(health.status).toBe(200);

    const mcpInit = await fetch(new URL("/mcp", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    });
    expect(mcpInit.status).toBe(200);

    const trulyUnknown = await fetch(new URL("/definitely-not-a-route", baseUrl));
    expect(trulyUnknown.status).toBe(404);
  });
});
