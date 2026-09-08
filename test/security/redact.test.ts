import { describe, expect, it } from "vitest";
import { redactJsonValue, redactTextLine } from "../../src/security/redact.js";

describe("redactJsonValue", () => {
  it("redacts known secret keys at any depth", () => {
    expect(redactJsonValue({ token: "abc", nested: { Authorization: "Bearer x" } })).toEqual({
      token: "[REDACTED]",
      nested: { Authorization: "[REDACTED]" },
    });
  });

  it("leaves non-secret keys untouched", () => {
    expect(redactJsonValue({ type: "final", text: "safe" })).toEqual({ type: "final", text: "safe" });
  });
});

describe("redactTextLine", () => {
  it("redacts an assignment-shaped secret in source text", () => {
    expect(redactTextLine('const apiKey = "sk-live-abc123";')).toBe('const apiKey = "[REDACTED]";');
    expect(redactTextLine("AUTH_TOKEN: 'xyz789'")).toBe("AUTH_TOKEN: '[REDACTED]'");
  });

  it("leaves ordinary code untouched", () => {
    expect(redactTextLine("const total = price * quantity;")).toBe("const total = price * quantity;");
  });

  it("regression: does not corrupt unquoted comparison operators", () => {
    // Should NOT redact unquoted identifiers, even if they contain a secret word
    expect(redactTextLine("if (password === userPassword) { doThing(); }")).toBe(
      "if (password === userPassword) { doThing(); }"
    );
  });

  it("regression: does not corrupt unquoted boolean assignments", () => {
    // Should NOT redact unquoted boolean values
    expect(redactTextLine("this.password_reset_required = true;")).toBe("this.password_reset_required = true;");
  });

  it("regression: correctly redacts multi-word quoted strings", () => {
    // Should redact entire quoted string, not truncate at first space
    expect(redactTextLine('const apiKeyLabel = "API Key:";')).toBe(
      'const apiKeyLabel = "[REDACTED]";'
    );
  });
});
