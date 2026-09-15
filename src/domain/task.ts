export type Provider = "codex" | "claude";

export type TaskState =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

const ALLOWED_TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  queued: new Set<TaskState>(["running", "cancelled", "interrupted"]),
  running: new Set<TaskState>(["waiting", "succeeded", "failed", "cancelled", "interrupted"]),
  waiting: new Set<TaskState>(["running", "succeeded", "failed", "cancelled", "interrupted"]),
  succeeded: new Set<TaskState>([]),
  failed: new Set<TaskState>([]),
  cancelled: new Set<TaskState>([]),
  interrupted: new Set<TaskState>([]),
};

/** Cancellation is idempotent: cancelling an already-cancelled task is legal and a no-op. */
export function canTransition(from: TaskState, to: TaskState): boolean {
  if (from === to && from === "cancelled") return true;
  return ALLOWED_TRANSITIONS[from].has(to);
}

export interface BridgeTask {
  readonly id: string;
  readonly provider: Provider;
  readonly cwd: string;
  readonly promptBytes: number;
  readonly state: TaskState;
  readonly parentId: string | null;
  readonly providerSessionId: string | null;
  readonly exitCode: number | null;
  readonly errorSummary: string | null;
  readonly profileId: string | null;
  readonly routingRootId: string | null;
  readonly routingAttempt: number;
  readonly switchReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTaskInput {
  readonly provider: Provider;
  readonly cwd: string;
  readonly promptBytes: number;
  readonly parentId?: string | null;
  readonly profileId?: string | null;
  readonly routingRootId?: string | null;
  readonly routingAttempt?: number;
  readonly switchReason?: string | null;
}

export type RoutingProposalState = "pending" | "approved" | "rejected" | "expired";
export interface RoutingProposal { readonly id: string; readonly sourceTaskId: string; readonly targetProfileId: string; readonly reason: string; readonly state: RoutingProposalState; readonly createdAt: string; readonly updatedAt: string }

export interface TransitionOptions {
  readonly providerSessionId?: string | null;
  readonly exitCode?: number | null;
  readonly errorSummary?: string | null;
}

export interface ListFilter {
  readonly provider?: Provider;
  readonly state?: TaskState;
  readonly limit?: number;
}
