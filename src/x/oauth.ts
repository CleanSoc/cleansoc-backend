import { config } from '../config.js';
import { get, run } from '../db/index.js';
import { id, pkcePair, randomToken } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';

export function oauthConfigured(): boolean {
  return Boolean(config.x.clientId);
}

export async function createOAuthAuthorizeUrl(linkUserId: string | null): Promise<{ url: string; browserNonce: string }> {
  if (!oauthConfigured()) {
    throw badRequest('X OAuth is not configured on this server. Add X_CLIENT_ID to the backend .env file.');
  }
  const state = randomToken(24);
  const browserNonce = randomToken(24);
  const { verifier, challenge } = pkcePair();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 10 * 60_000);

  await run(
    `INSERT INTO oauth_states (state, code_verifier, browser_nonce, link_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    state,
    verifier,
    browserNonce,
    linkUserId,
    createdAt.toISOString(),
    expiresAt.toISOString(),
  );

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.x.clientId,
    redirect_uri: config.x.redirectUri,
    scope: config.x.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return { url: `${config.x.authorizeUrl}?${params.toString()}`, browserNonce };
}

export async function consumeOAuthState(state: string, browserNonce: string | undefined) {
  const row = await get<{
    state: string;
    code_verifier: string;
    browser_nonce: string;
    link_user_id: string | null;
    expires_at: string;
  }>('SELECT * FROM oauth_states WHERE state = ?', state);
  if (!row) throw badRequest('This sign-in link is invalid or has already been used. Please try again.');
  await run('DELETE FROM oauth_states WHERE state = ?', state);
  if (Date.parse(row.expires_at) < Date.now()) {
    throw badRequest('This sign-in link expired. Please try again.');
  }
  if (!browserNonce || browserNonce !== row.browser_nonce) {
    throw badRequest('Sign-in session mismatch. Please try again from the same browser.');
  }
  return row;
}

export async function cleanupExpiredOAuthStates(): Promise<void> {
  await run('DELETE FROM oauth_states WHERE expires_at < ?', nowIso());
  await run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
}

export function newDemoIdentity(): { userId: string; accountId: string } {
  return { userId: id('usr'), accountId: id('acc') };
}

