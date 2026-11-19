import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { get, run } from '../db/index.js';
import { id } from '../lib/crypto.js';
import { ApiError, badRequest } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import { accountDTO, createSession, destroySession, listUserAccounts, loadAuthFromRequest } from '../auth/session.js';
import { logActivity } from '../services/activity.js';
import { cleanupDemoUsers, seedDemoAccount } from '../services/demo.js';
import { consumeOAuthState, createOAuthAuthorizeUrl, oauthConfigured } from '../x/oauth.js';
import { exchangeCode, storeTokens, xFetch } from '../x/client.js';
import { syncAccount } from '../x/sync.js';

async function sessionPayload(userId: string, activeAccountId: string | null) {
  const accounts = (await listUserAccounts(userId)).map(accountDTO);
  return {
    authenticated: true,
    user: { id: userId },
    accounts,
    activeAccountId: activeAccountId ?? accounts[0]?.id ?? null,
    demoMode: config.demoMode,
    oauthConfigured: oauthConfigured(),
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/capabilities', async () => ({
    demoMode: config.demoMode,
    oauthConfigured: oauthConfigured(),
    archiveImport: true,
    scopes: config.x.scopes,
    limits: {
      maxJobItems: config.limits.maxJobItems,
      syncMaxPages: config.limits.syncMaxPages,
      pageSize: config.limits.pageSize,
      maxArchiveBytes: config.limits.maxArchiveBytes,
    },
  }));

  app.get('/api/auth/session', async (request) => {
    if (!request.auth) {
      return {
        authenticated: false,
        demoMode: config.demoMode,
        oauthConfigured: oauthConfigured(),
      };
    }
    return sessionPayload(request.auth.user.id, request.auth.account.id);
  });

  app.get('/api/auth/x/start', async (request, reply) => {
    const { url, browserNonce } = await createOAuthAuthorizeUrl(request.auth?.user.id ?? null);
    reply.setCookie('cleansoc_oauth', browserNonce, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.appUrl.startsWith('https://') || config.isProd,
      maxAge: 600,
    });
    return reply.redirect(url);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/api/auth/x/callback',
    async (request, reply) => {
      const nonce = request.cookies['cleansoc_oauth'];
      reply.clearCookie('cleansoc_oauth', { path: '/' });

      if (request.query.error) {
        const message = request.query.error_description ?? request.query.error;
        return reply.redirect(`${config.appUrl}/welcome?error=${encodeURIComponent(message)}`);
      }
      const code = request.query.code;
      const state = request.query.state;
      if (!code || !state) {
        return reply.redirect(`${config.appUrl}/welcome?error=${encodeURIComponent('Missing OAuth code or state.')}`);
      }

      try {
        const oauthState = await consumeOAuthState(state, nonce);
        const tokens = await exchangeCode(code, oauthState.code_verifier);
        const me = await xFetch<{ data: { id: string; username: string; name: string; profile_image_url?: string } }>(
          '/2/users/me',
          { token: tokens.access_token, query: { 'user.fields': 'profile_image_url' } },
        );
        const profile = me.data.data;

        const existingByXId = await get<{ id: string; user_id: string }>(
          'SELECT id, user_id FROM accounts WHERE x_user_id = ? LIMIT 1',
          profile.id,
        );
        if (existingByXId && oauthState.link_user_id && existingByXId.user_id !== oauthState.link_user_id) {
          return reply.redirect(
            `${config.appUrl}/welcome?error=${encodeURIComponent(
              'That X account is already connected to another CleanSoc workspace.',
            )}`,
          );
        }

        let userId = existingByXId?.user_id ?? oauthState.link_user_id ?? null;
        const now = nowIso();
        if (!userId) {
          userId = id('usr');
          await run('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)', userId, now, now);
        } else {
          const user = await get<{ id: string }>('SELECT id FROM users WHERE id = ?', userId);
          if (!user) {
            userId = id('usr');
            await run('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)', userId, now, now);
          }
        }

        let accountId = existingByXId?.id ?? null;
        if (accountId) {
          await run(
            `UPDATE accounts SET username = ?, display_name = ?, avatar_url = ?, last_sync_status = 'idle' WHERE id = ?`,
            profile.username,
            profile.name,
            profile.profile_image_url ?? null,
            accountId,
          );
        } else {
          accountId = id('acc');
          try {
            await run(
              `INSERT INTO accounts (id, user_id, x_user_id, username, display_name, avatar_url, is_demo, connected_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
              accountId,
              userId,
              profile.id,
              profile.username,
              profile.name,
              profile.profile_image_url ?? null,
              now,
              now,
            );
          } catch (err) {
            const concurrent = await get<{ id: string; user_id: string }>(
              'SELECT id, user_id FROM accounts WHERE x_user_id = ? LIMIT 1',
              profile.id,
            );
            if (!concurrent) throw err;
            accountId = concurrent.id;
            userId = concurrent.user_id;
            await run(
              `UPDATE accounts SET username = ?, display_name = ?, avatar_url = ?, last_sync_status = 'idle' WHERE id = ?`,
              profile.username,
              profile.name,
              profile.profile_image_url ?? null,
              accountId,
            );
          }
        }

        await storeTokens(accountId, tokens);
        await createSession(request, reply, userId, accountId);
        void logActivity({
          userId,
          accountId,
          action: 'account.connected',
          detail: { username: profile.username },
          ip: request.ip,
        });
        void syncAccount(accountId);
        return reply.redirect(`${config.appUrl}/app?connected=1`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not connect your X account.';
        return reply.redirect(`${config.appUrl}/welcome?error=${encodeURIComponent(message)}`);
      }
    },
  );

  app.post('/api/auth/demo', async (request, reply) => {
    if (!config.demoMode) throw badRequest('Demo mode is disabled on this server.');
    await cleanupDemoUsers();
    const userId = id('usr');
    const accountId = id('acc');
    await seedDemoAccount(userId, accountId);
    await createSession(request, reply, userId, accountId);
    void logActivity({ userId, accountId, action: 'auth.demo', ip: request.ip });
    return sessionPayload(userId, accountId);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.auth) {
      void logActivity({ userId: request.auth.user.id, accountId: request.auth.account.id, action: 'auth.logout' });
    }
    await destroySession(request, reply);
    return { ok: true };
  });

  /**
   * Dev-only helper: refresh the authenticated context without a full reload.
   * Never exposes tokens.
   */
  app.get('/api/auth/me', async (request) => {
    if (!request.auth) throw new ApiError(401, 'Sign in required', 'unauthorized');
    return sessionPayload(request.auth.user.id, request.auth.account.id);
  });
}


