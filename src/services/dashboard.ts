import { all, get } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import type { ActivityFilters } from '../types.js';
import { buildWhere, orderBy } from '../posts/filters.js';
import { toPostDTO, type PostRow } from '../posts/mapper.js';
import { jobDTO } from './cleanup.js';

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

export async function dashboardSummary(accountId: string) {
  const counts = await get<{
    total: number;
    originals: number;
    replies: number;
    reposts: number;
    quotes: number;
    media: number;
    deleted: number;
    archived: number;
    likes: number;
    engagement: number;
    oldest: number | null;
    newest: number | null;
    media_photos: number;
  }>(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN kind = 'original' THEN 1 ELSE 0 END) AS originals,
      SUM(CASE WHEN kind = 'reply' THEN 1 ELSE 0 END) AS replies,
      SUM(CASE WHEN kind = 'repost' THEN 1 ELSE 0 END) AS reposts,
      SUM(CASE WHEN is_quote = 1 THEN 1 ELSE 0 END) AS quotes,
      SUM(CASE WHEN has_media = 1 THEN 1 ELSE 0 END) AS media,
      SUM(CASE WHEN is_deleted = 1 THEN 1 ELSE 0 END) AS deleted,
      SUM(CASE WHEN source = 'archive' THEN 1 ELSE 0 END) AS archived,
      SUM(like_count) AS likes,
      SUM(engagement) AS engagement,
      MIN(created_ts) AS oldest,
      MAX(created_ts) AS newest,
      SUM(CASE WHEN media_types LIKE '%photo%' THEN 1 ELSE 0 END) AS media_photos
     FROM posts WHERE account_id = ?`,
    accountId,
  );
  if (!counts) throw notFound('Account');

  const active = Number(counts.total ?? 0) - Number(counts.deleted ?? 0);

  const series = await all<{ month: string; total: number; replies: number; reposts: number; media: number }>(
    `SELECT
      to_char(to_timestamp(created_ts / 1000.0), 'YYYY-MM') AS month,
      COUNT(*) AS total,
      SUM(CASE WHEN kind = 'reply' THEN 1 ELSE 0 END) AS replies,
      SUM(CASE WHEN kind = 'repost' THEN 1 ELSE 0 END) AS reposts,
      SUM(CASE WHEN has_media = 1 THEN 1 ELSE 0 END) AS media
     FROM posts
     WHERE account_id = ? AND is_deleted = 0 AND created_ts >= ?
     GROUP BY month ORDER BY month ASC`,
    accountId,
    Date.now() - 365 * 2 * 86_400_000,
  );

  const oneYearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const twoYearsAgo = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

  const opportunity = async (filters: Partial<ActivityFilters>): Promise<{ count: number; filters: Partial<ActivityFilters> }> => {
    const full: ActivityFilters = {
      category: 'all',
      q: '',
      from: null,
      to: null,
      mediaType: 'any',
      minLikes: null,
      maxLikes: null,
      minEngagement: null,
      maxEngagement: null,
      source: 'any',
      sort: 'newest',
      page: 1,
      pageSize: 50,
      includeDeleted: false,
      ...filters,
    };
    const { where, params } = buildWhere(accountId, full);
    const count = Number((await get<{ n: number }>(`SELECT COUNT(*) AS n FROM posts WHERE ${where}`, ...params))?.n ?? 0);
    return { count, filters };
  };

  const opportunities = [
    {
      key: 'old-replies',
      title: 'Old replies',
      description: 'Replies older than a year. Often the easiest place to reclaim your timeline.',
      tone: 'amber',
      ...(await opportunity({ category: 'replies', to: oneYearAgo, sort: 'oldest' })),
    },
    {
      key: 'silent-posts',
      title: 'Silent posts',
      description: 'Posts with zero engagement, older than 90 days.',
      tone: 'slate',
      ...(await opportunity({ category: 'posts', maxEngagement: 0, to: ninetyDaysAgo })),
    },
    {
      key: 'old-originals',
      title: 'Archive candidates',
      description: 'Original posts older than two years that no longer represent you.',
      tone: 'teal',
      ...(await opportunity({ category: 'posts', to: twoYearsAgo })),
    },
    {
      key: 'media',
      title: 'Media posts',
      description: 'Photos, videos, and GIFs. Review before deleting anything with sentimental value.',
      tone: 'rose',
      ...(await opportunity({ category: 'media' })),
    },
  ];

  const recentJobs = (
    await all<JobRow>('SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT 5', accountId)
  ).map(jobDTO);

  const recentPosts = (
    await all<PostRow>(`SELECT * FROM posts WHERE account_id = ? AND is_deleted = 0 ORDER BY ${orderBy('newest')} LIMIT 5`, accountId)
  ).map(toPostDTO);

  return {
    stats: {
      total: active,
      originals: Number(counts.originals ?? 0),
      replies: Number(counts.replies ?? 0),
      reposts: Number(counts.reposts ?? 0),
      quotes: Number(counts.quotes ?? 0),
      media: Number(counts.media ?? 0),
      mediaPhotos: Number(counts.media_photos ?? 0),
      deleted: Number(counts.deleted ?? 0),
      archived: Number(counts.archived ?? 0),
      likes: Number(counts.likes ?? 0),
      engagement: Number(counts.engagement ?? 0),
      oldestAt: counts.oldest ? new Date(counts.oldest).toISOString() : null,
      newestAt: counts.newest ? new Date(counts.newest).toISOString() : null,
    },
    series,
    opportunities,
    recentJobs,
    recentPosts,
  };
}

