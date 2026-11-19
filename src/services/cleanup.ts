import { config } from '../config.js';
import { all, get, run, transaction } from '../db/index.js';
import { id } from '../lib/crypto.js';
import { ApiError, badRequest, notFound } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import type { ActivityFilters } from '../types.js';
import { buildWhere, describeFilters, orderBy } from '../posts/filters.js';
import { toPostDTO, type PostRow } from '../posts/mapper.js';
import { logActivity } from './activity.js';
import { getAccessToken, XApiError, xFetch } from '../x/client.js';
import { accountDTO } from '../auth/session.js';

const MAX_ATTEMPTS = 3;

interface JobRow {
  id: string;
  user_id: string;
  account_id: string;
  name: string;
  action: string;
  status: string;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  is_demo: number;
  criteria_json: string;
  error: string | null;
  resume_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface JobItemRow {
  id: string;
  job_id: string;
  post_id: string;
  x_post_id: string;
  kind: string;
  action: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  processed_at: string | null;
}

interface AccountRow {
  id: string;
  user_id: string;
  x_user_id: string | null;
  username: string;
  is_demo: number;
}

export function jobDTO(row: JobRow) {
  const pending = Math.max(row.total - row.succeeded - row.failed - row.skipped, 0);
  let criteria: Record<string, unknown> = {};
  try {
    criteria = JSON.parse(row.criteria_json);
  } catch {
    criteria = {};
  }
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    action: row.action,
    status: row.status,
    total: row.total,
    processed: row.processed,
    succeeded: row.succeeded,
    failed: row.failed,
    skipped: row.skipped,
    pending,
    progress: row.total > 0 ? Math.min(100, Math.round((row.processed / row.total) * 100)) : 0,
    criteria,
    error: row.error,
    resumeAt: row.resume_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    isDemo: Boolean(row.is_demo),
  };
}

