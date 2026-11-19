import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from '../config.js';

const { Pool, types } = pg;

// ─── Type parsers ─────────────────────────────────────────────────────────────
// The rest of the codebase was written against SQLite's dynamic types, where
// integers arrive as JavaScript numbers and timestamps as ISO strings. Keep that
// contract so the service layer stays simple.
types.setTypeParser(20, (value) => Number(value)); // int8 / bigint
types.setTypeParser(1700, (value) => Number(value)); // numeric (e.g. SUM)
types.setTypeParser(1114, (value) => new Date(`${value}Z`).toISOString()); // timestamp
types.setTypeParser(1184, (value) => new Date(value).toISOString()); // timestamptz

export const pool = new Pool({
  connectionString: config.database.url,
  max: config.database.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: config.database.ssl
    ? { rejectUnauthorized: config.database.sslRejectUnauthorized }
    : undefined,
  application_name: 'cleansoc',
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

const txStorage = new AsyncLocalStorage<pg.PoolClient>();
let savepointCounter = 0;

/** Rewrites `?` placeholders to PostgreSQL's positional `$1, $2, …` form. */
function toPositional(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function target(): pg.Pool | pg.PoolClient {
  return txStorage.getStore() ?? pool;
}

/** Small typed query helpers. Async by design — PostgreSQL has no sync driver. */
export async function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await target().query(toPositional(sql), params as unknown[]);
  return result.rows as T[];
}

export async function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
  const result = await target().query(toPositional(sql), params as unknown[]);
  return result.rows[0] as T | undefined;
}

export async function run(sql: string, ...params: unknown[]): Promise<pg.QueryResult> {
  return target().query(toPositional(sql), params as unknown[]);
}

export interface Queryable {
  all: typeof all;
  get: typeof get;
  run: typeof run;
}

const queryable: Queryable = { all, get, run };

/**
 * Runs `fn` inside a transaction. Nested calls become savepoints, and helpers
 * invoked from inside `fn` automatically reuse the same client through
 * AsyncLocalStorage — no client needs to be threaded through services.
 */
export async function transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const current = txStorage.getStore();
  if (current) {
    const name = `cleansoc_sp_${++savepointCounter}`;
    await current.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn(queryable);
      await current.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      await current.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw err;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txStorage.run(client, () => fn(queryable));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[db] rollback failed', rollbackError);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function ping(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

// ─── Migrations ───────────────────────────────────────────────────────────────

/**
 * Schema migrations. Each entry runs exactly once, in order. Append — never edit
 * an entry that has already shipped.
 *
 * Version 1 is the PostgreSQL baseline. Existing SQLite data is intentionally
 * not migrated: reconnect X or import a data archive into the new database.
 */
const migrations: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        x_user_id TEXT,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
        access_token_enc TEXT,
        refresh_token_enc TEXT,
        token_expires_at TIMESTAMPTZ,
        scopes TEXT NOT NULL DEFAULT '',
        connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_synced_at TIMESTAMPTZ,
        last_sync_status TEXT NOT NULL DEFAULT 'idle'
          CHECK (last_sync_status IN ('idle', 'syncing', 'complete', 'error', 'rate_limited', 'demo')),
        last_sync_error TEXT,
        last_sync_count INTEGER NOT NULL DEFAULT 0 CHECK (last_sync_count >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_x_user ON accounts(x_user_id)
        WHERE x_user_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        user_agent TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        browser_nonce TEXT NOT NULL,
        link_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        x_post_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('original', 'reply', 'repost')),
        text TEXT NOT NULL DEFAULT '',
        lang TEXT,
        source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'archive')),
        is_quote INTEGER NOT NULL DEFAULT 0 CHECK (is_quote IN (0, 1)),
        in_reply_to_id TEXT,
        in_reply_to_user TEXT,
        repost_of_id TEXT,
        quote_of_id TEXT,
        like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
        reply_count INTEGER NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
        repost_count INTEGER NOT NULL DEFAULT 0 CHECK (repost_count >= 0),
        quote_count INTEGER NOT NULL DEFAULT 0 CHECK (quote_count >= 0),
        impression_count INTEGER NOT NULL DEFAULT 0 CHECK (impression_count >= 0),
        engagement INTEGER NOT NULL DEFAULT 0 CHECK (engagement >= 0),
        has_media INTEGER NOT NULL DEFAULT 0 CHECK (has_media IN (0, 1)),
        media_count INTEGER NOT NULL DEFAULT 0 CHECK (media_count >= 0),
        media_types TEXT NOT NULL DEFAULT '',
        media_json TEXT NOT NULL DEFAULT '[]',
        urls_json TEXT NOT NULL DEFAULT '[]',
        author_username TEXT,
        author_name TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
        is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
        deleted_at TIMESTAMPTZ,
        deleted_by_job_id TEXT,
        archive_import_id TEXT,
        created_ts BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (account_id, x_post_id)
      );
      CREATE INDEX IF NOT EXISTS idx_posts_account_created ON posts(account_id, created_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_account_active_created ON posts(account_id, is_deleted, created_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_account_kind ON posts(account_id, kind);
      CREATE INDEX IF NOT EXISTS idx_posts_account_deleted ON posts(account_id, is_deleted);
      CREATE INDEX IF NOT EXISTS idx_posts_media ON posts(account_id, has_media);
      CREATE INDEX IF NOT EXISTS idx_posts_engagement ON posts(account_id, engagement DESC);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('delete', 'unrepost', 'mixed')),
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'paused', 'completed', 'completed_with_errors', 'cancelled', 'failed')
        ),
        total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
        processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),
        succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded >= 0),
        failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
        skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
        is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
        criteria_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        resume_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_resume ON jobs(status, resume_at);

      CREATE TABLE IF NOT EXISTS job_items (
        seq BIGINT GENERATED ALWAYS AS IDENTITY,
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        post_id TEXT NOT NULL,
        x_post_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('delete', 'unrepost')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'skipped')),
        error_code TEXT,
        error_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        processed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items(job_id, status, seq);
      CREATE INDEX IF NOT EXISTS idx_job_items_post ON job_items(post_id);

      CREATE TABLE IF NOT EXISTS activity_log (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        account_id TEXT,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_activity_account ON activity_log(account_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS saved_filters (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_filters_account ON saved_filters(account_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS archive_imports (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'complete', 'failed')),
        posts_found INTEGER NOT NULL DEFAULT 0 CHECK (posts_found >= 0),
        inserted INTEGER NOT NULL DEFAULT 0 CHECK (inserted >= 0),
        updated INTEGER NOT NULL DEFAULT 0 CHECK (updated >= 0),
        skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
        media_count INTEGER NOT NULL DEFAULT 0 CHECK (media_count >= 0),
        oldest_ts BIGINT,
        newest_ts BIGINT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_archive_account ON archive_imports(account_id, created_at DESC);
    `,
  },
];

export async function migrate(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const { rows } = await pool.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((row) => Number(row.version)));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
      await client.query('COMMIT');
      console.log(`[db] applied migration v${migration.version}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

