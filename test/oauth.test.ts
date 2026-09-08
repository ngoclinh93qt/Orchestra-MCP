import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pkceChallenge from "pkce-challenge";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeOAuthProvider } from "../src/auth/oauth-provider.js";
import { OAuthStore } from "../src/auth/oauth-store.js";
import { mountAuth } from "../src/auth/routes.js";
import express from "express";

const RECOVERY_CODE = "ABCDE-FGHJK-LMNPQ-RSTUV";

interface Harness {
  readonly store: OAuthStore;
  readonly server: Server;
  readonly baseUrl: URL;
}

const harnesses: Harness[] = [];

async function buildHarness(): Promise<Harness> {
  const store = new OAuthStore(":memory:");
  store.setRecoveryCode(RECOVERY_CODE);

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = new URL(`http://127.0.0.1:${address.port}`);

  const provider = new BridgeOAuthProvider(store);
  mountAuth(app, provider, { issuerUrl: baseUrl, resourceServerUrl: baseUrl });

  const harness = { store, server, baseUrl };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
    h.store.close();
  }
});

async function registerClient(baseUrl: URL, overrides: Record<string, unknown> = {}) {
  const response = await fetch(new URL("/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1:9/callback"],
      token_endpoint_auth_method: "none",
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string; redirect_uris: string[] };
}

async function approve(
  baseUrl: URL,
  params: Record<string, string>,
  recoveryCode: string,
): Promise<Response> {
  return fetch(new URL("/authorize", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({ ...params, recovery_code: recoveryCode }).toString(),
  });
}

describe("OAuth discovery and dynamic registration", () => {
  it("advertises authorization server metadata", async () => {
    const { baseUrl } = await buildHarness();
    const response = await fetch(new URL("/.well-known/oauth-authorization-server", baseUrl));
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(baseUrl.toString());
    expect(metadata.authorization_endpoint).toContain("/authorize");
    expect(metadata.token_endpoint).toContain("/token");
    expect(metadata.registration_endpoint).toContain("/register");
    expect(metadata.scopes_supported).toEqual(expect.arrayContaining(["agent:read", "agent:write"]));
    expect(metadata.code_challenge_methods_supported).toContain("S256");
  });

  it("dynamically registers a public client", async () => {
    const { baseUrl } = await buildHarness();
    const client = await registerClient(baseUrl);
    expect(client.client_id).toBeTruthy();
    expect(client.redirect_uris).toEqual(["http://127.0.0.1:9/callback"]);
  });
});

describe("authorization code + PKCE flow", () => {
  it("completes the full code exchange with S256 PKCE", async () => {
    const { baseUrl } = await buildHarness();
    const client = await registerClient(baseUrl);
    const { code_verifier, code_challenge } = await pkceChallenge();

    const params = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0]!,
      code_challenge,
      code_challenge_method: "S256",
      scope: "agent:read agent:write",
      state: "xyz",
    };

    const approved = await approve(baseUrl, params, RECOVERY_CODE);
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(client.redirect_uris[0]);
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("xyz");

    const tokenResponse = await fetch(new URL("/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        code_verifier,
        redirect_uri: client.redirect_uris[0]!,
        client_id: client.client_id,
      }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.scope).toBe("agent:read agent:write");
  });

  it("rejects an approval with the wrong recovery code", async () => {
    const { baseUrl } = await buildHarness();
    const client = await registerClient(baseUrl);
    const { code_challenge } = await pkceChallenge();

    const response = await approve(
      baseUrl,
      {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0]!,
        code_challenge,
        code_challenge_method: "S256",
      },
      "WRONG-CODE-0000-0000",
    );
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("Invalid recovery code");
  });

  it("rejects an unregistered redirect_uri before ever touching the recovery code", async () => {
    const { baseUrl } = await buildHarness();
    const client = await registerClient(baseUrl);
    const { code_challenge } = await pkceChallenge();

    const badResponse = await approve(
      baseUrl,
      {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://evil.example.com/callback",
        code_challenge,
        code_challenge_method: "S256",
      },
      RECOVERY_CODE,
    );
    expect(badResponse.status).toBe(400);
  });

  it("rejects reusing a one-time authorization code", async () => {
    const { baseUrl } = await buildHarness();
    const client = await registerClient(baseUrl);
    const { code_verifier, code_challenge } = await pkceChallenge();
    const params = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0]!,
      code_challenge,
      code_challenge_method: "S256",
    };
    const approved = await approve(baseUrl, params, RECOVERY_CODE);
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

    const exchangeOnce = async () =>
      fetch(new URL("/token", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier,
          redirect_uri: client.redirect_uris[0]!,
          client_id: client.client_id,
        }).toString(),
      });

    const first = await exchangeOnce();
    expect(first.status).toBe(200);
    const second = await exchangeOnce();
    expect(second.status).toBe(400);
  });

  it("narrows the token's scope to whatever was requested at authorization time", async () => {
    const { baseUrl } = await buildHarness();
    const client = await registerClient(baseUrl);
    const { code_verifier, code_challenge } = await pkceChallenge();
    const approved = await approve(
      baseUrl,
      {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0]!,
        code_challenge,
        code_challenge_method: "S256",
        scope: "agent:read",
      },
      RECOVERY_CODE,
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const tokenResponse = await fetch(new URL("/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier,
        redirect_uri: client.redirect_uris[0]!,
        client_id: client.client_id,
      }).toString(),
    });
    const tokens = (await tokenResponse.json()) as { scope: string };
    expect(tokens.scope).toBe("agent:read");
  });
});

