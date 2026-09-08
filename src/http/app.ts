import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import express, { type Express, type RequestHandler, type Request, type Response } from "express";
import { registerTools, type RegisterToolsDeps } from "../mcp/register-tools.js";

export interface CreateAppAuthOptions {
  readonly verifier: OAuthTokenVerifier;
  /** Scopes every /mcp request must carry. Per-tool write-scope checks happen in the handlers. */
  readonly requiredScopes?: readonly string[];
  readonly resourceMetadataUrl?: URL;
}

export interface CreateAppOptions {
  /** Caps the JSON request body accepted at /mcp. Defaults to 1 MiB. */
  readonly maxRequestBytes?: number;
  readonly serverInfo?: { readonly name: string; readonly version: string };
  /** When provided, every /mcp request must carry a valid bearer token. Omit for loopback-only, unauthenticated dev use. */
  readonly auth?: CreateAppAuthOptions;
  /**
   * Called with the app after /healthz and /mcp are registered but before the catch-all 404
   * handler, so a caller (main.ts, tests) can mount additional routers — e.g. the OAuth
   * discovery/registration/token endpoints — without those routes ever falling through.
   */
  readonly mountExtraRoutes?: (app: Express) => void;
}

export interface BridgeApp {
  readonly app: Express;
  /** Closes every open MCP transport session. Called during graceful shutdown. */
  shutdown(): Promise<void>;
}

/**
 * Builds the loopback-only HTTP surface: MCP Streamable HTTP at /mcp, a secret-free /healthz,
 * and nothing else. There is no general-purpose administrative HTTP API here, per spec 5.1.
 */
export function createApp(deps: RegisterToolsDeps, options: CreateAppOptions = {}): BridgeApp {
  const app = express();
  app.use(express.json({ limit: options.maxRequestBytes ?? 1_000_000 }));

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  function badRequest(res: Response): void {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
  }

  const mcpPostHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header("mcp-session-id");
    try {
      const existing = sessionId ? transports.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, req.body);
        return;
      }
      if (sessionId || !isInitializeRequest(req.body)) {
        badRequest(res);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      const server = new McpServer(options.serverInfo ?? { name: "agent-bridge-mcp", version: "0.1.0" }, {
        capabilities: { tools: {} },
      });
      registerTools(server, deps);
      // StreamableHTTPServerTransport's own onclose accessor is typed wider (`| undefined`)
      // than the Transport interface's exactOptionalPropertyTypes-narrowed field; both
      // describe the same real shape, so this cast only works around that SDK-internal gap.
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  const mcpSessionHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  };

  const authMiddleware: RequestHandler | undefined = options.auth
    ? requireBearerAuth({
        verifier: options.auth.verifier,
        ...(options.auth.requiredScopes ? { requiredScopes: [...options.auth.requiredScopes] } : {}),
        ...(options.auth.resourceMetadataUrl
          ? { resourceMetadataUrl: options.auth.resourceMetadataUrl.toString() }
          : {}),
      })
    : undefined;
  const mcpMiddleware: RequestHandler[] = authMiddleware ? [authMiddleware] : [];

  app.post("/mcp", ...mcpMiddleware, mcpPostHandler);
  app.get("/mcp", ...mcpMiddleware, mcpSessionHandler);
  app.delete("/mcp", ...mcpMiddleware, mcpSessionHandler);

  options.mountExtraRoutes?.(app);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  return {
    app,
    async shutdown() {
      const open = [...transports.values()];
      transports.clear();
      await Promise.all(open.map((transport) => transport.close()));
    },
  };
}
