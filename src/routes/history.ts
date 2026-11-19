import type { FastifyInstance } from 'fastify';
import { all, get } from '../db/index.js';
import { requireAuth } from '../auth/session.js';
import { resolveAccountId } from '../auth/account.js';
import { jobDTO } from '../services/cleanup.js';

export async function historyRoutes(app: FastifyInstance) {
  app.get('/api/history', async (request) => {
    const auth = requireAuth(request);
    const query = request.query as { accountId?: string; limit?: string };
    const accountId = await resolveAccountId(request, query.accountId);
    const limit = Math.min(Number(query.limit ?? 100) || 100, 200);
    const jobs = (await all<any>(
      'SELECT * FROM jobs WHERE user_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT ?',
      auth.user.id,
      accountId,
      limit,
    )).map(jobDTO);
    const log = (await all<any>(
      'SELECT * FROM activity_log WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
      accountId,
      limit,
    )).map((row) => ({
      id: row.id,
      action: row.action,
      detail: safeJson(row.detail_json),
      createdAt: row.created_at,
    }));
    return { jobs, activity: log };
  });

  app.get('/api/history/overview', async (request) => {
    const auth = requireAuth(request);
    const query = request.query as { accountId?: string };
    const accountId = await resolveAccountId(request, query.accountId);
    const totals = await get<{ deleted: number; failed: number; jobs: number; reviewed: number }>(
      `SELECT
        (SELECT COUNT(*) FROM posts WHERE account_id = ? AND is_deleted = 1) AS deleted,
        (SELECT COUNT(*) FROM job_items ji JOIN jobs j ON j.id = ji.job_id WHERE j.account_id = ? AND ji.status = 'failed') AS failed,
        (SELECT COUNT(*) FROM jobs WHERE account_id = ?) AS jobs,
        (SELECT COUNT(*) FROM posts WHERE account_id = ?) AS reviewed`,
      accountId,
      accountId,
      accountId,
      accountId,
    );
    void auth;
    return {
      deleted: totals?.deleted ?? 0,
      failed: totals?.failed ?? 0,
      jobs: totals?.jobs ?? 0,
      reviewed: totals?.reviewed ?? 0,
    };
  });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}



