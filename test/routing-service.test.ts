import { describe, expect, it } from "vitest";
import { classifyRoutingReason, nextFallbackProfile } from "../src/supervisor/routing-service.js";

const profiles = [
  { id: "codex-fast", label: "Fast", provider: "codex" as const, model: "x", fallbackProfileIds: ["claude-review"] },
  { id: "claude-review", label: "Review", provider: "claude" as const, model: "y", fallbackProfileIds: ["codex-deep"] },
  { id: "codex-deep", label: "Deep", provider: "codex" as const, model: "z", fallbackProfileIds: [] },
];

describe("routing service", () => {
  it("classifies only quota, rate-limit, and unavailable failures for automatic failover", () => {
    expect(classifyRoutingReason("Rate limit exceeded")).toBe("rate_limit");
    expect(classifyRoutingReason("quota exhausted")).toBe("quota");
    expect(classifyRoutingReason("provider unavailable")).toBe("unavailable");
    expect(classifyRoutingReason("tests failed")).toBeUndefined();
  });

  it("selects the first unattempted fallback and never loops", () => {
    expect(nextFallbackProfile(profiles, "codex-fast", new Set(["codex-fast"]))?.id).toBe("claude-review");
    expect(nextFallbackProfile(profiles, "codex-fast", new Set(["codex-fast", "claude-review", "codex-deep"]))).toBeUndefined();
  });
});
