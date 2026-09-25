# OMP Provider Design

## Goal

Add Oh My Pi (`omp`) as a first-class Agent Bridge provider so MCP callers can
start and continue OMP coding-agent tasks, including runs that select Gemma 4.
The installed CLI is `/Users/thief/.local/bin/omp` version 18.2.11. The bridge
must use the owner's existing OMP configuration and credentials; it must not
copy credentials into Agent Bridge configuration.

## User-facing behavior

- `agent_start` accepts `provider: "omp"` alongside `codex` and `claude`.
- The optional `model` value is passed to OMP as `--model <value>`. The value
  remains provider-defined; the bridge does not hard-code a Gemma 4 catalogue.
- When `model` is omitted, OMP chooses the default configured in the OMP profile.
- The start response identifies `provider: "omp"`. Normal task status, output,
  cancellation, and concurrency limits apply.
- `agent_continue` resumes the exact OMP session recorded for that bridge task,
  rather than whichever session happens to be most recent.
- `session_list` and `session_read` support OMP sessions when their session file
  format can be read safely, using the same allowlisted-directory policy as the
  existing providers.

## CLI integration

Use OMP as a subprocess, following the existing `ProviderAdapter` boundary.
Start invocations run the configured executable with non-interactive print and
JSON event modes, set the task working directory, pass the prompt as a trailing
argument, and include `--model` only when requested. The bridge never invokes a
shell. JSONL stdout is normalized into the existing session, progress, final,
error, and diagnostic events. Stderr remains diagnostics and must be redacted
by the existing event-log path.

Resume invocations target the exact captured session identifier with OMP's
resume option, use JSON mode, and send the follow-up prompt. They do not accept
a new model override because the OMP session determines the active model.

Use OMP's `--approval-mode write` for headless runs; never pass
`--auto-approve` or `--approval-mode yolo`. OMP documents `write` as approving
file reads and writes while prompting for command execution. Since this bridge
has no interactive approval channel for a running child, command-execution
requests must fail closed without hanging. Before shipping, verify that OMP's
write tools cannot modify files outside the requested allowlisted working
directory. The bridge's MCP path policy does not by itself constrain writes
made inside a provider subprocess. If OMP cannot enforce that boundary, stop
and present the limitation for a design decision instead of claiming equivalent
protection to the existing providers. See [OMP CLI](https://github.com/atyrode/omp)
for the installed tool's option surface.

## Components

- Extend the provider union, MCP provider schemas, task filters, and session
  provider schemas to include `omp`.
- Add an OMP adapter that builds argument arrays, parses OMP's JSONL stream, and
  resumes by exact session ID.
- Extend provider runtime discovery with `AGENT_BRIDGE_OMP_BIN`, `omp` PATH
  lookup, and the standard `~/.local/bin/omp` candidate. Preserve the current
  rule that an explicit bad override fails rather than falling back.
- Register the adapter in `main.ts` and report its resolved command at startup.
- Extend execution-profile provider validation and provider policy defaults so
  OMP can be selected by configured profiles as well as direct MCP starts.
- Add OMP session listing/reading for its JSONL session files, if their format
  remains compatible with a bounded safe parser. If safe reading is not
  feasible, keep task continuation supported and document that OMP sessions
  are not exposed through the session read tools.
- Update README and operations documentation with the OMP install/path setting,
  model argument usage, and refresh instructions for MCP clients.

## Safety and failure handling

- Keep process execution shell-free and continue using the minimal child
  environment created by provider runtime resolution.
- Never pass API keys in command arguments. OMP uses its own credentials/config
  from the bridge owner's home directory.
- Apply existing working-directory allowlisting, prompt-size caps, task limits,
  process-group cancellation, and output redaction unchanged.
- A missing executable produces the same provider-unavailable tool error family
  as Codex and Claude.
- Parse malformed or future OMP events as diagnostics/unknown events without
  crashing the bridge. Do not infer task success from an assistant message; use
  the authoritative end/result event and process exit status.
- Verify OMP's tool-approval behavior specifically. Never use `--auto-approve`
  or `--approval-mode yolo`. Fail closed for approval requests that cannot be
  handled through the existing MCP interaction.

## Compatibility

The existing SQLite task provider column is text-backed, so adding the `omp`
naming value should not require a schema migration. Existing `codex` and
`claude` task records, MCP inputs, and session behavior remain valid. OMP model
identifiers are not validated against a baked-in list because the available
catalog depends on the owner's OMP provider and configuration.

## Verification criteria

- OMP adapter builds the expected shell-free start and exact-session resume
  invocations, with and without an explicit model.
- Representative OMP JSONL fixtures map to normalized session/progress/final/
  error events; malformed lines remain non-fatal.
- Provider runtime resolution honors the OMP override, PATH, and standard
  install location.
- MCP schema accepts OMP and optional model while continuing to reject unknown
  providers.
- Existing Codex and Claude adapters retain their current invocation behavior.
- A manual smoke run with the installed OMP CLI confirms Gemma 4 selection,
  that writes stay within the requested working directory, command approvals
  fail closed without hanging, session capture/continuation, cancellation, and
  expected result handling.
