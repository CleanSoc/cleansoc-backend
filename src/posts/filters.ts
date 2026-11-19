import { z } from 'zod';
import type { ActivityFilters } from '../types.js';

export const filtersSchema = z
  .object({
    category: z.enum(['all', 'posts', 'replies', 'reposts', 'media', 'quotes']).default('all'),
    q: z.string().trim().max(200).default(''),
    from: z.string().trim().max(40).nullish(),
    to: z.string().trim().max(40).nullish(),
    mediaType: z.enum(['any', 'photo', 'video', 'animated_gif']).default('any'),
    minLikes: z.coerce.number().int().min(0).max(1_000_000_000).nullish(),
    maxLikes: z.coerce.number().int().min(0).max(1_000_000_000).nullish(),
    minEngagement: z.coerce.number().int().min(0).max(1_000_000_000).nullish(),
    maxEngagement: z.coerce.number().int().min(0).max(1_000_000_000).nullish(),
    source: z.enum(['any', 'api', 'archive']).default('any'),
    sort: z.enum(['newest', 'oldest', 'engagement', 'engagement_asc']).default('newest'),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    includeDeleted: z
      .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
      .transform((v) => v === true || v === 'true' || v === '1')
      .default(false),
  })
  .strip();

export type RawFilters = z.infer<typeof filtersSchema>;

export function normalizeFilters(input: unknown, overrides: Partial<ActivityFilters> = {}): ActivityFilters {
  const parsed = filtersSchema.parse(input ?? {});
  return {
    category: parsed.category,
    q: parsed.q ?? '',
    from: parsed.from ?? null,
    to: parsed.to ?? null,
    mediaType: parsed.mediaType,
    minLikes: parsed.minLikes ?? null,
    maxLikes: parsed.maxLikes ?? null,
    minEngagement: parsed.minEngagement ?? null,
    maxEngagement: parsed.maxEngagement ?? null,
    source: parsed.source,
    sort: parsed.sort,
    page: parsed.page,
    pageSize: parsed.pageSize,
    includeDeleted: parsed.includeDeleted ?? false,
    ...overrides,
  };
}

/** Parses `from=2024-01-01` or a full ISO timestamp safely. */
function dateBoundary(value: string | null, endOfDay: boolean): string | null {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = Date.parse(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

export interface SqlFragment {
  where: string;
  params: unknown[];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Builds a parameterised WHERE clause. This is the single source of truth for
 * both the activity list and cleanup snapshots, so what you see is what runs.
 */
export function buildWhere(accountId: string, filters: ActivityFilters): SqlFragment {
  const clauses: string[] = ['account_id = ?'];
  const params: unknown[] = [accountId];

  if (!filters.includeDeleted) clauses.push('is_deleted = 0');

  switch (filters.category) {
    case 'posts':
      clauses.push("kind = 'original'");
      break;
    case 'replies':
      clauses.push("kind = 'reply'");
      break;
    case 'reposts':
      clauses.push("kind = 'repost'");
      break;
    case 'quotes':
      clauses.push('is_quote = 1');
      break;
    case 'media':
      clauses.push('has_media = 1');
      break;
  }

  if (filters.q) {
    clauses.push("text ILIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(filters.q)}%`);
  }

  const from = dateBoundary(filters.from, false);
  if (from) {
    clauses.push('created_ts >= ?');
    params.push(Date.parse(from));
  }
  const to = dateBoundary(filters.to, true);
  if (to) {
    clauses.push('created_ts <= ?');
    params.push(Date.parse(to));
  }

  if (filters.mediaType !== 'any') {
    clauses.push("media_types LIKE ?");
    params.push(`%${filters.mediaType}%`);
  }

  if (filters.minLikes !== null) {
    clauses.push('like_count >= ?');
    params.push(filters.minLikes);
  }
  if (filters.maxLikes !== null) {
    clauses.push('like_count <= ?');
    params.push(filters.maxLikes);
  }
  if (filters.minEngagement !== null) {
    clauses.push('engagement >= ?');
    params.push(filters.minEngagement);
  }
  if (filters.maxEngagement !== null) {
    clauses.push('engagement <= ?');
    params.push(filters.maxEngagement);
  }
  if (filters.source !== 'any') {
    clauses.push('source = ?');
    params.push(filters.source);
  }

  return { where: clauses.join(' AND '), params };
}

export function orderBy(sort: ActivityFilters['sort']): string {
  switch (sort) {
    case 'oldest':
      return 'created_ts ASC';
    case 'engagement':
      return 'engagement DESC, created_ts DESC';
    case 'engagement_asc':
      return 'engagement ASC, created_ts DESC';
    default:
      return 'created_ts DESC';
  }
}

export function describeFilters(filters: ActivityFilters): string {
  const parts: string[] = [];
  const categoryLabels: Record<string, string> = {
    all: 'All activity',
    posts: 'Original posts',
    replies: 'Replies',
    reposts: 'Reposts',
    media: 'Media posts',
    quotes: 'Quote posts',
  };
  parts.push(categoryLabels[filters.category] ?? filters.category);
  if (filters.q) parts.push(`matching “${filters.q}”`);
  if (filters.from) parts.push(`from ${filters.from.slice(0, 10)}`);
  if (filters.to) parts.push(`to ${filters.to.slice(0, 10)}`);
  if (filters.mediaType !== 'any') parts.push(`${filters.mediaType} only`);
  if (filters.minLikes !== null) parts.push(`≥ ${filters.minLikes} likes`);
  if (filters.maxLikes !== null) parts.push(`≤ ${filters.maxLikes} likes`);
  if (filters.minEngagement !== null) parts.push(`≥ ${filters.minEngagement} engagement`);
  if (filters.maxEngagement !== null) parts.push(`≤ ${filters.maxEngagement} engagement`);
  if (filters.source !== 'any') parts.push(`${filters.source} data`);
  return parts.join(' · ');
}

