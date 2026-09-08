import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../store/migrations.js";
import { constantTimeEqualHex, generateSecret, normalizeRecoveryCode, sha256Hex } from "./crypto.js";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const AUTHORIZATION_CODE_TTL_SECONDS = 60 * 10; // 10 minutes

export interface AuthorizationCodeRecord {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly resource: string | null;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
}

export interface RotatedTokens extends IssuedTokens {
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string | null;
}

export interface VerifiedAccessToken {
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string | null;
  readonly expiresAtSeconds: number;
}

interface CodeRow {
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  scope: string;
  resource: string | null;
  expires_at: string;
  used: number;
}

interface TokenRow {
  token_hash: string;
  kind: "access" | "refresh";
  client_id: string;
  scope: string;
  resource: string | null;
  expires_at: string;
  family_id: string;
  revoked: number;
}

/**
 * SQLite-backed OAuth state: registered clients, one-time authorization codes, and access/
 * refresh tokens. Every secret here is stored only as a SHA-256 hash EXCEPT the OAuth
 * client_secret, which the MCP SDK's own client-authentication middleware compares directly
 * and therefore requires in retrievable form; that is a property of the SDK's contract, not a
 * choice made here. Access tokens, refresh tokens, authorization codes, the owner recovery
 * code, and the local bearer token are all hashed.
 */
export class OAuthStore {
  private readonly db: Database;

