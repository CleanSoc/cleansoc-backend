import { get, run, transaction } from '../db/index.js';
import { id } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';
import type { MediaKind, StoredMedia } from '../types.js';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORIGINALS = [
  'shipped a tiny thing today and honestly it made my whole week',
  'hot take: most productivity systems are just procrastination with extra steps',
  'reading old code is like reading old messages. humbling.',
  'the best debugging tool is still a walk around the block',
  'gm to everyone building something quietly',
  'unpopular opinion: the meeting could have been a shared document',
  'spent 3 hours on a CSS bug. it was a missing semicolon. I contain multitudes.',
  'started learning to cook properly this month. tonight: burnt garlic, again.',
  'reminder that shipping something small beats planning something perfect',
  'my 2016 tweets are a museum of person I no longer am',
  'crypto twitter convinced me to buy the top. never again.',
  'NFTs are the beanie babies of the internet and I say that with love',
  'AI will not take your job. someone using AI badly will take your job.',
  'giveaway time! retweet to win absolutely nothing because I forgot to buy a prize',
  'new blog post: how I finally organized 8 years of screenshots',
  'design systems are just agreements with better typography',
  'took the train instead of flying. 9 hours, but I read a whole book.',
  'the "unsubscribe" button is the most powerful productivity app I own',
  'everyone is a genius until the build pipeline breaks on a Friday',
  'my favorite part of the week is the 20 minutes before everyone else wakes up',
  'a small thread on why I stopped chasing engagement metrics 🧵',
  'delete old posts. your future self will thank you.',
  'I keep a folder called "someday" and it is basically a graveyard',
  'the internet is forever, except when you actually need that one link',
  'coffee #3 has entered the chat',
  'genuinely think the best career advice is: learn to write clearly',
  'this is your periodic reminder to back up your photos',
  'turned 30 this year and my timeline is 80% nostalgia',
  'why does every app want to be a platform now',
  'the sunset from the office window was unreasonably good tonight',
  'I spent the weekend offline and nothing bad happened',
  'movie recommendation: anything with a long quiet scene and no explosions',
  'my spicy take is that the best camera is the one you actually carry',
  'note to self: do not deploy on a Friday. signed, Friday me.',
  'deleted 400 old replies today. it feels like cleaning a closet.',
  'the giveaway winner is... nobody, because I never set this up properly',
  'trying to write more and post less',
  'small win: finally fixed the auth redirect bug that haunted me',
  'if you are reading this, drink some water',
];

const REPLIES = [
  'this is such a good point',
  'wait this is actually genius',
  'haha I felt this in my soul',
  'thanks for sharing!',
  '@thebuildlog absolutely, been saying this for years',
  'do you have a link to the writeup?',
  'ok but the second slide is doing a lot of work',
  'I tried this last month and it broke immediately',
  'congrats!! huge',
  'this is the content I am here for',
  'interesting — what stack are you using?',
  'strong disagree, but respectfully',
  'the ending got me',
  'adding this to my reading list',
  'how long did this take you?',
  'you are not wrong and I hate it',
  'this aged well',
  'happy birthday!!',
  'same energy as my 2014 timeline',
  'I needed to hear this today',
  'quality thread 🧵',
  'bookmarking for later',
  'is this still available?',
  'DM me the details?',
  'lol exactly',
  'no way this is real',
];

const QUOTES = [
  'this is the best summary I have seen of the whole thing',
  'relevant to the cleanup project I have been putting off',
  'strong take, but I think the nuance is in the second point',
  'saving this for later',
  'everyone should read this before their next launch',
];

const REPOST_TEXTS = [
  'Reposted a thread about shipping smaller products',
  'Reposted a design system deep dive',
  'Reposted a thread on personal knowledge management',
  'Reposted a great explainer on API rate limits',
  'Reposted a post about digital decluttering',
];

