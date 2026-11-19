import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { all, get, run } from '../db/index.js';
import { accountDTO, listUserAccounts, requireAuth, setActiveAccount } from '../auth/session.js';
import { resolveAccountId } from '../auth/account.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { loadAuthFromRequest } from '../auth/session.js';
import { logActivity } from '../services/activity.js';
import { syncAccount } from '../x/sync.js';

export async function accountRoutes(app: FastifyInstance) {
  app.get('/api/accounts', async (request) => {
    const auth = requireAuth(request);
    return { accounts: (await listUserAccounts(auth.user.id)).map(accountDTO), activeAccountId: auth.account.id };
  });

  app.post<{ Params: { id: string } }>('/api/accounts/:id/activate', async (request) => {
    const auth = requireAuth(request);
    const account = await get<{ id: string }>('SELECT id FROM accounts WHERE id = ? AND user_id = ?', request.params.id, auth.user.id);
    if (!account) throw notFound('Account');
    await setActiveAccount(request, account.id);
    void logActivity({ userId: auth.user.id, accountId: account.id, action: 'account.switched' });
    return { activeAccountId: account.id };
  });

  app.post<{ Params: { id: string } }>('/api/accounts/:id/sync', async (request, reply) => {
    const auth = requireAuth(request);
    const accountId = await resolveAccountId(request, request.params.id);
    const account = await get<{ id: string; is_demo: number; last_sync_status: string }>(
      'SELECT id, is_demo, last_sync_status FROM accounts WHERE id = ?',
      accountId,
    );
    if (!account) throw notFound('Account');
    if (account.is_demo === 1) {
      return reply.code(200).send({ started: false, reason: 'Demo accounts use a static sample dataset.' });
    }
    if (account.last_sync_status === 'syncing') {
      return reply.code(202).send({ started: false, reason: 'A sync is already running.' });
    }
    void logActivity({ userId: auth.user.id, accountId, action: 'sync.started' });
    void syncAccount(accountId);
    return reply.code(202).send({
      started: true,
      note: 'Sync runs in the background. This page will refresh automatically.',
      maxPosts: config.limits.syncMaxPages * 100,
    });
  });

  app.get<{ Params: { id: string } }>('/api/accounts/:id/export', async (request, reply) => {
    const auth = requireAuth(request);
    const accountId = await resolveAccountId(request, request.params.id);
    const account = await get<{ username: string }>('SELECT username FROM accounts WHERE id = ?', accountId);
    if (!account) throw notFound('Account');
    const posts = await all<any>('SELECT * FROM posts WHERE account_id = ? ORDER BY created_ts ASC', accountId);
    const jobs = await all<any>('SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at ASC', accountId);
    const payload = {
      exportedAt: new Date().toISOString(),
      account: { username: account.username },
      posts: posts.map((p) => ({
        xPostId: p.x_post_id,
        kind: p.kind,
        text: p.text,
        createdAt: p.created_at,
        likeCount: p.like_count,
        replyCount: p.reply_count,
        repostCount: p.repost_count,
        quoteCount: p.quote_count,
        media: JSON.parse(p.media_json || '[]'),
        isDeleted: Boolean(p.is_deleted),
        source: p.source,
      })),
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        total: j.total,
        succeeded: j.succeeded,
        failed: j.failed,
        createdAt: j.created_at,
      })),
    };
    void logActivity({ userId: auth.user.id, accountId, action: 'data.exported' });
    reply.header('Content-Disposition', `attachment; filename="cleansoc-${account.username}.json"`);
    reply.type('application/json');
    return payload;
  });

  app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>('/api/accounts/:id', async (request, reply) => {
    const auth = requireAuth(request);
    const accountId = await resolveAccountId(request, request.params.id);
    if (request.query.confirm !== 'DELETE') throw badRequest('Confirm account deletion with ?confirm=DELETE');
    const account = await get<{ username: string; is_demo: number }>('SELECT username, is_demo FROM accounts WHERE id = ?', accountId);
    if (!account) throw notFound('Account');

    // Never allow deleting the last account while the session depends on it.
    const remaining = (await listUserAccounts(auth.user.id)).filter((a) => a.id !== accountId);
    await run('DELETE FROM accounts WHERE id = ?', accountId);
    await run('DELETE FROM sessions WHERE account_id = ?', accountId);
    void logActivity({ userId: auth.user.id, accountId: null, action: 'account.disconnected', detail: { username: account.username } });

    if (remaining.length === 0) {
      reply.clearCookie(config.sessionCookie, { path: '/' });
      return { ok: true, signedOut: true };
    }
    const next = remaining[0];
    await run('UPDATE sessions SET account_id = ? WHERE user_id = ?', next.id, auth.user.id);
    return { ok: true, signedOut: false, activeAccountId: next.id };
  });

  app.delete('/api/me/data', async (request, reply) => {
    const auth = requireAuth(request);
    await run('DELETE FROM users WHERE id = ?', auth.user.id);
    reply.clearCookie(config.sessionCookie, { path: '/' });
    void logActivity({ userId: null, accountId: null, action: 'data.deleted', detail: { userId: auth.user.id } });
    return { ok: true };
  });

  app.get('/api/accounts/:id/sync-status', async (request) => {
    requireAuth(request);
    const accountId = await resolveAccountId(request, (request.params as { id: string }).id);
    const row = await get<any>(
      `SELECT a.id, a.last_sync_status, a.last_sync_error, a.last_sync_count, a.last_synced_at,
        (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.is_deleted = 0) AS total_posts
       FROM accounts a WHERE a.id = ?`,
      accountId,
    );
    if (!row) throw notFound('Account');
    return {
      status: row.last_sync_status,
      error: row.last_sync_error,
      count: row.last_sync_count,
      totalPosts: row.total_posts,
      lastSyncedAt: row.last_synced_at,
    };
  });
}


