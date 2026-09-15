import DatabaseConstructor, { type Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  canTransition,
  isTerminalState,
  type BridgeTask,
  type CreateTaskInput,
  type ListFilter,
  type TaskState,
  type TransitionOptions,
  type RoutingProposal,
} from "../domain/task.js";
import { IllegalTaskTransitionError, TaskNotFoundError } from "../errors.js";
import { runMigrations } from "./migrations.js";

interface TaskRow {
  id: string;
  provider: string;
  cwd: string;
  prompt_bytes: number;
  state: string;
  parent_id: string | null;
  provider_session_id: string | null;
  exit_code: number | null;
  error_summary: string | null;
  profile_id: string | null; routing_root_id: string | null; routing_attempt: number; switch_reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): BridgeTask {
  return {
    id: row.id,
    provider: row.provider as BridgeTask["provider"],
    cwd: row.cwd,
    promptBytes: row.prompt_bytes,
    state: row.state as TaskState,
    parentId: row.parent_id,
    providerSessionId: row.provider_session_id,
    exitCode: row.exit_code,
    errorSummary: row.error_summary,
    profileId: row.profile_id, routingRootId: row.routing_root_id, routingAttempt: row.routing_attempt, switchReason: row.switch_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Owns the durable lifecycle of bridge tasks. The single source of truth for task state. */
export class TaskStore {
  private readonly db: Database;

  constructor(location: string) {
    this.db = new DatabaseConstructor(location);
    runMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  create(input: CreateTaskInput): BridgeTask {
    const now = new Date().toISOString();
    const task: BridgeTask = {
      id: randomUUID(),
      provider: input.provider,
      cwd: input.cwd,
      promptBytes: input.promptBytes,
      state: "queued",
      parentId: input.parentId ?? null,
      providerSessionId: null,
      exitCode: null,
      errorSummary: null,
      profileId: input.profileId ?? null, routingRootId: input.routingRootId ?? null, routingAttempt: input.routingAttempt ?? 0, switchReason: input.switchReason ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, provider, cwd, prompt_bytes, state, parent_id, provider_session_id, exit_code, error_summary, profile_id, routing_root_id, routing_attempt, switch_reason, created_at, updated_at)
         VALUES (@id, @provider, @cwd, @promptBytes, @state, @parentId, @providerSessionId, @exitCode, @errorSummary, @profileId, @routingRootId, @routingAttempt, @switchReason, @createdAt, @updatedAt)`,
      )
      .run(task);
    return task;
  }

  createProposal(input: { sourceTaskId: string; targetProfileId: string; reason: string }): RoutingProposal {
    const now = new Date().toISOString(); const proposal: RoutingProposal = { id: randomUUID(), ...input, state: "pending", createdAt: now, updatedAt: now };
    this.db.prepare(`INSERT INTO routing_proposals (id, source_task_id, target_profile_id, reason, state, created_at, updated_at) VALUES (@id, @sourceTaskId, @targetProfileId, @reason, @state, @createdAt, @updatedAt)`).run(proposal);
    return proposal;
  }

  approveProposal(id: string): RoutingProposal | undefined {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE routing_proposals SET state = 'approved', updated_at = @now WHERE id = @id AND state = 'pending' RETURNING id, source_task_id AS sourceTaskId, target_profile_id AS targetProfileId, reason, state, created_at AS createdAt, updated_at AS updatedAt`).get({ id, now }) as RoutingProposal | undefined;
    return result;
  }

  get(id: string): BridgeTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  transition(id: string, to: TaskState, options: TransitionOptions = {}): BridgeTask {
    const current = this.get(id);
    if (!current) throw new TaskNotFoundError(id);

    if (current.state === to && isTerminalState(to)) {
      // Idempotent: repeating a terminal transition (notably cancel) is a no-op.
      return current;
    }
    if (!canTransition(current.state, to)) {
      throw new IllegalTaskTransitionError(current.state, to);
    }

    const updatedAt = new Date().toISOString();
    const providerSessionId =
      options.providerSessionId !== undefined ? options.providerSessionId : current.providerSessionId;
    const exitCode = options.exitCode !== undefined ? options.exitCode : current.exitCode;
    const errorSummary = options.errorSummary !== undefined ? options.errorSummary : current.errorSummary;

    this.db
      .prepare(
        `UPDATE tasks SET state = @state, provider_session_id = @providerSessionId, exit_code = @exitCode,
         error_summary = @errorSummary, updated_at = @updatedAt WHERE id = @id`,
      )
      .run({ id, state: to, providerSessionId, exitCode, errorSummary, updatedAt });

    const next = this.get(id);
    if (!next) throw new TaskNotFoundError(id);
    return next;
  }

  /** Records the provider's session id without asserting any state transition. */
  updateProviderSessionId(id: string, providerSessionId: string): BridgeTask {
    const current = this.get(id);
    if (!current) throw new TaskNotFoundError(id);
    this.db
      .prepare(`UPDATE tasks SET provider_session_id = @providerSessionId, updated_at = @updatedAt WHERE id = @id`)
      .run({ id, providerSessionId, updatedAt: new Date().toISOString() });
    const next = this.get(id);
    if (!next) throw new TaskNotFoundError(id);
    return next;
  }

  list(filter: ListFilter = {}): BridgeTask[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.provider) {
      clauses.push("provider = @provider");
      params.provider = filter.provider;
    }
    if (filter.state) {
      clauses.push("state = @state");
      params.state = filter.state;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ?? 50;
    const rows = this.db
      // rowid (insertion order), not id (a random UUID), breaks ties within the same
      // created_at millisecond in actual creation order.
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, rowid DESC LIMIT @limit`)
      .all({ ...params, limit }) as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Marks every task this process instance can no longer be supervising (anything not already
   * terminal) as interrupted. Called once at startup, before accepting new work.
   */
  reconcileAfterRestart(): number {
    const result = this.db
      .prepare(
        `UPDATE tasks SET state = 'interrupted', updated_at = @updatedAt
         WHERE state NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')`,
      )
      .run({ updatedAt: new Date().toISOString() });
    return result.changes;
  }
}
