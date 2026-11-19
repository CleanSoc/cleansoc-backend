import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { config } from '../config.js';
import { all, get, run, transaction } from '../db/index.js';
import { id } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { nowIso, parseArchiveDate } from '../lib/time.js';
import type { MediaKind, StoredMedia } from '../types.js';
import { logActivity } from './activity.js';

interface ImportRow {
  id: string;
  account_id: string;
  filename: string;
  status: string;
  posts_found: number;
  inserted: number;
  updated: number;
  skipped: number;
  media_count: number;
  oldest_ts: number | null;
  newest_ts: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export function importDTO(row: ImportRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    filename: row.filename,
    status: row.status,
    postsFound: row.posts_found,
    inserted: row.inserted,
    updated: row.updated,
    skipped: row.skipped,
    mediaCount: row.media_count,
    oldestAt: row.oldest_ts ? new Date(row.oldest_ts).toISOString() : null,
    newestAt: row.newest_ts ? new Date(row.newest_ts).toISOString() : null,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export async function startArchiveImport(input: {
  accountId: string;
  userId: string;
  filePath: string;
  filename: string;
  ip?: string | null;
}): Promise<ImportRow> {
  const existing = await get<ImportRow>(
    "SELECT * FROM archive_imports WHERE account_id = ? AND status = 'processing' LIMIT 1",
    input.accountId,
  );
  if (existing) throw badRequest('An archive import is already running for this account.');

  const importId = id('arc');
  await run(
    `INSERT INTO archive_imports (id, account_id, filename, status, created_at)
     VALUES (?, ?, ?, 'processing', ?)`,
    importId,
    input.accountId,
    input.filename.slice(0, 240),
    nowIso(),
  );

  void runImport(importId, input).catch((err) => {
    console.error('[archive] import crashed', err);
  });

  return (await get<ImportRow>('SELECT * FROM archive_imports WHERE id = ?', importId))!;
}

export async function listImports(accountId: string) {
  const rows = await all<ImportRow>(
    'SELECT * FROM archive_imports WHERE account_id = ? ORDER BY created_at DESC LIMIT 20',
    accountId,
  );
  return rows.map(importDTO);
}

async function runImport(
  importId: string,
  input: { accountId: string; userId: string; filePath: string; filename: string; ip?: string | null },
): Promise<void> {
  try {
    const tweets = await readArchiveTweets(input.filePath);
    if (tweets.length === 0) throw new Error('No posts found. Expected data/tweets.js inside the X archive ZIP.');

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let mediaCount = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    await run('UPDATE archive_imports SET posts_found = ? WHERE id = ?', tweets.length, importId);

    for (let offset = 0; offset < tweets.length; offset += 400) {
      const chunk = tweets.slice(offset, offset + 400);
      await transaction(async () => {
        for (const entry of chunk) {
          const normalised = normaliseArchiveTweet(entry);
          if (!normalised) {
            skipped += 1;
            continue;
          }
          const result = await insertArchivePost(input.accountId, importId, normalised);
          if (result.inserted) inserted += 1;
          else if (result.updated) updated += 1;
          else skipped += 1;
          if (normalised.hasMedia) mediaCount += normalised.mediaCount;
          if (oldest === null || normalised.createdTs < oldest) oldest = normalised.createdTs;
          if (newest === null || normalised.createdTs > newest) newest = normalised.createdTs;
        }
      });
      await run(
        `UPDATE archive_imports SET inserted = ?, updated = ?, skipped = ?, media_count = ?, oldest_ts = ?, newest_ts = ?
         WHERE id = ?`,
        inserted,
        updated,
        skipped,
        mediaCount,
        oldest,
        newest,
        importId,
      );
      await new Promise((resolve) => setImmediate(resolve));
    }

    await run(
      `UPDATE archive_imports SET status = 'complete', inserted = ?, updated = ?, skipped = ?, media_count = ?,
        oldest_ts = ?, newest_ts = ?, finished_at = ? WHERE id = ?`,
      inserted,
      updated,
      skipped,
      mediaCount,
      oldest,
      newest,
      nowIso(),
      importId,
    );
    await logActivity({
      userId: input.userId,
      accountId: input.accountId,
      action: 'archive.imported',
      detail: { importId, inserted, updated, skipped, filename: input.filename },
      ip: input.ip,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Archive import failed';
    await run(
      "UPDATE archive_imports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
      message.slice(0, 500),
      nowIso(),
      importId,
    );
    await logActivity({
      userId: input.userId,
      accountId: input.accountId,
      action: 'archive.failed',
      detail: { importId, message },
      ip: input.ip,
    });
  } finally {
    fs.promises.unlink(input.filePath).catch(() => {});
  }
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) reject(err ?? new Error('Could not open ZIP'));
      else resolve(zipfile);
    });
  });
}

