import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { get, all } from '../db/index.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/session.js';
import { resolveAccountId } from '../auth/account.js';
import { normalizeFilters, buildWhere, orderBy, filtersSchema } from '../posts/filters.js';
import { toPostDTO, type PostRow } from '../posts/mapper.js';
import { notFound, badRequest } from '../lib/errors.js';

export async function activityRoutes(app: FastifyInstance) {
  app.get('/api/activity', async (request) => {
    const auth = requireAuth(request);
    const query = request.query as Record<string, string | undefined>;
    const accountId = await resolveAccountId(request, query.accountId);
    const filters = normalizeFilters(query);
    const { where, params } = buildWhere(accountId, filters);

    const total = Number((await get<{ n: number }>(`SELECT COUNT(*) AS n FROM posts WHERE ${where}`, ...params))?.n ?? 0);
    const offset = (filters.page - 1) * filters.pageSize;
    const rows = await all<PostRow>(
      `SELECT * FROM posts WHERE ${where} ORDER BY ${orderBy(filters.sort)} LIMIT ? OFFSET ?`,
      ...params,
      filters.pageSize,
      offset,
    );

    // Facet counts ignore the category tab but keep every other filter.
    const facetFilters = { ...filters, category: 'all' as const, includeDeleted: false };
    const facetWhere = buildWhere(accountId, facetFilters);
    const facet = await get<Record<string, number>>(
      `SELECT
        COUNT(*) AS all_count,
        SUM(CASE WHEN kind = 'original' THEN 1 ELSE 0 END) AS posts,
        SUM(CASE WHEN kind = 'reply' THEN 1 ELSE 0 END) AS replies,
        SUM(CASE WHEN kind = 'repost' THEN 1 ELSE 0 END) AS reposts,
        SUM(CASE WHEN has_media = 1 THEN 1 ELSE 0 END) AS media,
        SUM(CASE WHEN is_quote = 1 THEN 1 ELSE 0 END) AS quotes
       FROM posts WHERE ${facetWhere.where}`,
      ...facetWhere.params,
    );

    return {
      accountId,
      items: rows.map(toPostDTO),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      hasMore: offset + rows.length < total,
      filters,
      facets: {
        all: Number(facet?.all_count ?? 0),
        posts: Number(facet?.posts ?? 0),
        replies: Number(facet?.replies ?? 0),
        reposts: Number(facet?.reposts ?? 0),
        media: Number(facet?.media ?? 0),
        quotes: Number(facet?.quotes ?? 0),
      },
      limits: { maxJobItems: config.limits.maxJobItems },
      userId: auth.user.id,
    };
  });

  /** Materialises every matching post ID (capped) so bulk actions are exact. */
  app.post('/api/activity/ids', async (request) => {
    requireAuth(request);
    const body = z
      .object({ accountId: z.string().optional(), filters: z.unknown() })
      .parse(request.body ?? {});
    const accountId = await resolveAccountId(request, body.accountId);
    const filters = normalizeFilters(body.filters, { page: 1 });
    const { where, params } = buildWhere(accountId, { ...filters, includeDeleted: false });
    const total = Number((await get<{ n: number }>(`SELECT COUNT(*) AS n FROM posts WHERE ${where}`, ...params))?.n ?? 0);
    const rows = await all<{ id: string; kind: string }>(
      `SELECT id, kind FROM posts WHERE ${where} ORDER BY ${orderBy(filters.sort)} LIMIT ?`,
      ...params,
      config.limits.maxJobItems,
    );
    if (total === 0) throw badRequest('No posts match these filters.');
    return {
      ids: rows.map((r) => r.id),
      total,
      capped: total > rows.length,
      maxItems: config.limits.maxJobItems,
      reposts: rows.filter((r) => r.kind === 'repost').length,
    };
  });

  app.get<{ Params: { id: string }; Querystring: { accountId?: string } }>('/api/posts/:id', async (request) => {
    requireAuth(request);
    const accountId = await resolveAccountId(request, request.query.accountId);
    const row = await get<PostRow>('SELECT * FROM posts WHERE id = ? AND account_id = ?', request.params.id, accountId);
    if (!row) throw notFound('Post');
    return toPostDTO(row);
  });

  app.get('/api/activity/filters-schema', async () => filtersSchema.shape);
}


