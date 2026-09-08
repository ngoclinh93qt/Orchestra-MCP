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
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, provider, cwd, prompt_bytes, state, parent_id, provider_session_id, exit_code, error_summary, created_at, updated_at)
         VALUES (@id, @provider, @cwd, @promptBytes, @state, @parentId, @providerSessionId, @exitCode, @errorSummary, @createdAt, @updatedAt)`,
      )
      .run(task);
    return task;
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
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, id DESC LIMIT @limit`)
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
