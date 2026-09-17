export type ProviderName = "codex" | "claude";

export type ProviderEvent = Readonly<Record<string, unknown>>;

export interface StartInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly model?: string;
  readonly reasoning?: string;
}

export interface ContinueInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly providerSessionId: string;
}

export type ProviderInvocation = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  stdin: string;
  env: Readonly<Record<string, string>>;
}>;

/**
 * A ProviderAdapter never invokes a shell and never receives a permission or
 * sandbox bypass flag. It only builds argument arrays and parses output lines.
 */
export interface ProviderAdapter {
  readonly name: ProviderName;
  checkAvailable(): Promise<void>;
  newInvocation(input: StartInput): ProviderInvocation;
  resumeInvocation(input: ContinueInput): ProviderInvocation;
  parseLine(stream: "stdout" | "stderr", line: string): readonly ProviderEvent[];
}