describe("refresh rotation and revocation", () => {
  async function fullyAuthorize(baseUrl: URL) {
    const client = await registerClient(baseUrl);
    const { code_verifier, code_challenge } = await pkceChallenge();
    const approved = await approve(
      baseUrl,
      {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0]!,
        code_challenge,
        code_challenge_method: "S256",
      },
      RECOVERY_CODE,
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const tokenResponse = await fetch(new URL("/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier,
        redirect_uri: client.redirect_uris[0]!,
        client_id: client.client_id,
      }).toString(),
    });
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
    return { client, tokens };
  }

  it("rotates the refresh token and detects replay of the stale one", async () => {
    const { baseUrl, store } = await buildHarness();
    const { client, tokens } = await fullyAuthorize(baseUrl);

    const rotate = async (refreshToken: string) =>
      fetch(new URL("/token", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: client.client_id,
        }).toString(),
      });

    const firstRotation = await rotate(tokens.refresh_token);
    expect(firstRotation.status).toBe(200);
    const rotated = (await firstRotation.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    // Replaying the now-stale original refresh token must fail...
    const replay = await rotate(tokens.refresh_token);
    expect(replay.status).toBe(400);

    // ...and must revoke the whole family, including the token issued by the legitimate rotation.
    expect(store.verifyAccessToken(rotated.access_token)).toBeUndefined();
  });

  it("revokes a token so it stops verifying", async () => {
    const { baseUrl, store } = await buildHarness();
    const { client, tokens } = await fullyAuthorize(baseUrl);
    expect(store.verifyAccessToken(tokens.access_token)).toBeDefined();

    const revokeResponse = await fetch(new URL("/revoke", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.access_token, client_id: client.client_id }).toString(),
    });
    expect(revokeResponse.status).toBe(200);
    expect(store.verifyAccessToken(tokens.access_token)).toBeUndefined();
  });
});

describe("OAuthStore expiry", () => {
  it("rejects an expired authorization code", async () => {
    const store = new OAuthStore(":memory:");
    const code = store.createAuthorizationCode({
      clientId: "client-1",
      codeChallenge: "challenge",
      redirectUri: "http://127.0.0.1:9/callback",
      scope: "agent:read",
      resource: null,
    });
    // Directly backdate the row rather than waiting out the real 10-minute TTL.
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare("UPDATE oauth_codes SET expires_at = ? WHERE 1=1")
      .run(new Date(Date.now() - 1000).toISOString());

    expect(() => store.consumeAuthorizationCode(code, "client-1")).toThrow(/expired/);
    store.close();
  });
});
