import { homedir } from "node:os";
import { join } from "node:path";
import { getClaudeSessionCwd, listClaudeSessions, readClaudeSession } from "./claude-sessions.js";
import { getCodexSessionCwd, listCodexSessions, readCodexSession } from "./codex-sessions.js";
import type { AccessPolicy } from "../policy/files-policy.js";
import { isPathPermitted } from "../repo/path-safety.js";
import type { SessionPage, SessionProvider, SessionSummary } from "./types.js";

export interface SessionStoreOptions {
  readonly policy: AccessPolicy;
  readonly claudeProjectsDir?: string;
  readonly codexSessionsDir?: string;
}

export interface SessionListFilter {
  readonly provider?: SessionProvider;
  readonly limit?: number;
}

export interface SessionReadOptions {
  readonly cursor?: number;
  readonly limit?: number;
}

export class SessionStore {
  private readonly policy: AccessPolicy;
  private readonly claudeProjectsDir: string;
  private readonly codexSessionsDir: string;

  constructor(options: SessionStoreOptions) {
    this.policy = options.policy;
    this.claudeProjectsDir = options.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
    this.codexSessionsDir = options.codexSessionsDir ?? join(homedir(), ".codex", "sessions");
  }

  async list(filter: SessionListFilter): Promise<SessionSummary[]> {
    const wantClaude = filter.provider === undefined || filter.provider === "claude";
    const wantCodex = filter.provider === undefined || filter.provider === "codex";

    const [claudeSessions, codexSessions] = await Promise.all([
      wantClaude ? listClaudeSessions(this.claudeProjectsDir) : Promise.resolve([]),
      wantCodex ? listCodexSessions(this.codexSessionsDir) : Promise.resolve([]),
    ]);

    const all = [...claudeSessions, ...codexSessions];
    const inScope: SessionSummary[] = [];
    for (const session of all) {
      if (await isPathPermitted(session.cwd, this.policy.files)) inScope.push(session);
    }

    inScope.sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
    const limit = filter.limit ?? 100;
    return inScope.slice(0, limit);
  }

  async read(provider: SessionProvider, sessionId: string, options: SessionReadOptions): Promise<SessionPage> {
    // Resolve only this session's cwd for the allowlist check. Parsing the whole corpus here (as
    // this used to) cost ~1s and hundreds of MB on every session_read call.
    const cwd =
      provider === "claude"
        ? await getClaudeSessionCwd(this.claudeProjectsDir, sessionId)
        : await getCodexSessionCwd(this.codexSessionsDir, sessionId);
    if (cwd === null || !(await isPathPermitted(cwd, this.policy.files))) {
      return { events: [], nextCursor: options.cursor ?? 0 };
    }

    return provider === "claude"
      ? readClaudeSession(this.claudeProjectsDir, sessionId, options)
      : readCodexSession(this.codexSessionsDir, sessionId, options);
  }
}
