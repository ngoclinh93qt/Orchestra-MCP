import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import type { OAuthStore } from "./oauth-store.js";

export const SUPPORTED_SCOPES = ["agent:read", "agent:write"] as const;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildHiddenFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  scope: readonly string[],
): Record<string, string> {
  const fields: Record<string, string> = {
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    response_type: "code",
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: scope.join(" "),
  };
  if (params.state !== undefined) fields.state = params.state;
  if (params.resource !== undefined) fields.resource = params.resource.toString();
  return fields;
}

function renderApprovalPage(hiddenFields: Readonly<Record<string, string>>, error: string | null): string {
  const inputs = Object.entries(hiddenFields)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join("\n    ");
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Agent Bridge MCP</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 440px; margin: 80px auto; color: #222;">
  <h1 style="font-size: 20px;">Approve access to your coding agents</h1>
  <p>Enter the recovery code shown on this Mac to let this client start, watch, and cancel Codex and Claude Code tasks.</p>
  ${error ? `<p style="color:#b00020; font-weight: 600;">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="/authorize">
    ${inputs}
    <input name="recovery_code" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" autofocus
      style="width:100%; box-sizing:border-box; padding:10px; font-family: ui-monospace, monospace; font-size: 16px;">
    <button type="submit" style="margin-top:14px; padding:10px 20px; font-size: 15px;">Approve</button>
  </form>
</body>
</html>`;
}

/**
 * Single-owner OAuth 2.1 authorization server: dynamic registration and token issuance follow
 * the MCP SDK's standard router and handlers; the only custom behavior is `authorize()`, which
 * gates the very first (and every subsequent) authorization on the owner's recovery code rather
 * than any third-party login. `res.req` gives access to the underlying request without widening
 * the SDK's `OAuthServerProvider.authorize` signature, which does not otherwise expose it.
 */
export class BridgeOAuthProvider implements OAuthServerProvider {
  constructor(private readonly store: OAuthStore) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.getClient(clientId),
      registerClient: (client) => this.store.registerClient(client as OAuthClientInformationFull),
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req;
    const requested = params.scopes && params.scopes.length > 0 ? params.scopes : [...SUPPORTED_SCOPES];
    const scope = requested.filter((s) => (SUPPORTED_SCOPES as readonly string[]).includes(s));
    const hiddenFields = buildHiddenFields(client, params, scope);

    if (req.method !== "POST") {
      res.status(200).type("html").send(renderApprovalPage(hiddenFields, null));
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const submitted = typeof body?.["recovery_code"] === "string" ? (body["recovery_code"] as string) : "";
    if (!this.store.verifyRecoveryCode(submitted)) {
      res.status(401).type("html").send(renderApprovalPage(hiddenFields, "Invalid recovery code."));
      return;
    }

    const code = this.store.createAuthorizationCode({
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scope: scope.join(" "),
      resource: params.resource ? params.resource.toString() : null,
    });

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) target.searchParams.set("state", params.state);
    res.redirect(302, target.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.store.peekAuthorizationCode(authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = this.store.consumeAuthorizationCode(authorizationCode, client.client_id);
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new Error("redirect_uri does not match the one used to obtain the authorization code");
    }
    const issued = this.store.issueTokenPair({
      clientId: client.client_id,
      scope: record.scope,
      resource: record.resource,
    });
    return {
      access_token: issued.accessToken,
      token_type: "bearer",
      expires_in: issued.expiresInSeconds,
      refresh_token: issued.refreshToken,
      scope: record.scope,
    };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const rotated = this.store.rotateRefreshToken(refreshToken, client.client_id);
    return {
      access_token: rotated.accessToken,
      token_type: "bearer",
      expires_in: rotated.expiresInSeconds,
      refresh_token: rotated.refreshToken,
      scope: rotated.scope,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = this.store.verifyAccessToken(token);
    if (!info) throw new InvalidTokenError("Invalid or expired token");
    return {
      token,
      clientId: info.clientId,
      scopes: info.scope.split(" ").filter(Boolean),
      expiresAt: info.expiresAtSeconds,
      ...(info.resource ? { resource: new URL(info.resource) } : {}),
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.store.revokeToken(request.token);
  }
}
