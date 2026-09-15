import type { ExecutionProfile } from "../policy/execution-profiles.js";

export type AutomaticRoutingReason = "quota" | "rate_limit" | "unavailable";

/** Conservative classifier: ordinary coding failures never trigger an automatic retry. */
export function classifyRoutingReason(message: string): AutomaticRoutingReason | undefined {
  const value = message.toLowerCase();
  if (value.includes("rate limit") || value.includes("rate_limit") || value.includes("429")) return "rate_limit";
  if (value.includes("quota") || value.includes("usage limit")) return "quota";
  if (value.includes("provider unavailable") || value.includes("service unavailable") || value.includes("temporarily unavailable")) return "unavailable";
  return undefined;
}

/** Returns one configured fallback not already used by this routing chain. */
export function nextFallbackProfile(
  profiles: readonly ExecutionProfile[],
  currentProfileId: string,
  attemptedProfileIds: ReadonlySet<string>,
): ExecutionProfile | undefined {
  const current = profiles.find((profile) => profile.id === currentProfileId);
  if (!current) return undefined;
  return current.fallbackProfileIds
    .map((id) => profiles.find((profile) => profile.id === id))
    .find((profile): profile is ExecutionProfile => profile !== undefined && !attemptedProfileIds.has(profile.id));
}
