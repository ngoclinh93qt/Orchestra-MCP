import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { SUPPORTED_SCOPES, type BridgeOAuthProvider } from "./oauth-provider.js";
import type { OAuthStore } from "./oauth-store.js";

/** A local bearer token never expires by itself; it is revoked by re-enrolling instead. */
const LOCAL_BEARER_TTL_SECONDS = 60 * 60 * 24 * 365 * 10;

/**
 * A verifier that accepts either the loopback-only local bearer token (full access, no
 * interactive OAuth flow needed) or a real OAuth access token issued by BridgeOAuthProvider.
 * Both paths converge on the same AuthInfo shape, so tool handlers enforce scopes uniformly
 * regardless of which credential was used.
 */
export function createCombinedVerifier(store: OAuthStore, provider: BridgeOAuthProvider): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (store.verifyLocalBearerToken(token)) {
        return {
          token,
          clientId: "local",
          scopes: [...SUPPORTED_SCOPES],
          expiresAt: Math.floor(Date.now() / 1000) + LOCAL_BEARER_TTL_SECONDS,
        };
      }
      return provider.verifyAccessToken(token);
    },
  };
}