  constructor(location: string) {
    this.db = new DatabaseConstructor(location);
    runMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  // --- Clients ---------------------------------------------------------

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT metadata FROM oauth_clients WHERE client_id = ?").get(clientId) as
      | { metadata: string }
      | undefined;
    return row ? (JSON.parse(row.metadata) as OAuthClientInformationFull) : undefined;
  }

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    this.db
      .prepare("INSERT INTO oauth_clients (client_id, metadata, created_at) VALUES (?, ?, ?)")
      .run(client.client_id, JSON.stringify(client), new Date().toISOString());
    return client;
  }

  // --- Authorization codes ----------------------------------------------

  createAuthorizationCode(record: AuthorizationCodeRecord): string {
    const code = generateSecret();
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, code_challenge, redirect_uri, scope, resource, expires_at, used, created_at)
         VALUES (@codeHash, @clientId, @codeChallenge, @redirectUri, @scope, @resource, @expiresAt, 0, @createdAt)`,
      )
      .run({
        codeHash: sha256Hex(code),
        clientId: record.clientId,
        codeChallenge: record.codeChallenge,
        redirectUri: record.redirectUri,
        scope: record.scope,
        resource: record.resource,
        expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000).toISOString(),
        createdAt: now.toISOString(),
      });
    return code;
  }

  /** Peeks at the stored PKCE challenge without consuming the code. */
  peekAuthorizationCode(code: string): AuthorizationCodeRecord {
    return toCodeRecord(this.loadValidCodeRow(code));
  }

  /** Consumes a one-time authorization code, bound to the requesting client. */
  consumeAuthorizationCode(code: string, expectedClientId: string): AuthorizationCodeRecord {
    const codeHash = sha256Hex(code);
    return this.db.transaction(() => {
      const row = this.loadValidCodeRow(code);
      if (row.client_id !== expectedClientId) {
        throw new InvalidGrantError("Authorization code was not issued to this client");
      }
      this.db.prepare("UPDATE oauth_codes SET used = 1 WHERE code_hash = ?").run(codeHash);
      return toCodeRecord(row);
    })();
  }

  private loadValidCodeRow(code: string): CodeRow {
    const row = this.db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(sha256Hex(code)) as
      | CodeRow
      | undefined;
    if (!row) throw new InvalidGrantError("Invalid authorization code");
    if (row.used) throw new InvalidGrantError("Authorization code already used");
    if (new Date(row.expires_at).getTime() < Date.now()) throw new InvalidGrantError("Authorization code expired");
    return row;
  }

  // --- Tokens ------------------------------------------------------------

  issueTokenPair(input: { clientId: string; scope: string; resource: string | null }): IssuedTokens {
    const familyId = randomUUID();
    const accessToken = generateSecret();
    const refreshToken = generateSecret();
    this.insertTokenPair(familyId, input.clientId, input.scope, input.resource, accessToken, refreshToken);
    return { accessToken, refreshToken, expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS };
  }

  private insertTokenPair(
    familyId: string,
    clientId: string,
    scope: string,
    resource: string | null,
    accessToken: string,
    refreshToken: string,
  ): void {
    const now = Date.now();
    const createdAt = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, scope, resource, expires_at, family_id, revoked, created_at)
       VALUES (@tokenHash, @kind, @clientId, @scope, @resource, @expiresAt, @familyId, 0, @createdAt)`,
    );
    insert.run({
      tokenHash: sha256Hex(accessToken),
      kind: "access",
      clientId,
      scope,
      resource,
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      familyId,
      createdAt,
    });
    insert.run({
      tokenHash: sha256Hex(refreshToken),
      kind: "refresh",
      clientId,
      scope,
      resource,
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
      familyId,
      createdAt,
    });
  }

  /**
   * Rotates a refresh token, bound to the requesting client. If the given refresh token was
   * already rotated away (replay of a stale token), the entire token family is revoked instead
   * of issuing new tokens, since that pattern indicates the refresh token has leaked.
   */
  rotateRefreshToken(refreshToken: string, expectedClientId: string): RotatedTokens {
    const tokenHash = sha256Hex(refreshToken);

    // A thrown error inside a better-sqlite3 transaction rolls back everything the transaction
    // did, including the family-revocation write below. So on reuse, the transaction commits a
    // revoked family and returns a sentinel instead of throwing; the actual InvalidGrantError is
    // thrown afterward, once that revocation is durable.
    const result = this.db.transaction(():
      | { reused: true }
      | { reused: false; tokens: RotatedTokens } => {
      const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(
        tokenHash,
      ) as TokenRow | undefined;
      if (!row) throw new InvalidGrantError("Invalid refresh token");
      if (row.client_id !== expectedClientId) {
        throw new InvalidGrantError("Refresh token was not issued to this client");
      }
      if (row.revoked) {
        this.db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE family_id = ?").run(row.family_id);
        return { reused: true };
      }
      if (new Date(row.expires_at).getTime() < Date.now()) throw new InvalidGrantError("Refresh token expired");

      this.db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?").run(tokenHash);
      const accessToken = generateSecret();
      const newRefreshToken = generateSecret();
      this.insertTokenPair(row.family_id, row.client_id, row.scope, row.resource, accessToken, newRefreshToken);

      return {
        reused: false,
        tokens: {
          clientId: row.client_id,
          scope: row.scope,
          resource: row.resource,
          accessToken,
          refreshToken: newRefreshToken,
          expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
        },
      };
    })();

    if (result.reused) {
      throw new InvalidGrantError("Refresh token reuse detected; session revoked");
    }
    return result.tokens;
  }

  verifyAccessToken(token: string): VerifiedAccessToken | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(
      sha256Hex(token),
    ) as TokenRow | undefined;
    if (!row || row.revoked) return undefined;
    const expiresAtMs = new Date(row.expires_at).getTime();
    if (expiresAtMs < Date.now()) return undefined;
    return { clientId: row.client_id, scope: row.scope, resource: row.resource, expiresAtSeconds: Math.floor(expiresAtMs / 1000) };
  }

  /** Revoking a refresh token invalidates its whole family; revoking an access token affects only it. */
  revokeToken(token: string): void {
    const tokenHash = sha256Hex(token);
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ?").get(tokenHash) as
      | TokenRow
      | undefined;
    if (!row) return; // Unknown or already-revoked token: a no-op, per RFC 7009.
    if (row.kind === "refresh") {
      this.db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE family_id = ?").run(row.family_id);
    } else {
      this.db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?").run(tokenHash);
    }
  }

  // --- Owner enrollment ----------------------------------------------------

  setRecoveryCode(plaintextCode: string): void {
    const hash = sha256Hex(normalizeRecoveryCode(plaintextCode));
    this.db
      .prepare(
        `INSERT INTO owner (id, recovery_code_hash, enrolled_at) VALUES (1, @hash, @enrolledAt)
         ON CONFLICT(id) DO UPDATE SET recovery_code_hash = @hash, enrolled_at = @enrolledAt`,
      )
      .run({ hash, enrolledAt: new Date().toISOString() });
  }

  setLocalBearerToken(plaintextToken: string): void {
    const hash = sha256Hex(plaintextToken);
    this.db
      .prepare(
        `INSERT INTO owner (id, local_bearer_token_hash) VALUES (1, @hash)
         ON CONFLICT(id) DO UPDATE SET local_bearer_token_hash = @hash`,
      )
      .run({ hash });
  }

  isEnrolled(): boolean {
    const row = this.db.prepare("SELECT recovery_code_hash FROM owner WHERE id = 1").get() as
      | { recovery_code_hash: string | null }
      | undefined;
    return row?.recovery_code_hash != null;
  }

  verifyRecoveryCode(candidate: string): boolean {
    const row = this.db.prepare("SELECT recovery_code_hash FROM owner WHERE id = 1").get() as
      | { recovery_code_hash: string | null }
      | undefined;
    if (!row?.recovery_code_hash) return false;
    return constantTimeEqualHex(sha256Hex(normalizeRecoveryCode(candidate)), row.recovery_code_hash);
  }

  verifyLocalBearerToken(candidate: string): boolean {
    const row = this.db.prepare("SELECT local_bearer_token_hash FROM owner WHERE id = 1").get() as
      | { local_bearer_token_hash: string | null }
      | undefined;
    if (!row?.local_bearer_token_hash) return false;
    return constantTimeEqualHex(sha256Hex(candidate), row.local_bearer_token_hash);
  }
}

function toCodeRecord(row: CodeRow): AuthorizationCodeRecord {
  return {
    clientId: row.client_id,
    codeChallenge: row.code_challenge,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    resource: row.resource,
  };
}
