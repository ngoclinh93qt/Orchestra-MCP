import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(import.meta.dirname, "../scripts/run-openai-tunnel.sh");

describe("run-openai-tunnel script", () => {
  it("starts the bridge and tunnel together without putting a runtime key in argv", async () => {
    const script = await readFile(scriptPath, "utf8");
    expect(script).toContain('node --env-file=.env dist/main.js');
    expect(script).toContain('AGENT_BRIDGE_AUTH_MODE=openai-tunnel');
    expect(script).toContain('tunnel-client run --profile agent-bridge');
    expect(script).toContain('CONTROL_PLANE_API_KEY="$(cat "$SECRET_FILE")"');
    expect(script).toContain("trap cleanup EXIT INT TERM");
  });
});
