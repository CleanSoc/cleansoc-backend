import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../auth/session.js';
import { resolveAccountId } from '../auth/account.js';
import { dashboardSummary } from '../services/dashboard.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', async (request) => {
    requireAuth(request);
    const query = request.query as { accountId?: string };
    const accountId = await resolveAccountId(request, query.accountId);
    const summary = await dashboardSummary(accountId);
    return {
      ...summary,
      limits: { maxJobItems: config.limits.maxJobItems },
      demoMode: config.demoMode,
    };
  });
}