export async function seedDemoAccount(userId: string, accountId: string): Promise<void> {
  const rng = mulberry32(0xc1ea450c);
  const now = Date.now();
  const nowIsoValue = nowIso();

  await transaction(async () => {
    await run('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)', userId, nowIsoValue, nowIsoValue);
    await run(
      `INSERT INTO accounts (
        id, user_id, x_user_id, username, display_name, avatar_url, is_demo, scopes,
        connected_at, last_synced_at, last_sync_status, last_sync_count, created_at
      ) VALUES (?, ?, NULL, ?, ?, NULL, 1, ?, ?, ?, 'demo', 0, ?)`,
      accountId,
      userId,
      'maya_builds',
      'Maya Chen',
      'tweet.read tweet.write users.read offline.access',
      nowIsoValue,
      nowIsoValue,
      nowIsoValue,
    );

    const insert = `
      INSERT INTO posts (
        id, account_id, x_post_id, kind, text, lang, source, is_quote,
        in_reply_to_id, in_reply_to_user, repost_of_id, quote_of_id,
        like_count, reply_count, repost_count, quote_count, impression_count, engagement,
        has_media, media_count, media_types, media_json, urls_json,
        author_username, author_name, is_pinned, is_deleted, created_ts, created_at, inserted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'en', 'api', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 0, 0, ?, ?, ?, ?)`;

    for (let i = 0; i < 264; i += 1) {
      const roll = rng();
      const kind = roll < 0.5 ? 'original' : roll < 0.73 ? 'reply' : roll < 0.9 ? 'repost' : 'original';
      const isQuote = kind === 'original' && rng() < 0.12;
      // Skew towards recent years, with a long tail of older posts.
      const daysAgo = Math.floor(20 + Math.pow(rng(), 1.7) * 3400);
      const createdTs = now - daysAgo * 86_400_000 - Math.floor(rng() * 86_400_000);
      const createdAt = new Date(createdTs).toISOString();
      const xPostId = String(1_200_000_000_000_000_000n + BigInt(i) * 7919n + BigInt(Math.floor(rng() * 997)));

      let text: string;
      if (kind === 'reply') text = REPLIES[Math.floor(rng() * REPLIES.length)];
      else if (kind === 'repost') text = REPOST_TEXTS[Math.floor(rng() * REPOST_TEXTS.length)];
      else if (isQuote) text = `${QUOTES[Math.floor(rng() * QUOTES.length)]}`;
      else text = ORIGINALS[Math.floor(rng() * ORIGINALS.length)];

      const viral = rng() < 0.035;
      const likeCount = viral ? 180 + Math.floor(rng() * 1200) : Math.floor(Math.pow(rng(), 3) * 70);
      const replyCount = viral ? 8 + Math.floor(rng() * 60) : Math.floor(Math.pow(rng(), 3) * 12);
      const repostCount = viral ? 10 + Math.floor(rng() * 200) : Math.floor(Math.pow(rng(), 3) * 15);
      const quoteCount = viral ? 2 + Math.floor(rng() * 20) : Math.floor(rng() * 4);
      const impressions = viral ? 8_000 + Math.floor(rng() * 90_000) : Math.floor(rng() * 2_200);

      const hasMedia = kind !== 'repost' && rng() < 0.36;
      const mediaCount = hasMedia ? (rng() < 0.18 ? 2 : 1) : 0;
      const media: StoredMedia[] = [];
      for (let m = 0; m < mediaCount; m += 1) {
        const typeRoll = rng();
        const type: MediaKind = typeRoll < 0.7 ? 'photo' : typeRoll < 0.9 ? 'video' : 'animated_gif';
        media.push({
          type,
          url: null,
          previewUrl: null,
          altText: type === 'photo' ? 'Demo photo attachment' : null,
          width: 1200,
          height: 800,
          gradient: Math.floor(rng() * 8),
        });
      }

      await run(
        insert,
        id('pst'),
        accountId,
        xPostId,
        kind,
        text,
        isQuote ? 1 : 0,
        kind === 'reply' ? String(1_100_000_000_000_000_000n + BigInt(Math.floor(rng() * 999_999))) : null,
        kind === 'reply' ? `user_${Math.floor(rng() * 900 + 100)}` : null,
        kind === 'repost' ? String(1_150_000_000_000_000_000n + BigInt(Math.floor(rng() * 999_999))) : null,
        isQuote ? String(1_180_000_000_000_000_000n + BigInt(Math.floor(rng() * 999_999))) : null,
        likeCount,
        replyCount,
        repostCount,
        quoteCount,
        impressions,
        likeCount + replyCount + repostCount + quoteCount,
        hasMedia ? 1 : 0,
        mediaCount,
        [...new Set(media.map((m) => m.type))].join(','),
        JSON.stringify(media),
        'maya_builds',
        'Maya Chen',
        createdTs,
        createdAt,
        nowIsoValue,
        nowIsoValue,
      );
    }

    await run(
      `UPDATE accounts SET last_sync_count = (SELECT COUNT(*) FROM posts WHERE account_id = ?) WHERE id = ?`,
      accountId,
      accountId,
    );

    const savedFilters = [
      {
        name: 'Old low-engagement posts',
        filters: { category: 'posts', sort: 'engagement_asc', minEngagement: 0, maxEngagement: 2, to: yearsAgo(2) },
      },
      {
        name: 'Replies before 2022',
        filters: { category: 'replies', sort: 'oldest', to: '2021-12-31' },
      },
      {
        name: 'Media posts from 2023',
        filters: { category: 'media', sort: 'newest', from: '2023-01-01', to: '2023-12-31' },
      },
    ];
    for (const saved of savedFilters) {
      await run(
        'INSERT INTO saved_filters (id, user_id, account_id, name, filters_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id('flt'),
        userId,
        accountId,
        saved.name,
        JSON.stringify(saved.filters),
        nowIsoValue,
      );
    }
  });
}

function yearsAgo(years: number): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

export async function cleanupDemoUsers(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const stale = await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE created_at < ? AND id IN (SELECT user_id FROM accounts WHERE is_demo = 1)",
    cutoff,
  );
  if ((stale?.n ?? 0) > 0) {
    await run(
      "DELETE FROM users WHERE created_at < ? AND id IN (SELECT user_id FROM accounts WHERE is_demo = 1)",
      cutoff,
    );
    console.log(`[demo] removed ${stale?.n} stale demo workspaces`);
  }
}

