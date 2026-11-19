import { run } from '../db/index.js';
import { id } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';

export type ActivityAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.demo'
  | 'account.connected'
  | 'account.disconnected'
  | 'account.switched'
  | 'sync.started'
  | 'sync.completed'
  | 'sync.failed'
  | 'sync.rate_limited'
  | 'cleanup.previewed'
  | 'cleanup.started'
  | 'cleanup.completed'
  | 'cleanup.cancelled'
  | 'cleanup.retry'
  | 'archive.imported'
  | 'archive.failed'
  | 'rules.saved'
  | 'rules.deleted'
  | 'data.exported'
  | 'data.deleted';

/**
 * Activity logging is best-effort: a logging failure must never break the
 * user-facing operation that produced it.
 */
export async function logActivity(input: {
  userId: string | null;
  accountId: string | null;
  action: ActivityAction;
  detail?: Record<string, unknown>;
  ip?: string | null;
}): Promise<void> {
  try {
    await run(
      `INSERT INTO activity_log (id, user_id, account_id, action, detail_json, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id('log'),
      input.userId,
      input.accountId,
      input.action,
      JSON.stringify(input.detail ?? {}),
      input.ip ?? null,
      nowIso(),
    );
  } catch (err) {
    console.error('[activity] failed to record event', input.action, err);
  }
}

