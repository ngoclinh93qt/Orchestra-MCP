# Transport Profiles Design

## Purpose

Make Agent Bridge MCP independent of Cloudflare as an ingress provider. The
bridge remains a loopback-only MCP and OAuth server; deployment profiles decide
how a remote client reaches it. Cloudflare remains a supported managed profile,
while OpenAI Secure MCP Tunnel and any other compatible tunnel can be operated
outside the bridge as external profiles.

## Goals

- Preserve the current Cloudflare installation path for existing deployments.
- Provide a supported `external` ingress profile that installs only the bridge
  and does not own an ingress process.
- Document a complete OpenAI Secure MCP Tunnel setup as an external profile.
- Keep tunnel credentials and runtime API keys outside the repository and out
  of generated bridge plists.
- Keep `src/` independent of ingress-provider SDKs and credentials.
- Make deployment tests independent of a developer's untracked `.env` file.

## Non-goals

- Implement an in-process tunnel-provider plugin API.
- Provision, authenticate to, or rotate credentials for Cloudflare, OpenAI, or
  another tunnel provider.
- Change MCP tools, repository policy, task supervision, or the OAuth protocol.
- Claim that an OpenAI tunnel automatically makes a browser-facing OAuth
  authorization endpoint private. OpenAI documents this as a separate
  reachability requirement.

## Terminology

- **Bridge:** the Node service at `127.0.0.1:<port>`.
- **Ingress profile:** operator-selected deployment method that makes the
  bridge reachable by a remote MCP client.
- **Managed profile:** the installer owns the associated LaunchAgent.
- **External profile:** the operator owns the ingress process and its
  credentials; the bridge installer never starts or stores them.

## Profiles

| Profile | Value | Installer behavior | Intended use |
|---|---|---|---|
| Cloudflare | `cloudflare` | Install bridge and Cloudflare Tunnel LaunchAgents. | Current public HTTPS deployment. |
| External | `external` | Install bridge LaunchAgent only. | OpenAI Secure MCP Tunnel, ngrok, Tailscale Funnel, enterprise reverse proxy, or another operator-managed ingress. |

`AGENT_BRIDGE_INGRESS` selects the profile and defaults to `cloudflare` for
backward compatibility. `AGENT_BRIDGE_PUBLIC_URL` remains required and keeps
its current meaning: the public HTTPS `/mcp` URL advertised by the bridge as
its OAuth issuer and resource identifier. The external profile does not infer
or validate the vendor-specific tunnel URL.

## Architecture

```text
                         managed or external ingress
Remote MCP client  ------------------------------------>  127.0.0.1 bridge
                                                         MCP + OAuth + policy

cloudflare profile:  installer owns cloudflared LaunchAgent
external profile:    operator owns tunnel/reverse-proxy process
```

The Node process has no ingress-provider abstraction because it does not need
to create, stop, authenticate, or inspect tunnel processes. Its stable
boundary is the local HTTP MCP server. Provider-specific behavior belongs in
scripts, plist templates, and documentation.

## Installer behavior

`scripts/render-launch-agents.ts` accepts an ingress profile and renders the
bridge plist in all cases. It renders the Cloudflare plist only for the
`cloudflare` profile. Its return type exposes the rendered labels so callers
do not hard-code a two-service assumption.

`scripts/install-services.sh` reads `.env`, validates `AGENT_BRIDGE_INGRESS`,
and bootstraps every plist actually rendered. For `external`, it emits a clear
message that the ingress process is not installed or managed by Agent Bridge.
The existing Node ABI and port-conflict checks remain unchanged.

`scripts/uninstall-services.sh` always removes the bridge plist and also
removes the legacy Cloudflare plist if present. It never stops, removes, or
modifies an externally-managed ingress process or its credentials.

## Documentation

README describes ingress profiles and links to a new transport guide.
`docs/TRANSPORTS.md` includes:

- Cloudflare named-tunnel quick path, linking to the detailed operations guide.
- External profile contract: bridge listens on loopback; operator supplies a
  public HTTPS `/mcp` URL and manages its own tunnel.
- OpenAI Secure MCP Tunnel guide: create a tunnel in Platform settings, run
  `tunnel-client` inside the bridge's network boundary, point it to the local
  MCP endpoint, select the tunnel in ChatGPT developer mode, and use
  `tunnel-client doctor` for diagnostics.
- An explicit OAuth caveat: OpenAI's tunnel forwards MCP discovery but does not
  automatically make a browser-facing authorization server reachable. The
  bridge's OAuth issuer must be reachable for the chosen client flow.

No OpenAI API key, tunnel ID, Cloudflare credential, or tunnel configuration
belongs in committed files or bridge-generated plists.

## Configuration

```dotenv
# Existing public HTTPS MCP/OAuth URL; required for all remote profiles.
AGENT_BRIDGE_PUBLIC_URL=https://mcp.example.com/mcp

# Optional; defaults to cloudflare.
AGENT_BRIDGE_INGRESS=cloudflare
```

For the external profile, `AGENT_BRIDGE_INGRESS=external`; the operator starts
the ingress companion separately and configures it to reach
`http://127.0.0.1:8787/mcp`.

## Error handling

- Reject unsupported ingress values before rendering any plist.
- Retain the existing required public URL validation.
- If the external profile is selected, do not require `cloudflared` to be
  installed and do not render a Cloudflare plist.
- If a previously managed Cloudflare plist exists, uninstall removes it without
  touching third-party ingress state.
- Do not log credentials, tunnel IDs, authorization codes, tokens, or complete
  request bodies.

## Testing

- Unit-test profile parsing and unknown-profile rejection.
- Assert Cloudflare rendering produces both existing plists.
- Assert external rendering produces only the bridge plist and has no
  Cloudflare placeholders.
- Exercise install and uninstall with each profile using fake `launchctl`.
- Set `AGENT_BRIDGE_PUBLIC_URL` explicitly in script tests so they do not read
  an ambient `.env` file.
- Run `npm run verify` after the change.

## Security implications

Ingress profiles change network reachability, not the bridge's authorization,
path policy, scope, redaction, or process-supervision rules. An external
profile must still terminate only at the loopback bridge and must protect any
public URL according to its provider's controls. OpenAI Secure MCP Tunnel is
an outbound-only transport, but its organization/workspace association and
OAuth flow must be configured by the operator.
