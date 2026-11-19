import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, run } from '../db/index.js';
import { id } from '../lib/crypto.js';
import { requireAuth } from '../auth/session.js';
import { resolveAccountId } from '../auth/account.js';
import { notFound } from '../lib/errors.js';
import { normalizeFilters } from '../posts/filters.js';
import { nowIso } from '../lib/time.js';
import { logActivity } from '../services/activity.js';

export async function ruleRoutes(app: FastifyInstance) {
  app.get('/api/rules', async (request) => {
    const auth = requireAuth(request);
    const query = request.query as { accountId?: string };
    const accountId = await resolveAccountId(request, query.accountId);
    const rows = await all<any>(
      'SELECT * FROM saved_filters WHERE account_id = ? AND user_id = ? ORDER BY created_at DESC',
      accountId,
      auth.user.id,
    );
    return {
      rules: rows.map((row) => ({
        id: row.id,
        name: row.name,
        filters: safeJson(row.filters_json),
        createdAt: row.created_at,
      })),
    };
  });

  app.post('/api/rules', async (request) => {
    const auth = requireAuth(request);
    const body = z
      .object({ accountId: z.string().optional(), name: z.string().trim().min(1).max(80), filters: z.unknown() })
      .parse(request.body ?? {});
    const accountId = await resolveAccountId(request, body.accountId);
    const filters = normalizeFilters(body.filters, { page: 1 });
    const ruleId = id('flt');
    await run(
      'INSERT INTO saved_filters (id, user_id, account_id, name, filters_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ruleId,
      auth.user.id,
      accountId,
      body.name,
      JSON.stringify(filters),
      nowIso(),
    );
    void logActivity({ userId: auth.user.id, accountId, action: 'rules.saved', detail: { ruleId, name: body.name } });
    return { id: ruleId, name: body.name, filters };
  });

  app.delete<{ Params: { id: string } }>('/api/rules/:id', async (request) => {
    const auth = requireAuth(request);
    const row = await get<{ id: string; account_id: string }>(
      'SELECT id, account_id FROM saved_filters WHERE id = ? AND user_id = ?',
      request.params.id,
      auth.user.id,
    );
    if (!row) throw notFound('Saved filter');
    await run('DELETE FROM saved_filters WHERE id = ?', row.id);
    void logActivity({ userId: auth.user.id, accountId: row.account_id, action: 'rules.deleted', detail: { ruleId: row.id } });
    return { ok: true };
  });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}



