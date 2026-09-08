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
});