async function readArchiveTweets(filePath: string): Promise<unknown[]> {
  const zip = await openZip(filePath);
  const wanted = new Set(['data/tweets.js', 'data/tweet.js']);

  const entries: yauzl.Entry[] = await new Promise((resolve, reject) => {
    const list: yauzl.Entry[] = [];
    zip.on('entry', (entry: yauzl.Entry) => {
      list.push(entry);
      zip.readEntry();
    });
    zip.on('end', () => resolve(list));
    zip.on('error', reject);
    zip.readEntry();
  });

  const match = entries.find((entry) => wanted.has(entry.fileName.replace(/^\.\//, '')));
  if (!match) throw new Error('This ZIP does not look like an X archive: data/tweets.js is missing.');

  const content = await readZipEntry(zip, match);
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('Could not parse data/tweets.js');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new Error('data/tweets.js contains invalid JSON.');
  }
  if (!Array.isArray(parsed)) throw new Error('Unexpected archive format.');

  return parsed
    .map((entry) => (entry && typeof entry === 'object' && 'tweet' in entry ? (entry as any).tweet : entry))
    .filter((tweet) => tweet && typeof tweet === 'object');
}

function readZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('Could not read zip entry'));
      const chunks: Buffer[] = [];
      const maxBytes = 400 * 1024 * 1024;
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          stream.destroy();
          reject(new Error('data/tweets.js is unreasonably large'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  });
}

interface NormalisedArchivePost {
  xPostId: string;
  kind: 'original' | 'reply' | 'repost';
  text: string;
  lang: string | null;
  isQuote: boolean;
  inReplyToId: string | null;
  inReplyToUser: string | null;
  repostOfId: string | null;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  quoteCount: number;
  engagement: number;
  media: StoredMedia[];
  hasMedia: boolean;
  mediaCount: number;
  mediaTypes: string;
  urls: string[];
  authorUsername: string | null;
  createdTs: number;
  createdAt: string;
}

function normaliseArchiveTweet(raw: any): NormalisedArchivePost | null {
  const idStr = String(raw.id_str ?? raw.id ?? '');
  if (!idStr || !/^\d+$/.test(idStr)) return null;
  const createdAtRaw = raw.created_at ?? raw.createdAt;
  if (!createdAtRaw) return null;
  const createdTs = parseArchiveDate(String(createdAtRaw));

  const retweeted = raw.retweeted_status ?? null;
  const retweetId = raw.retweeted_status_id_str ?? retweeted?.id_str ?? null;
  const inReplyTo = raw.in_reply_to_status_id_str ?? null;
  const isQuote = Boolean(raw.quoted_status_id_str ?? raw.quoted_status);

  const source = retweeted ?? raw;
  const media = extractMedia(source);

  const likeCount = Number(raw.favorite_count ?? 0) || 0;
  const replyCount = Number(raw.reply_count ?? 0) || 0;
  const repostCount = Number(raw.retweet_count ?? 0) || 0;
  const quoteCount = Number(raw.quote_count ?? 0) || 0;

  return {
    xPostId: idStr,
    kind: retweetId ? 'repost' : inReplyTo ? 'reply' : 'original',
    text: String(raw.full_text ?? raw.text ?? '').slice(0, 20_000),
    lang: raw.lang ?? null,
    isQuote,
    inReplyToId: inReplyTo,
    inReplyToUser: raw.in_reply_to_screen_name ?? raw.in_reply_to_user_id_str ?? null,
    repostOfId: retweetId,
    likeCount,
    replyCount,
    repostCount,
    quoteCount,
    engagement: likeCount + replyCount + repostCount + quoteCount,
    media,
    hasMedia: media.length > 0,
    mediaCount: media.length,
    mediaTypes: [...new Set(media.map((m) => m.type))].join(','),
    urls: (raw.entities?.urls ?? [])
      .map((u: any) => u.expanded_url ?? u.url)
      .filter((u: unknown): u is string => typeof u === 'string'),
    authorUsername: raw.user?.screen_name ?? null,
    createdTs,
    createdAt: new Date(createdTs).toISOString(),
  };
}

