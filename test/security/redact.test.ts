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

  it("redacts an unquoted YAML-style secret", () => {
    expect(redactTextLine("api_key: sk-live-UNQUOTED-SECRET")).toBe("api_key: [REDACTED]");
  });

  it("redacts an unquoted shell export", () => {
    expect(redactTextLine("export AUTH_TOKEN=abc123secret")).toBe("export AUTH_TOKEN=[REDACTED]");
  });

  it("redacts an unquoted .npmrc auth token", () => {
    expect(redactTextLine("//registry.npmjs.org/:_authToken=npm_SECRETTOKEN")).toBe(
      "//registry.npmjs.org/:_authToken=[REDACTED]",
    );
  });

  it("leaves short and boolean unquoted values alone", () => {
    // Below the 8-character minimum, so never a plausible secret.
    expect(redactTextLine("this.password_reset_required = true;")).toBe("this.password_reset_required = true;");
    expect(redactTextLine("token = null")).toBe("token = null");
    expect(redactTextLine("api_key: undefined")).toBe("api_key: undefined");
  });

  it("leaves a purely numeric unquoted value alone", () => {
    expect(redactTextLine("token_expiry_seconds = 123456789")).toBe("token_expiry_seconds = 123456789");
  });

  it("does not double-redact an already-redacted quoted value", () => {
    // The quoted pass runs first; the unquoted pass must not then chew on its output.
    expect(redactTextLine('const apiKey = "sk-live-abc123";')).toBe('const apiKey = "[REDACTED]";');
  });

  describe("regression: unquoted pattern no longer corrupts ordinary code", () => {
    // Each of these has a method call or bracket immediately after the value-looking run, which
    // the narrowed character class and required statement-ending lookahead must both reject:
    // the call's "(" is neither a plausible secret-value character nor an accepted terminator.
    it("leaves a secretPath variable used in path.join untouched", () => {
      expect(redactTextLine("const secretPath = path.join(dir, name)")).toBe(
        "const secretPath = path.join(dir, name)",
      );
    });

    it("leaves a tokens variable assigned from String#split untouched", () => {
      expect(redactTextLine('const tokens = line.split(",")')).toBe('const tokens = line.split(",")');
    });

    it("leaves a secretsManager require() call untouched", () => {
      expect(redactTextLine('secretsManager = require("aws-sdk")')).toBe('secretsManager = require("aws-sdk")');
    });

    it("leaves an apiKeyRegex literal untouched", () => {
      expect(redactTextLine("const apiKeyRegex = /sk-[a-z0-9]+/")).toBe("const apiKeyRegex = /sk-[a-z0-9]+/");
    });

    it("leaves a passwordField DOM lookup untouched", () => {
      expect(redactTextLine("const passwordField = document.getElementById(id)")).toBe(
        "const passwordField = document.getElementById(id)",
      );
    });
  });

  describe("regression: original corruption-regression cases from the prior round still hold", () => {
    it("does not corrupt unquoted comparison operators", () => {
      expect(redactTextLine("if (password === userPassword) { doThing(); }")).toBe(
        "if (password === userPassword) { doThing(); }",
      );
    });

    it("does not corrupt unquoted boolean assignments", () => {
      expect(redactTextLine("this.password_reset_required = true;")).toBe(
        "this.password_reset_required = true;",
      );
    });

    it("still correctly redacts the quoted multi-word case (unaffected by the unquoted-pattern change)", () => {
      expect(redactTextLine('const apiKeyLabel = "API Key:";')).toBe('const apiKeyLabel = "[REDACTED]";');
    });
  });

  describe("positive cases the unquoted pattern exists to catch still redact", () => {
    it("redacts an unquoted YAML-style secret", () => {
      expect(redactTextLine("api_key: sk-live-UNQUOTED-SECRET")).toBe("api_key: [REDACTED]");
    });

    it("redacts an unquoted shell export", () => {
      expect(redactTextLine("export AUTH_TOKEN=abc123secret")).toBe("export AUTH_TOKEN=[REDACTED]");
    });

    it("redacts an unquoted .npmrc auth token", () => {
      expect(redactTextLine("//registry.npmjs.org/:_authToken=npm_SECRETTOKEN")).toBe(
        "//registry.npmjs.org/:_authToken=[REDACTED]",
      );
    });
  });
});
