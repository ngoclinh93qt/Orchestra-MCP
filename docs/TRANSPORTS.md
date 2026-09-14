# Ingress profiles

Agent Bridge MCP always listens on `127.0.0.1`. An ingress profile determines
how a remote MCP client reaches that local service; it does not change the
bridge's access policy, OAuth scopes, redaction, or task supervision.

## Cloudflare: managed profile

`cloudflare` is the default. `scripts/install-services.sh` renders and starts
both `local.agent-bridge.bridge` and `local.agent-bridge.tunnel`.

```dotenv
AGENT_BRIDGE_INGRESS=cloudflare
AGENT_BRIDGE_PUBLIC_URL=https://mcp.example.com/mcp
```

Create a named Cloudflare Tunnel and follow the full setup in
[OPERATIONS.md](OPERATIONS.md). The tunnel must forward only to the loopback
bridge and end its ingress list with a 404 catch-all.

## External: operator-managed ingress

Use `external` when another system exposes the local MCP server. The bridge
installer creates only its own LaunchAgent and never starts, stops, or stores
credentials for the external tunnel or reverse proxy.

```dotenv
AGENT_BRIDGE_INGRESS=external
AGENT_BRIDGE_PUBLIC_URL=https://mcp.example.com/mcp
```

Run `scripts/install-services.sh`, then configure the chosen ingress to reach:

```text
http://127.0.0.1:8787/mcp
```

The external service must preserve MCP HTTP and OAuth routes, use HTTPS for
the public endpoint, and protect any public hostname according to its own
security controls. This profile works for a company reverse proxy, ngrok,
Tailscale Funnel, or another compatible tunnel.

## OpenAI Secure MCP Tunnel: external profile

OpenAI Secure MCP Tunnel is an outbound-only path from a host in your network
to an OpenAI-hosted MCP endpoint. It lets supported OpenAI products reach a
private MCP server without opening an inbound firewall port. Follow the
[official OpenAI guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
for current availability, permissions, and billing.

1. In OpenAI Platform tunnel settings, create a tunnel and associate it with
   the Platform organization and ChatGPT workspace that will use it.
2. Install `tunnel-client` on the Mac that can reach Agent Bridge MCP.
3. Set `AGENT_BRIDGE_INGRESS=external` and install the bridge. Keep it bound
   to loopback.
4. Configure and run `tunnel-client` with the tunnel ID and the local MCP
   server URL `http://127.0.0.1:8787/mcp`. Keep its runtime API key in the
   provider's recommended secret store; do not put it in this repository,
   `.env`, or an Agent Bridge plist.
5. Run `tunnel-client doctor --profile <profile> --explain` and confirm the
   client is healthy before creating the ChatGPT developer-mode app.
6. In ChatGPT developer mode, choose **Tunnel** as the connection type and
   select the associated tunnel.

### OAuth caveat

The tunnel can carry MCP discovery, but OpenAI documents that it does not
automatically make a browser-facing OAuth authorization server reachable. The
OAuth issuer configured by `AGENT_BRIDGE_PUBLIC_URL` must still be reachable
for the chosen client authorization flow. Test enrollment and token refresh
before relying on this profile for production access.

## Removing an ingress

`scripts/uninstall-services.sh` removes the bridge plist and a previously
managed Cloudflare plist. It deliberately does not remove or stop an external
tunnel, its configuration, or its credentials; manage those through the
provider that owns them.