function extractMedia(raw: any): StoredMedia[] {
  const items = raw.extended_entities?.media ?? raw.entities?.media ?? raw.retweeted_status?.extended_entities?.media ?? [];
  if (!Array.isArray(items)) return [];
  return items.map((m: any) => {
    const type: MediaKind = m.type === 'video' || m.type === 'animated_gif' ? m.type : 'photo';
    const sizes = m.sizes?.large ?? m.sizes?.medium ?? {};
    return {
      type,
      url: m.media_url_https ?? m.media_url ?? null,
      previewUrl: m.media_url_https ?? m.media_url ?? null,
      altText: m.ext_alt_text ?? null,
      width: sizes.w ? Number(sizes.w) : null,
      height: sizes.h ? Number(sizes.h) : null,
      durationMs: m.video_info?.duration_millis ? Number(m.video_info.duration_millis) : null,
    };
  });
}

async function insertArchivePost(accountId: string, importId: string, post: NormalisedArchivePost): Promise<{ inserted: boolean; updated: boolean }> {
  const now = nowIso();
  const existing = await get<{ id: string; has_media: number; media_count: number }>(
    'SELECT id, has_media, media_count FROM posts WHERE account_id = ? AND x_post_id = ?',
    accountId,
    post.xPostId,
  );

  if (existing) {
    if (existing.has_media === 0 && post.hasMedia) {
      await run(
        `UPDATE posts SET media_json = ?, has_media = 1, media_count = ?, media_types = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(post.media),
        post.mediaCount,
        post.mediaTypes,
        now,
        existing.id,
      );
      return { inserted: false, updated: true };
    }
    return { inserted: false, updated: false };
  }

  const values: Record<string, unknown> = {
    id: id('pst'),
    account_id: accountId,
    x_post_id: post.xPostId,
    kind: post.kind,
    text: post.text,
    lang: post.lang,
    source: 'archive',
    is_quote: post.isQuote ? 1 : 0,
    in_reply_to_id: post.inReplyToId,
    in_reply_to_user: post.inReplyToUser,
    repost_of_id: post.repostOfId,
    quote_of_id: null,
    like_count: post.likeCount,
    reply_count: post.replyCount,
    repost_count: post.repostCount,
    quote_count: post.quoteCount,
    impression_count: 0,
    engagement: post.engagement,
    has_media: post.hasMedia ? 1 : 0,
    media_count: post.mediaCount,
    media_types: post.mediaTypes,
    media_json: JSON.stringify(post.media),
    urls_json: JSON.stringify(post.urls),
    author_username: post.authorUsername,
    author_name: null,
    is_pinned: 0,
    is_deleted: 0,
    archive_import_id: importId,
    created_ts: post.createdTs,
    created_at: post.createdAt,
    inserted_at: now,
    updated_at: now,
  };
  const columns = Object.keys(values);
  await run(
    `INSERT INTO posts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ...columns.map((column) => values[column]),
  );
  return { inserted: true, updated: false };
}

export async function archiveStats(accountId: string) {
  const row = await get<{ archived: number; api: number; oldest: number | null; newest: number | null; media: number }>(
    `SELECT
      SUM(CASE WHEN source = 'archive' THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN source = 'api' THEN 1 ELSE 0 END) AS api,
      MIN(created_ts) AS oldest,
      MAX(created_ts) AS newest,
      SUM(CASE WHEN has_media = 1 THEN 1 ELSE 0 END) AS media
     FROM posts WHERE account_id = ?`,
    accountId,
  );
  return {
    archivedPosts: row?.archived ?? 0,
    apiPosts: row?.api ?? 0,
    mediaPosts: row?.media ?? 0,
    oldestAt: row?.oldest ? new Date(row.oldest).toISOString() : null,
    newestAt: row?.newest ? new Date(row.newest).toISOString() : null,
  };
}