export async function previewCleanup(accountId: string, filters: ActivityFilters, postIds?: string[]) {
  const selection = postIds?.length ? [...new Set(postIds)].slice(0, config.limits.maxJobItems) : null;
  const account = await get<{ is_demo: number }>('SELECT is_demo FROM accounts WHERE id = ?', accountId);
  const demo = account?.is_demo === 1;

  let where: string;
  let params: any[];
  if (selection) {
    where = `account_id = ? AND is_deleted = 0 AND id IN (${selection.map(() => '?').join(',')})`;
    params = [accountId, ...selection];
  } else {
    const built = buildWhere(accountId, { ...filters, includeDeleted: false });
    where = built.where;
    params = built.params;
  }

  const total = Number((await get<{ n: number }>(`SELECT COUNT(*) AS n FROM posts WHERE ${where}`, ...params))?.n ?? 0);
  const reposts = Number(
    (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM posts WHERE ${where} AND kind = 'repost'`, ...params))?.n ?? 0,
  );
  const sample = (
    await all<PostRow>(`SELECT * FROM posts WHERE ${where} ORDER BY ${orderBy(filters.sort)} LIMIT 12`, ...params)
  ).map(toPostDTO);

  const batch = Math.min(total, config.limits.maxJobItems);
  // X permits ~50 deletes per 15 minutes per user. Jobs pause automatically.
  const estimateSeconds = demo ? 20 : Math.ceil(batch * 18);
  return {
    total,
    deletable: total,
    reposts,
    posts: total - reposts,
    willProcess: batch,
    truncated: total > config.limits.maxJobItems,
    maxItems: config.limits.maxJobItems,
    simulated: demo,
    estimatedMinutes: Math.max(1, Math.ceil(estimateSeconds / 60)),
    sample,
    description: selection ? `${total} hand-picked ${total === 1 ? 'post' : 'posts'}` : describeFilters(filters),
    filters,
    postIds: selection ?? undefined,
    warning:
      'Deleting is permanent. X cannot restore deleted posts. Reposts are undone; original posts are deleted.',
  };
}

export interface CreateJobInput {
  accountId: string;
  userId: string;
  filters?: ActivityFilters;
  postIds?: string[];
  name?: string;
  ip?: string | null;
}

export async function createCleanupJob(input: CreateJobInput) {
  const account = await get<AccountRow>(
    'SELECT id, user_id, x_user_id, username, is_demo FROM accounts WHERE id = ?',
    input.accountId,
  );
  if (!account) throw notFound('Account');

  let rows: PostRow[];
  const filters: ActivityFilters | null = input.filters ?? null;

  if (input.postIds?.length) {
    const unique = [...new Set(input.postIds)].slice(0, config.limits.maxJobItems);
    const placeholders = unique.map(() => '?').join(',');
    rows = await all<PostRow>(
      `SELECT * FROM posts WHERE account_id = ? AND is_deleted = 0 AND id IN (${placeholders})`,
      input.accountId,
      ...unique,
    );
    if (rows.length === 0) throw badRequest('None of the selected posts are available to delete.');
  } else if (filters) {
    const { where, params } = buildWhere(input.accountId, { ...filters, includeDeleted: false });
    rows = await all<PostRow>(
      `SELECT * FROM posts WHERE ${where} ORDER BY ${orderBy(filters.sort)} LIMIT ?`,
      ...params,
      config.limits.maxJobItems,
    );
    if (rows.length === 0) throw badRequest('No posts match these filters.');
  } else {
    throw badRequest('Provide filters or postIds.');
  }

  const hasRepost = rows.some((r) => r.kind === 'repost');
  const hasPost = rows.some((r) => r.kind !== 'repost');
  const action = hasRepost && hasPost ? 'mixed' : hasRepost ? 'unrepost' : 'delete';
  const jobId = id('job');
  const now = nowIso();
  const criteria = {
    ...(filters ?? {}),
    postCount: rows.length,
    description: filters ? describeFilters(filters) : `${rows.length} hand-picked posts`,
  };

  await transaction(async () => {
    await run(
      `INSERT INTO jobs (id, user_id, account_id, name, action, status, total, is_demo, criteria_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      jobId,
      input.userId,
      input.accountId,
      input.name?.slice(0, 120) || (filters ? describeFilters(filters) : 'Selected posts'),
      action,
      rows.length,
      account.is_demo,
      JSON.stringify(criteria),
      now,
    );

    // Insert job items in batches to keep transactions short.
    const chunkSize = 200;
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const row of chunk) {
        tuples.push('(?, ?, ?, ?, ?, ?, \'pending\')');
        values.push(id('jit'), jobId, row.id, row.x_post_id, row.kind, row.kind === 'repost' ? 'unrepost' : 'delete');
      }
      await run(
        `INSERT INTO job_items (id, job_id, post_id, x_post_id, kind, action, status) VALUES ${tuples.join(', ')}`,
        ...values,
      );
    }
  });

  await logActivity({
    userId: input.userId,
    accountId: input.accountId,
    action: 'cleanup.started',
    detail: { jobId, total: rows.length, description: criteria.description, action },
    ip: input.ip,
  });

  return getJob(jobId, input.userId);
}

export async function getJob(jobId: string, userId: string) {
  const job = await get<JobRow>('SELECT * FROM jobs WHERE id = ? AND user_id = ?', jobId, userId);
  if (!job) throw notFound('Cleanup job');
  const items = await all<JobItemRow>(
    `SELECT * FROM job_items WHERE job_id = ? AND status != 'pending' ORDER BY processed_at DESC NULLS LAST LIMIT 200`,
    jobId,
  );
  const pendingSample = await all<JobItemRow>(
    `SELECT * FROM job_items WHERE job_id = ? AND status = 'pending' ORDER BY seq ASC LIMIT 20`,
    jobId,
  );
  return {
    ...jobDTO(job),
    failedItems: items
      .filter((i) => i.status === 'failed')
      .map((i) => ({
        id: i.id,
        xPostId: i.x_post_id,
        kind: i.kind,
        errorCode: i.error_code,
        error: i.error_message,
        attempts: i.attempts,
      })),
    recentItems: items.slice(0, 40).map((i) => ({
      id: i.id,
      xPostId: i.x_post_id,
      kind: i.kind,
      status: i.status,
      error: i.error_message,
      processedAt: i.processed_at,
    })),
    pendingSample: pendingSample.map((i) => ({ id: i.id, xPostId: i.x_post_id, kind: i.kind })),
  };
}

export async function listJobs(userId: string, accountId?: string) {
  const jobs = accountId
    ? await all<JobRow>(
        'SELECT * FROM jobs WHERE user_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT 50',
        userId,
        accountId,
      )
    : await all<JobRow>('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', userId);
  return jobs.map(jobDTO);
}

