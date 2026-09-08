import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { Express } from "express";
import { SUPPORTED_SCOPES, type BridgeOAuthProvider } from "./oauth-provider.js";

export interface MountAuthOptions {
  readonly issuerUrl: URL;
  readonly resourceServerUrl: URL;
}

/**
 * Mounts the standard MCP OAuth endpoints (discovery metadata, dynamic client registration,
 * /authorize, /token, /revoke) at the application root, as the SDK's router requires.
 */
export function mountAuth(app: Express, provider: BridgeOAuthProvider, options: MountAuthOptions): void {
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: options.issuerUrl,
      resourceServerUrl: options.resourceServerUrl,
      scopesSupported: [...SUPPORTED_SCOPES],
    }),
  );
}
