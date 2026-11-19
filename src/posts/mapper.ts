import type { StoredMedia, StoredPost, XIncludes, XPost } from '../types.js';
import { toEpochMs } from '../lib/time.js';

export function mapXPost(post: XPost, includes: XIncludes | undefined, accountId: string): StoredPost {
  const refs = post.referenced_tweets ?? [];
  const retweet = refs.find((r) => r.type === 'retweeted');
  const quote = refs.find((r) => r.type === 'quoted');
  const reply = refs.find((r) => r.type === 'replied_to');

  const mediaByKey = new Map((includes?.media ?? []).map((m) => [m.media_key, m]));
  const media: StoredMedia[] = (post.attachments?.media_keys ?? [])
    .map((key) => mediaByKey.get(key))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => ({
      type: m.type,
      url: m.url ?? null,
      previewUrl: m.preview_image_url ?? null,
      altText: m.alt_text ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
      durationMs: m.duration_ms ?? null,
    }));

  // Reposts on the v2 timeline use the original post's media/text via expansions.
  const referencedPost = retweet
    ? includes?.tweets?.find((t) => t.id === retweet.id)
    : quote
      ? includes?.tweets?.find((t) => t.id === quote.id)
      : undefined;

  const effectiveMedia = media.length > 0 ? media : referencedPost ? mapReferencedMedia(referencedPost, includes) : [];
  const username = includes?.users?.find((u) => u.id === post.author_id)?.username ?? null;
  const name = includes?.users?.find((u) => u.id === post.author_id)?.name ?? null;

  const metrics = post.public_metrics ?? {};
  const createdAt = post.created_at ?? new Date().toISOString();
  const createdTs = toEpochMs(createdAt);

  return {
    id: '',
    accountId,
    xPostId: post.id,
    kind: retweet ? 'repost' : reply || post.in_reply_to_user_id ? 'reply' : 'original',
    text: post.text ?? (retweet ? `Repost of @${referencedPost?.entities?.mentions?.[0]?.username ?? 'post'}` : ''),
    lang: post.lang ?? null,
    source: 'api',
    isQuote: Boolean(quote),
    inReplyToId: reply?.id ?? null,
    inReplyToUser: post.in_reply_to_user_id ?? null,
    repostOfId: retweet?.id ?? null,
    quoteOfId: quote?.id ?? null,
    likeCount: metrics.like_count ?? 0,
    replyCount: metrics.reply_count ?? 0,
    repostCount: metrics.retweet_count ?? 0,
    quoteCount: metrics.quote_count ?? 0,
    impressionCount: metrics.impression_count ?? 0,
    engagement:
      (metrics.like_count ?? 0) + (metrics.reply_count ?? 0) + (metrics.retweet_count ?? 0) + (metrics.quote_count ?? 0),
    hasMedia: effectiveMedia.length > 0,
    mediaCount: effectiveMedia.length,
    mediaTypes: [...new Set(effectiveMedia.map((m) => m.type))].join(','),
    media: effectiveMedia,
    urls: (post.entities?.urls ?? []).map((u) => u.expanded_url ?? u.url).filter((u): u is string => Boolean(u)),
    authorUsername: username,
    authorName: name,
    isPinned: false,
    isDeleted: false,
    deletedAt: null,
    archiveImportId: null,
    createdAt: new Date(createdTs).toISOString(),
    createdTs,
  };
}

function mapReferencedMedia(post: XPost, includes: XIncludes | undefined): StoredMedia[] {
  const mediaByKey = new Map((includes?.media ?? []).map((m) => [m.media_key, m]));
  return (post.attachments?.media_keys ?? [])
    .map((key) => mediaByKey.get(key))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => ({
      type: m.type,
      url: m.url ?? null,
      previewUrl: m.preview_image_url ?? null,
      altText: m.alt_text ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
      durationMs: m.duration_ms ?? null,
    }));
}

export interface PostRow {
  id: string;
  account_id: string;
  x_post_id: string;
  kind: string;
  text: string;
  lang: string | null;
  source: string;
  is_quote: number;
  in_reply_to_id: string | null;
  in_reply_to_user: string | null;
  repost_of_id: string | null;
  quote_of_id: string | null;
  like_count: number;
  reply_count: number;
  repost_count: number;
  quote_count: number;
  impression_count: number;
  engagement: number;
  has_media: number;
  media_count: number;
  media_types: string;
  media_json: string;
  urls_json: string;
  author_username: string | null;
  author_name: string | null;
  is_pinned: number;
  is_deleted: number;
  deleted_at: string | null;
  archive_import_id: string | null;
  created_ts: number;
  created_at: string;
}

export function toPostDTO(row: PostRow) {
  return {
    id: row.id,
    xPostId: row.x_post_id,
    kind: row.kind,
    text: row.text,
    lang: row.lang,
    source: row.source,
    isQuote: Boolean(row.is_quote),
    inReplyToId: row.in_reply_to_id,
    inReplyToUser: row.in_reply_to_user,
    repostOfId: row.repost_of_id,
    quoteOfId: row.quote_of_id,
    metrics: {
      likes: row.like_count,
      replies: row.reply_count,
      reposts: row.repost_count,
      quotes: row.quote_count,
      impressions: row.impression_count,
      engagement: row.engagement,
    },
    media: safeJson(row.media_json, []),
    urls: safeJson(row.urls_json, []),
    author: { username: row.author_username, name: row.author_name },
    hasMedia: Boolean(row.has_media),
    mediaCount: row.media_count,
    isPinned: Boolean(row.is_pinned),
    isDeleted: Boolean(row.is_deleted),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    timestamp: row.created_ts,
    isDemoActionable: true,
  };
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

