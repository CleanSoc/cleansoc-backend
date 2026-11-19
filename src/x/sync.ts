import { config } from '../config.js';
import { get, run } from '../db/index.js';
import { id } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';
import { logActivity } from '../services/activity.js';
import type { XIncludes, XPost } from '../types.js';
import { mapXPost } from '../posts/mapper.js';
import { getAccessToken, XApiError, xFetch } from './client.js';

const activeSyncs = new Set<string>();

interface TimelineResponse {
  data?: XPost[];
  includes?: XIncludes;
  meta?: { next_token?: string; result_count?: number; newest_id?: string; oldest_id?: string };
}

interface AccountSyncRow {
  id: string;
  user_id: string;
  x_user_id: string | null;
  username: string;
  is_demo: number;
}

export function isSyncing(accountId: string): boolean {
  return activeSyncs.has(accountId);
}

export async function syncAccount(accountId: string): Promise<void> {
  if (activeSyncs.has(accountId)) return;
  const account = await get<AccountSyncRow>(
    'SELECT id, user_id, x_user_id, username, is_demo FROM accounts WHERE id = ?',
    accountId,
  );
  if (!account) return;
  if (account.is_demo === 1) {
    await run(
      "UPDATE accounts SET last_sync_status = 'demo', last_sync_error = NULL, last_synced_at = ? WHERE id = ?",
      nowIso(),
      accountId,
    );
    return;
  }
  if (!account.x_user_id) {
    await run("UPDATE accounts SET last_sync_status = 'error', last_sync_error = 'Missing X user id' WHERE id = ?", accountId);
    return;
  }

  activeSyncs.add(accountId);
  await run(
    "UPDATE accounts SET last_sync_status = 'syncing', last_sync_error = NULL, last_sync_count = 0 WHERE id = ?",
    accountId,
  );

  let stored = 0;
  let pages = 0;
  let paginationToken: string | undefined;

  try {
    const token = await getAccessToken(accountId);

    while (pages < config.limits.syncMaxPages) {
      const { data } = await xFetch<TimelineResponse>(`/2/users/${account.x_user_id}/tweets`, {
        token,
        query: {
          max_results: 100,
          pagination_token: paginationToken,
          'tweet.fields':
            'created_at,text,lang,public_metrics,attachments,entities,referenced_tweets,in_reply_to_user_id,conversation_id,author_id,possibly_sensitive',
          expansions: 'attachments.media_keys,referenced_tweets.id,author_id',
          'media.fields': 'type,url,preview_image_url,alt_text,width,height,duration_ms,variants',
          'user.fields': 'username,name,profile_image_url',
        },
      });

      const posts = data.data ?? [];
      for (const post of posts) {
        const mapped = mapXPost(post, data.includes, accountId);
        await upsertApiPost(accountId, mapped);
        stored += 1;
      }

      pages += 1;
      await run('UPDATE accounts SET last_sync_count = ? WHERE id = ?', stored, accountId);

      paginationToken = data.meta?.next_token;
      if (!paginationToken || posts.length === 0) break;
    }

    await run(
      "UPDATE accounts SET last_sync_status = 'complete', last_synced_at = ?, last_sync_error = NULL, last_sync_count = ? WHERE id = ?",
      nowIso(),
      stored,
      accountId,
    );
    await logActivity({
      userId: account.user_id,
      accountId,
      action: 'sync.completed',
      detail: { stored, pages },
    });
  } catch (err) {
    if (err instanceof XApiError && err.status === 429) {
      const reset = err.resetAt ? new Date(err.resetAt).toISOString() : null;
      await run(
        "UPDATE accounts SET last_sync_status = 'rate_limited', last_sync_error = ?, last_sync_count = ? WHERE id = ?",
        `X rate limit reached. Retry after ${reset ?? 'the window resets'}.`,
        stored,
        accountId,
      );
      await logActivity({
        userId: account.user_id,
        accountId,
        action: 'sync.rate_limited',
        detail: { resetAt: reset, stored },
      });
    } else {
      const message = err instanceof Error ? err.message : 'Sync failed';
      await run(
        "UPDATE accounts SET last_sync_status = 'error', last_sync_error = ?, last_sync_count = ? WHERE id = ?",
        message,
        stored,
        accountId,
      );
      await logActivity({ userId: account.user_id, accountId, action: 'sync.failed', detail: { message } });
    }
  } finally {
    activeSyncs.delete(accountId);
  }
}

async function upsertApiPost(accountId: string, post: ReturnType<typeof mapXPost>): Promise<void> {
  const now = nowIso();
  const values: Record<string, unknown> = {
    id: id('pst'),
    account_id: accountId,
    x_post_id: post.xPostId,
    kind: post.kind,
    text: post.text,
    lang: post.lang,
    source: post.source,
    is_quote: post.isQuote ? 1 : 0,
    in_reply_to_id: post.inReplyToId,
    in_reply_to_user: post.inReplyToUser,
    repost_of_id: post.repostOfId,
    quote_of_id: post.quoteOfId,
    like_count: post.likeCount,
    reply_count: post.replyCount,
    repost_count: post.repostCount,
    quote_count: post.quoteCount,
    impression_count: post.impressionCount,
    engagement: post.engagement,
    has_media: post.hasMedia ? 1 : 0,
    media_count: post.mediaCount,
    media_types: post.mediaTypes,
    media_json: JSON.stringify(post.media),
    urls_json: JSON.stringify(post.urls),
    author_username: post.authorUsername,
    author_name: post.authorName,
    is_pinned: 0,
    is_deleted: 0,
    deleted_at: null,
    deleted_by_job_id: null,
    archive_import_id: null,
    created_ts: post.createdTs,
    created_at: post.createdAt,
    inserted_at: now,
    updated_at: now,
  };
  const columns = Object.keys(values);
  await run(
    `INSERT INTO posts (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT (account_id, x_post_id) DO UPDATE SET
      text = excluded.text,
      lang = excluded.lang,
      is_quote = excluded.is_quote,
      in_reply_to_id = excluded.in_reply_to_id,
      in_reply_to_user = excluded.in_reply_to_user,
      repost_of_id = excluded.repost_of_id,
      quote_of_id = excluded.quote_of_id,
      like_count = excluded.like_count,
      reply_count = excluded.reply_count,
      repost_count = excluded.repost_count,
      quote_count = excluded.quote_count,
      impression_count = excluded.impression_count,
      engagement = excluded.engagement,
      has_media = excluded.has_media,
      media_count = excluded.media_count,
      media_types = excluded.media_types,
      media_json = CASE WHEN excluded.has_media = 1 THEN excluded.media_json ELSE posts.media_json END,
      urls_json = excluded.urls_json,
      author_username = excluded.author_username,
      author_name = excluded.author_name,
      source = 'api',
      created_ts = excluded.created_ts,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`,
    ...columns.map((c) => values[c]),
  );
}