export async function cancelJob(jobId: string, userId: string) {
  const job = await get<JobRow>('SELECT * FROM jobs WHERE id = ? AND user_id = ?', jobId, userId);
  if (!job) throw notFound('Cleanup job');
  if (['completed', 'completed_with_errors', 'cancelled', 'failed'].includes(job.status)) {
    throw new ApiError(409, 'This job has already finished.', 'job_finished');
  }
  await transaction(async () => {
    await run(
      `UPDATE job_items SET status = 'skipped', processed_at = ? WHERE job_id = ? AND status = 'pending'`,
      nowIso(),
      jobId,
    );
    const skipped = Number(
      (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM job_items WHERE job_id = ? AND status = 'skipped'`, jobId))?.n ??
        0,
    );
    await run(
      `UPDATE jobs SET status = 'cancelled', finished_at = ?, resume_at = NULL,
        skipped = ?, processed = succeeded + failed + ? WHERE id = ?`,
      nowIso(),
      skipped,
      skipped,
      jobId,
    );
  });
  await logActivity({ userId, accountId: job.account_id, action: 'cleanup.cancelled', detail: { jobId } });
  return getJob(jobId, userId);
}

export async function retryFailed(jobId: string, userId: string) {
  const job = await get<JobRow>('SELECT * FROM jobs WHERE id = ? AND user_id = ?', jobId, userId);
  if (!job) throw notFound('Cleanup job');
  await transaction(async () => {
    await run(
      `UPDATE job_items SET status = 'pending', error_code = NULL, error_message = NULL, processed_at = NULL
       WHERE job_id = ? AND status = 'failed'`,
      jobId,
    );
    const counts = await get<{ failed: number; succeeded: number; skipped: number }>(
      `SELECT
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
       FROM job_items WHERE job_id = ?`,
      jobId,
    );
    await run(
      `UPDATE jobs SET status = 'running', failed = ?, succeeded = ?, skipped = ?,
        processed = ?, finished_at = NULL, error = NULL, resume_at = NULL WHERE id = ?`,
      counts?.failed ?? 0,
      counts?.succeeded ?? 0,
      counts?.skipped ?? 0,
      (counts?.failed ?? 0) + (counts?.succeeded ?? 0) + (counts?.skipped ?? 0),
      jobId,
    );
  });
  await logActivity({ userId, accountId: job.account_id, action: 'cleanup.retry', detail: { jobId } });
  return getJob(jobId, userId);
}

// ─── Worker ───────────────────────────────────────────────────────────────────

let workerBusy = false;
let workerTimer: NodeJS.Timeout | null = null;
const rateLimitedUntil = new Map<string, number>();

export function startCleanupWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    if (workerBusy) return;
    workerBusy = true;
    void tick().finally(() => {
      workerBusy = false;
    });
  }, 600);
  workerTimer.unref?.();
}

export function stopCleanupWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

async function tick(): Promise<void> {
  const now = nowIso();
  const job = await get<JobRow>(
    `SELECT * FROM jobs
     WHERE (status IN ('queued', 'running') AND (resume_at IS NULL OR resume_at <= ?))
        OR (status = 'paused' AND resume_at IS NOT NULL AND resume_at <= ?)
     ORDER BY created_at ASC LIMIT 1`,
    now,
    now,
  );
  if (!job) return;

  const account = await get<AccountRow>(
    'SELECT id, user_id, x_user_id, username, is_demo FROM accounts WHERE id = ?',
    job.account_id,
  );
  if (!account) {
    await run(
      "UPDATE jobs SET status = 'failed', error = 'Account was disconnected', finished_at = ? WHERE id = ?",
      nowIso(),
      job.id,
    );
    return;
  }

  const pausedUntil = rateLimitedUntil.get(job.account_id);
  if (pausedUntil && pausedUntil > Date.now()) {
    await run(
      "UPDATE jobs SET status = 'paused', resume_at = ?, error = 'Waiting for the X rate-limit window to reset.' WHERE id = ?",
      new Date(pausedUntil).toISOString(),
      job.id,
    );
    return;
  }

  if (!job.started_at) {
    await run("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", nowIso(), job.id);
  } else if (job.status === 'paused') {
    await run("UPDATE jobs SET status = 'running', resume_at = NULL, error = NULL WHERE id = ?", job.id);
  }

  const batchSize = account.is_demo === 1 ? 12 : 1;

  for (let i = 0; i < batchSize; i += 1) {
    const item = await get<JobItemRow>(
      `SELECT * FROM job_items WHERE job_id = ? AND status = 'pending' ORDER BY seq ASC LIMIT 1`,
      job.id,
    );
    if (!item) {
      await finalizeJob(job.id);
      return;
    }

    const result = await processItem(job, account, item);

    if (result === 'paused') {
      await run(
        "UPDATE jobs SET status = 'paused', resume_at = ?, error = ? WHERE id = ?",
        new Date(rateLimitedUntil.get(job.account_id) ?? Date.now() + 15 * 60_000).toISOString(),
        'X rate limit reached. The job will resume automatically.',
        job.id,
      );
      return;
    }
    if (result === 'defer') {
      await run(
        "UPDATE jobs SET status = 'paused', resume_at = ?, error = ? WHERE id = ?",
        new Date(Date.now() + 30_000).toISOString(),
        'A transient error occurred. Retrying automatically in 30 seconds.',
        job.id,
      );
      return;
    }
    if (result === 'blocked') {
      await run(
        "UPDATE jobs SET status = 'paused', resume_at = NULL, error = ? WHERE id = ?",
        'X authorization expired. Reconnect your account, then resume this job.',
        job.id,
      );
      return;
    }

    const refreshed = await get<JobRow>('SELECT * FROM jobs WHERE id = ?', job.id);
    if (!refreshed) return;
    if (refreshed.status === 'cancelled') return;
    const remaining = Number(
      (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM job_items WHERE job_id = ? AND status = 'pending'`, job.id))
        ?.n ?? 0,
    );
    if (remaining === 0) {
      await finalizeJob(job.id);
      return;
    }
    if (account.is_demo === 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // Recompute counters after the batch.
  await recomputeJob(job.id);
}

async function recomputeJob(jobId: string): Promise<void> {
  const counts = await get<{ success: number; failed: number; skipped: number; total: number }>(
    `SELECT
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
      COUNT(*) AS total
     FROM job_items WHERE job_id = ?`,
    jobId,
  );
  const success = counts?.success ?? 0;
  const failed = counts?.failed ?? 0;
  const skipped = counts?.skipped ?? 0;
  await run(
    'UPDATE jobs SET succeeded = ?, failed = ?, skipped = ?, processed = ? WHERE id = ?',
    success,
    failed,
    skipped,
    success + failed + skipped,
    jobId,
  );
}

async function finalizeJob(jobId: string): Promise<void> {
  const job = await get<JobRow>('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job || ['completed', 'completed_with_errors', 'cancelled'].includes(job.status)) return;
  const failed = Number(
    (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM job_items WHERE job_id = ? AND status = 'failed'`, jobId))?.n ?? 0,
  );
  const status = failed > 0 ? 'completed_with_errors' : 'completed';
  await recomputeJob(jobId);
  await run(
    "UPDATE jobs SET status = ?, finished_at = ?, resume_at = NULL, error = NULL WHERE id = ?",
    status,
    nowIso(),
    jobId,
  );
  await logActivity({
    userId: job.user_id,
    accountId: job.account_id,
    action: 'cleanup.completed',
    detail: { jobId, failed, status },
  });
}

async function processItem(
  job: JobRow,
  account: AccountRow,
  item: JobItemRow,
): Promise<'ok' | 'paused' | 'defer' | 'blocked'> {
  try {
    if (account.is_demo === 1) {
      // Fail a deterministic subset on the first attempt so retry flows can be demonstrated.
      const fails = item.x_post_id.endsWith('7') && item.attempts === 0;
      if (fails) {
        await markItemFailed(item, 'demo_failure', 'Simulated failure (demo data) — nothing was sent to X.');
      } else {
        await markItemSuccess(item, job.id);
      }
      await recomputeJob(job.id);
      return 'ok';
    }

    const token = await getAccessToken(account.id);
    if (item.action === 'unrepost') {
      const post = await get<{ repost_of_id: string | null }>('SELECT repost_of_id FROM posts WHERE id = ?', item.post_id);
      if (!post?.repost_of_id) {
        await markItemFailed(item, 'missing_source', 'Could not determine which post was reposted.');
        await recomputeJob(job.id);
        return 'ok';
      }
      await xFetch(`/2/users/${account.x_user_id}/retweets/${post.repost_of_id}`, {
        method: 'DELETE',
        token,
      });
    } else {
      await xFetch(`/2/tweets/${item.x_post_id}`, { method: 'DELETE', token });
    }
    await markItemSuccess(item, job.id);
    await recomputeJob(job.id);
    return 'ok';
  } catch (err) {
    if (err instanceof XApiError) {
      if (err.status === 429) {
        rateLimitedUntil.set(account.id, err.resetAt ?? Date.now() + 15 * 60_000);
        return 'paused';
      }
      if (err.status === 401) {
        return 'blocked';
      }
      if (err.status === 404) {
        await markItemSuccess(item, job.id, 'Already deleted on X');
        await recomputeJob(job.id);
        return 'ok';
      }
      if (err.status === 403) {
        await markItemFailed(
          item,
          'forbidden',
          'X refused this deletion. The post may not belong to this account, or write access was revoked.',
        );
        await recomputeJob(job.id);
        return 'ok';
      }
      if (err.status === 402) {
        await markItemFailed(
          item,
          'payment_required',
          'X requires a paid API access tier for deletions (Payment Required).',
        );
        await recomputeJob(job.id);
        return 'ok';
      }
      const attempts = item.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await markItemFailed(item, String(err.code), err.message, attempts);
      } else {
        await run('UPDATE job_items SET attempts = ? WHERE id = ?', attempts, item.id);
      }
      await recomputeJob(job.id);
      return 'ok';
    }

    const attempts = item.attempts + 1;
    const message = err instanceof Error ? err.message : 'Network error';
    if (attempts >= MAX_ATTEMPTS) {
      await markItemFailed(item, 'network_error', message, attempts);
    } else {
      await run('UPDATE job_items SET attempts = ? WHERE id = ?', attempts, item.id);
    }
    await recomputeJob(job.id);
    return 'ok';
  }
}

async function markItemSuccess(item: JobItemRow, jobId: string, note?: string): Promise<void> {
  const now = nowIso();
  await run(
    "UPDATE job_items SET status = 'success', error_code = NULL, error_message = ?, processed_at = ?, attempts = attempts + 1 WHERE id = ?",
    note ?? null,
    now,
    item.id,
  );
  await run(
    'UPDATE posts SET is_deleted = 1, deleted_at = ?, deleted_by_job_id = ?, updated_at = ? WHERE id = ?',
    now,
    jobId,
    now,
    item.post_id,
  );
}

async function markItemFailed(item: JobItemRow, code: string, message: string, attempts = item.attempts + 1): Promise<void> {
  await run(
    "UPDATE job_items SET status = 'failed', error_code = ?, error_message = ?, processed_at = ?, attempts = ? WHERE id = ?",
    code.slice(0, 120),
    message.slice(0, 500),
    nowIso(),
    attempts,
    item.id,
  );
}

export async function cleanupSummary(accountId: string) {
  const account = await get<AccountRow>('SELECT id, user_id, x_user_id, username, is_demo FROM accounts WHERE id = ?', accountId);
  if (!account) throw notFound('Account');
  const dto = accountDTO(
    (await get<any>(
      `SELECT a.*,
        (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.is_deleted = 0) AS total_posts,
        (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.is_deleted = 1) AS deleted_posts
       FROM accounts a WHERE a.id = ?`,
      accountId,
    ))!,
  );
  const jobs = await all<JobRow>('SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT 20', accountId);
  const totals = await get<{ deleted: number; failed: number; jobs: number }>(
    `SELECT
       (SELECT COUNT(*) FROM posts WHERE account_id = ? AND is_deleted = 1) AS deleted,
       (SELECT COUNT(*) FROM job_items ji JOIN jobs j ON j.id = ji.job_id WHERE j.account_id = ? AND ji.status = 'failed') AS failed,
       (SELECT COUNT(*) FROM jobs WHERE account_id = ?) AS jobs`,
    accountId,
    accountId,
    accountId,
  );
  return { account: dto, jobs: jobs.map(jobDTO), totals };
}

