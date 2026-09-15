import type { Provider } from "../domain/task.js";
import { PolicyValidationError } from "./files-policy.js";

export interface ProviderPolicy { readonly enabled: boolean }

export type ProviderPolicies = Readonly<Record<Provider, ProviderPolicy>>;

export interface ExecutionProfile {
  readonly id: string;
  readonly label: string;
  readonly provider: Provider;
  readonly model: string;
  readonly reasoning?: string;
  readonly fallbackProfileIds: readonly string[];
}

const PROFILE_ID = /^[a-z][a-z0-9-]{0,62}$/;
const PROVIDERS: readonly Provider[] = ["codex", "claude"];

export const DEFAULT_PROVIDER_POLICIES: ProviderPolicies = Object.freeze({
  codex: Object.freeze({ enabled: true }),
  claude: Object.freeze({ enabled: true }),
});

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new PolicyValidationError(`${name} must be a non-empty string`);
  return value.trim();
}

export function parseProviderPolicies(raw: unknown): ProviderPolicies {
  if (raw === undefined) return DEFAULT_PROVIDER_POLICIES;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new PolicyValidationError("providers must be an object");
  const record = raw as Record<string, unknown>;
  const entries = PROVIDERS.map((provider) => {
    const value = record[provider];
    if (value === undefined) return [provider, { enabled: true }] as const;
    if (value === null || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).enabled !== "boolean") {
      throw new PolicyValidationError(`providers.${provider}.enabled must be a boolean`);
    }
    return [provider, { enabled: (value as Record<string, boolean>).enabled }] as const;
  });
  return Object.freeze(Object.fromEntries(entries) as Record<Provider, ProviderPolicy>);
}

export function parseExecutionProfiles(raw: unknown, providers: ProviderPolicies): readonly ExecutionProfile[] {
  if (!Array.isArray(raw)) throw new PolicyValidationError("profiles must be an array");
  const seen = new Set<string>();
  const profiles = raw.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new PolicyValidationError(`profiles[${index}] must be an object`);
    const value = entry as Record<string, unknown>;
    const id = nonEmpty(value.id, `profiles[${index}].id`);
    if (!PROFILE_ID.test(id)) throw new PolicyValidationError(`profiles[${index}].id must be a lowercase slug`);
    if (seen.has(id)) throw new PolicyValidationError(`profiles contains duplicate id: ${id}`);
    seen.add(id);
    const provider = nonEmpty(value.provider, `profiles[${index}].provider`) as Provider;
    if (!PROVIDERS.includes(provider)) throw new PolicyValidationError(`profiles[${index}].provider is unsupported`);
    if (!providers[provider].enabled) throw new PolicyValidationError(`profiles[${index}] references disabled provider: ${provider}`);
    const fallbackRaw = value.fallbackProfileIds ?? [];
    if (!Array.isArray(fallbackRaw) || fallbackRaw.some((item) => typeof item !== "string" || !PROFILE_ID.test(item))) {
      throw new PolicyValidationError(`profiles[${index}].fallbackProfileIds must be an array of profile IDs`);
    }
    const reasoning = value.reasoning === undefined ? undefined : nonEmpty(value.reasoning, `profiles[${index}].reasoning`);
    return Object.freeze({ id, label: nonEmpty(value.label, `profiles[${index}].label`), provider, model: nonEmpty(value.model, `profiles[${index}].model`), ...(reasoning ? { reasoning } : {}), fallbackProfileIds: Object.freeze([...fallbackRaw]) }) as ExecutionProfile;
  });
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  for (const profile of profiles) for (const fallback of profile.fallbackProfileIds) if (!byId.has(fallback)) throw new PolicyValidationError(`profile ${profile.id} references missing fallback: ${fallback}`);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => { if (visiting.has(id)) throw new PolicyValidationError("profile fallback cycle"); if (visited.has(id)) return; visiting.add(id); for (const next of byId.get(id)!.fallbackProfileIds) visit(next); visiting.delete(id); visited.add(id); };
  for (const profile of profiles) visit(profile.id);
  return Object.freeze(profiles);
}

export function profileById(profiles: readonly ExecutionProfile[], id: string): ExecutionProfile | undefined {
  return profiles.find((profile) => profile.id === id);
}
