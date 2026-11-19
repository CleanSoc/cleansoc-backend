import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { all, get, run } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import type { AccountDTO } from '../types.js';

export interface AuthContext {
  sessionId: string;
  user: { id: string; createdAt: string };
  account: AccountDTO;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

interface SessionUserRow {
  session_id: string;
  account_id: string | null;
  expires_at: string;
  last_seen_at: string;
  user_id: string;
  user_created_at: string;
}

interface AccountRow {
  id: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  is_demo: number;
  scopes: string;
  token_expires_at: string | null;
  connected_at: string;
  last_synced_at: string | null;
  last_sync_status: string;
  last_sync_error: string | null;
  last_sync_count: number;
  total_posts: number;
  deleted_posts: number;
}

const ACCOUNT_SELECT = `
  SELECT a.*,
    (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.is_deleted = 0) AS total_posts,
    (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.is_deleted = 1) AS deleted_posts
  FROM accounts a`;

export function accountDTO(row: AccountRow): AccountDTO {
  const scopes = row.scopes ? row.scopes.split(' ') : [];
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isDemo: Boolean(row.is_demo),
    connectedAt: row.connected_at,
    lastSyncedAt: row.last_synced_at,
    lastSyncStatus: row.last_sync_status,
    lastSyncError: row.last_sync_error,
    lastSyncCount: row.last_sync_count,
    hasWriteScope: row.is_demo === 1 || scopes.includes('tweet.write'),
    scopes,
    tokenExpiresAt: row.token_expires_at,
    totalPosts: row.total_posts ?? 0,
    deletedPosts: row.deleted_posts ?? 0,
  };
}

async function findAccountForSession(accountId: string | null, userId: string): Promise<AccountRow | undefined> {
  if (accountId) {
    const specific = await get<AccountRow>(`${ACCOUNT_SELECT} WHERE a.id = ? AND a.user_id = ?`, accountId, userId);
    if (specific) return specific;
  }
  return get<AccountRow>(`${ACCOUNT_SELECT} WHERE a.user_id = ? ORDER BY a.created_at ASC LIMIT 1`, userId);
}

export async function loadAuthFromRequest(request: FastifyRequest): Promise<AuthContext | null> {
  const raw = request.cookies[config.sessionCookie];
  if (!raw) return null;
  const sessionId = sha256(raw);

  const session = await get<SessionUserRow>(
    `SELECT s.id AS session_id, s.account_id, s.expires_at, s.last_seen_at,
            u.id AS user_id, u.created_at AS user_created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`,
    sessionId,
  );
  if (!session) return null;

  if (Date.parse(session.expires_at) < Date.now()) {
    await run('DELETE FROM sessions WHERE id = ?', sessionId);
    return null;
  }

  const account = await findAccountForSession(session.account_id, session.user_id);
  if (!account) return null;

  // Touch at most hourly to avoid a write on every request.
  if (Date.now() - Date.parse(session.last_seen_at) > 3_600_000) {
    await run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', nowIso(), sessionId);
  }

  return {
    sessionId,
    user: { id: session.user_id, createdAt: session.user_created_at },
    account: accountDTO(account),
  };
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

/** Throws unless the given account belongs to the signed-in user. */
export async function assertAccountAccess(request: FastifyRequest, accountId: string) {
  const auth = requireAuth(request);
  if (auth.account.id === accountId) return auth;
  const owned = await get<{ id: string }>('SELECT id FROM accounts WHERE id = ? AND user_id = ?', accountId, auth.user.id);
  if (!owned) throw unauthorized('You do not have access to this account');
  return auth;
}

export async function listUserAccounts(userId: string): Promise<AccountRow[]> {
  return all<AccountRow>(`${ACCOUNT_SELECT} WHERE a.user_id = ? ORDER BY a.created_at ASC`, userId);
}

export async function createSession(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  accountId: string | null,
): Promise<void> {
  const token = randomToken(32);
  const sessionId = sha256(token);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionTtlDays * 86_400_000);
  await run(
    `INSERT INTO sessions (id, user_id, account_id, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId,
    userId,
    accountId,
    now.toISOString(),
    expires.toISOString(),
    now.toISOString(),
    request.headers['user-agent']?.slice(0, 300) ?? null,
    request.ip,
  );
  reply.setCookie(config.sessionCookie, token, {
    path: '/',
    httpOnly: true,
    sameSite: config.isProd ? 'none' : 'lax',
    secure: config.isProd,
    expires,
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = request.cookies[config.sessionCookie];
  if (raw) await run('DELETE FROM sessions WHERE id = ?', sha256(raw));
  reply.clearCookie(config.sessionCookie, { path: '/' });
}

export async function setActiveAccount(request: FastifyRequest, accountId: string): Promise<void> {
  const auth = requireAuth(request);
  await run('UPDATE sessions SET account_id = ? WHERE id = ?', accountId, auth.sessionId);
}

