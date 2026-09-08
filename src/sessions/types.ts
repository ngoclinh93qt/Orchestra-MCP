export type SessionProvider = "codex" | "claude";

export interface SessionSummary {
  readonly provider: SessionProvider;
  readonly sessionId: string;
  readonly cwd: string;
  readonly lastModifiedAt: string;
  /** Best-effort description of the last recorded event. Never authoritative — see spec §7. */
  readonly lastEventHint: string | null;
}

export interface SessionPage {
  readonly events: readonly Record<string, unknown>[];
  readonly nextCursor: number;
}
