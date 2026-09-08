import type Database from "better-sqlite3";

interface Migration {
  readonly version: number;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        prompt_bytes INTEGER NOT NULL,
        state TEXT NOT NULL,
        parent_id TEXT,
        provider_session_id TEXT,
        exit_code INTEGER,
        error_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_state ON tasks(state);
      CREATE INDEX idx_tasks_provider ON tasks(provider);
      CREATE INDEX idx_tasks_created_at ON tasks(created_at);
    `,
  },
];

/** Applies pending schema migrations transactionally, in order, tracked by version. */
export function runMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const appliedRow = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  const applied = appliedRow?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
    });
    apply();
  }
}
