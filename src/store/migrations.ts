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
  {
    version: 2,
    sql: `
      -- OAuth client_secret is stored as issued (plaintext), because the SDK's own
      -- authenticateClient middleware compares it directly and does not accept a hash.
      -- Every other secret below (codes, tokens, recovery code, local bearer token) is
      -- stored only as a SHA-256 hash; the plaintext exists once, at issuance.
      CREATE TABLE oauth_clients (
        client_id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT,
        expires_at TEXT NOT NULL,
        family_id TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_oauth_tokens_family ON oauth_tokens(family_id);

      CREATE TABLE owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        recovery_code_hash TEXT,
        local_bearer_token_hash TEXT,
        enrolled_at TEXT
      );
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
