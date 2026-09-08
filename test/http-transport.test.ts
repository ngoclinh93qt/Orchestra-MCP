import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type BridgeApp } from "../src/http/app.js";
import { EventLog } from "../src/store/event-log.js";
import { TaskStore } from "../src/store/task-store.js";
import { JobSupervisor } from "../src/supervisor/job-supervisor.js";
import type { Server } from "node:http";

interface Harness {
  readonly bridgeApp: BridgeApp;
  readonly server: Server;
  readonly baseUrl: URL;
  readonly taskStore: TaskStore;
}

const harnesses: Harness[] = [];

async function buildHarness(maxRequestBytes?: number): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "bridge-http-"));
  const taskStore = new TaskStore(":memory:");
  const eventLog = new EventLog(join(base, "logs"));
  const supervisor = new JobSupervisor({
    taskStore,
    eventLog,
    adapters: {},
    allowedRoots: [base],
    maxConcurrentTotal: 2,
    maxConcurrentPerProvider: 1,
    maxPromptBytes: 1_000_000,
  });
  const bridgeApp = createApp({ supervisor, taskStore, eventLog }, maxRequestBytes ? { maxRequestBytes } : {});

  const server = await new Promise<Server>((resolve) => {
    const s = bridgeApp.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

  const harness = { bridgeApp, server, baseUrl, taskStore };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.bridgeApp.shutdown();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
    h.taskStore.close();
  }
});

async function connectedClient(baseUrl: URL): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(baseUrl);
  // Same SDK-internal exactOptionalPropertyTypes gap worked around in src/http/app.ts.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}

describe("loopback HTTP transport", () => {
  it("binds only to 127.0.0.1", async () => {
    const { server } = await buildHarness();
    const address = server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
  });

  it("serves a secret-free health check", async () => {
    const { baseUrl } = await buildHarness();
    const response = await fetch(new URL("/healthz", baseUrl));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok" });
    expect(JSON.stringify(body).toLowerCase()).not.toContain("token");
  });

  it("falls back to 404 for unknown routes", async () => {
    const { baseUrl } = await buildHarness();
    const response = await fetch(new URL("/not-a-real-route", baseUrl));
    expect(response.status).toBe(404);
  });

  it("completes MCP initialize and lists exactly the six agent tools", async () => {
    const { baseUrl } = await buildHarness();
    const client = await connectedClient(baseUrl);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "agent_cancel",
      "agent_continue",
      "agent_list",
      "agent_output",
      "agent_start",
      "agent_status",
    ]);
    await client.close();
  });

  it("serves distinct MCP sessions from distinct transports", async () => {
    const { baseUrl } = await buildHarness();
    const clientA = await connectedClient(baseUrl);
    const clientB = await connectedClient(baseUrl);

    const [toolsA, toolsB] = await Promise.all([clientA.listTools(), clientB.listTools()]);
    expect(toolsA.tools.length).toBe(6);
    expect(toolsB.tools.length).toBe(6);

    await clientA.close();
    await clientB.close();
  });

  it("rejects a request body larger than the configured cap", async () => {
    const { baseUrl } = await buildHarness(1024);
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" }, padding: "x".repeat(5000) },
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it("rejects a non-initialize request with no session id", async () => {
    const { baseUrl } = await buildHarness();
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(400);
  });

  it("shuts down all active transport sessions gracefully", async () => {
    const { baseUrl, bridgeApp } = await buildHarness();
    const client = await connectedClient(baseUrl);
    await client.listTools();

    await expect(bridgeApp.shutdown()).resolves.toBeUndefined();
  });
});
