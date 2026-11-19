import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get } from '../db/index.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/session.js';
import { resolveAccountId } from '../auth/account.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { normalizeFilters } from '../posts/filters.js';
import {
  cancelJob,
  cleanupSummary,
  createCleanupJob,
  getJob,
  jobDTO,
  listJobs,
  previewCleanup,
  retryFailed,
} from '../services/cleanup.js';
import { logActivity } from '../services/activity.js';
import { run } from '../db/index.js';

export async function cleanupRoutes(app: FastifyInstance) {
  app.post('/api/cleanup/preview', async (request) => {
    requireAuth(request);
    const body = z
      .object({
        accountId: z.string().optional(),
        filters: z.unknown().optional(),
        postIds: z.array(z.string()).max(5000).optional(),
      })
      .parse(request.body ?? {});
    const accountId = await resolveAccountId(request, body.accountId);
    if (!body.postIds?.length && !body.filters) {
      throw badRequest('Provide filters or postIds.');
    }
    const filters = normalizeFilters(body.filters, { page: 1, pageSize: 50 });
    return await previewCleanup(accountId, filters, body.postIds);
  });

  app.post('/api/cleanup/jobs', async (request) => {
    const auth = requireAuth(request);
    const body = z
      .object({
        accountId: z.string().optional(),
        filters: z.unknown().optional(),
        postIds: z.array(z.string()).max(5000).optional(),
        name: z.string().trim().max(120).optional(),
        confirmation: z.string(),
        acknowledgeIrreversible: z.boolean(),
      })
      .parse(request.body ?? {});

    if (body.confirmation !== 'DELETE') {
      throw badRequest('Type DELETE to confirm this cleanup job.');
    }
    if (!body.acknowledgeIrreversible) {
      throw badRequest('You must acknowledge that deleted posts cannot be restored.');
    }
    if (!body.postIds?.length && !body.filters) {
      throw badRequest('Provide a selection or filters.');
    }

    const accountId = await resolveAccountId(request, body.accountId);
    const existing = await get<{ id: string }>(
      "SELECT id FROM jobs WHERE account_id = ? AND status IN ('queued','running','paused') LIMIT 1",
      accountId,
    );
    if (existing) {
      throw conflict('A cleanup job is already active for this account. Let it finish or cancel it first.');
    }

    const filters = body.filters ? normalizeFilters(body.filters, { page: 1 }) : undefined;
    const job = await createCleanupJob({
      accountId,
      userId: auth.user.id,
      filters,
      postIds: body.postIds,
      name: body.name,
      ip: request.ip,
    });
    void logActivity({
      userId: auth.user.id,
      accountId,
      action: 'cleanup.previewed',
      detail: { jobId: job.id, total: job.total },
      ip: request.ip,
    });
    return job;
  });

  app.get('/api/cleanup/jobs', async (request) => {
    const auth = requireAuth(request);
    const query = request.query as { accountId?: string };
    const accountId = await resolveAccountId(request, query.accountId);
    return { jobs: await listJobs(auth.user.id, accountId) };
  });

  app.get<{ Params: { id: string } }>('/api/cleanup/jobs/:id', async (request) => {
    const auth = requireAuth(request);
    return await getJob(request.params.id, auth.user.id);
  });

  app.post<{ Params: { id: string } }>('/api/cleanup/jobs/:id/cancel', async (request) => {
    const auth = requireAuth(request);
    return await cancelJob(request.params.id, auth.user.id);
  });

  app.post<{ Params: { id: string } }>('/api/cleanup/jobs/:id/retry-failed', async (request) => {
    const auth = requireAuth(request);
    return await retryFailed(request.params.id, auth.user.id);
  });

  app.post<{ Params: { id: string } }>('/api/cleanup/jobs/:id/resume', async (request) => {
    const auth = requireAuth(request);
    const job = await get<{ id: string; user_id: string; status: string; account_id: string }>(
      'SELECT * FROM jobs WHERE id = ? AND user_id = ?',
      request.params.id,
      auth.user.id,
    );
    if (!job) throw notFound('Cleanup job');
    if (job.status !== 'paused') throw badRequest('Only paused jobs can be resumed.');
    await run("UPDATE jobs SET status = 'running', resume_at = NULL, error = NULL WHERE id = ?", job.id);
    return await getJob(job.id, auth.user.id);
  });

  app.get('/api/cleanup/summary', async (request) => {
    const auth = requireAuth(request);
    const query = request.query as { accountId?: string };
    const accountId = await resolveAccountId(request, query.accountId);
    void auth;
    return await cleanupSummary(accountId);
  });

  app.get('/api/cleanup/limits', async () => ({
    maxJobItems: config.limits.maxJobItems,
    deleteRateWindow: '50 deletes / 15 minutes (enforced by X)',
    autoResume: true,
  }));
}



