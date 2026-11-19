import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../auth/session.js';
import { oauthConfigured } from '../x/oauth.js';

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async (request) => {
    const auth = requireAuth(request);
    return {
      account: auth.account,
      server: {
        demoMode: config.demoMode,
        oauthConfigured: oauthConfigured(),
        maxJobItems: config.limits.maxJobItems,
        syncMaxPages: config.limits.syncMaxPages,
        maxArchiveBytes: config.limits.maxArchiveBytes,
        sessionTtlDays: config.sessionTtlDays,
        tokenEncryption: 'AES-256-GCM',
      },
      privacy: {
        passwordsStored: false,
        tokenStorage: 'Encrypted at rest; never sent to the browser.',
        deletionModel: 'Server-side worker calls X on your behalf after explicit confirmation.',
        dataRetention: 'Posts stay cached until you disconnect the account or delete your data.',
      },
      xApi: {
        timelineLimit: 3200,
        mentionsLimit: 800,
        deleteRateLimit: '50 deletes per 15 minutes per user',
        repostUndoEndpoint: 'DELETE /2/users/:id/retweets/:source_tweet_id',
        deleteEndpoint: 'DELETE /2/tweets/:id',
        archiveNote: 'Official archives are user-downloaded ZIP files; X does not provide an archive import API.',
      },
    };
  });
}


