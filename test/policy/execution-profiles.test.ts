import { describe, expect, it } from "vitest";
import { parseExecutionProfiles, profileById } from "../../src/policy/execution-profiles.js";
import { PolicyValidationError } from "../../src/policy/files-policy.js";

const enabled = { codex: { enabled: true }, claude: { enabled: true } };

describe("execution profiles", () => {
  it("parses an enabled profile and looks it up by id", () => {
    const profiles = parseExecutionProfiles(
      [{ id: "codex-fast", label: "Codex fast", provider: "codex", model: "gpt-test", reasoning: "medium", fallbackProfileIds: [] }],
      enabled,
    );
    expect(profileById(profiles, "codex-fast")?.model).toBe("gpt-test");
  });

  it("rejects profiles for disabled providers", () => {
    expect(() => parseExecutionProfiles(
      [{ id: "codex-fast", label: "Codex fast", provider: "codex", model: "gpt-test", fallbackProfileIds: [] }],
      { ...enabled, codex: { enabled: false } },
    )).toThrow(PolicyValidationError);
  });

  it("rejects fallback cycles", () => {
    expect(() => parseExecutionProfiles([
      { id: "a", label: "A", provider: "codex", model: "one", fallbackProfileIds: ["b"] },
      { id: "b", label: "B", provider: "claude", model: "two", fallbackProfileIds: ["a"] },
    ], enabled)).toThrow("fallback cycle");
  });
});
