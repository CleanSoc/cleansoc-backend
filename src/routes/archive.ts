import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { get } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { requireAuth } from '../auth/session.js';
import { resolveAccountId } from '../auth/account.js';
import { archiveStats, importDTO, listImports, startArchiveImport } from '../services/archive.js';

export async function archiveRoutes(app: FastifyInstance) {
  app.get('/api/archive', async (request) => {
    requireAuth(request);
    const query = request.query as { accountId?: string };
    const accountId = await resolveAccountId(request, query.accountId);
    return {
      stats: await archiveStats(accountId),
      imports: await listImports(accountId),
      coverage: {
        apiTimelineLimit: 3200,
        apiMentionsLimit: 800,
        archiveProvidesFullHistory: true,
        note: 'X only exposes your 3,200 most recent posts through the API. Older posts require a data archive.',
      },
    };
  });

  app.post('/api/archive/import', async (request, reply) => {
    const auth = requireAuth(request);
    const query = request.query as { accountId?: string };
    const accountId = await resolveAccountId(request, query.accountId);
    const account = await get<{ is_demo: number; username: string }>('SELECT is_demo, username FROM accounts WHERE id = ?', accountId);
    if (!account) throw badRequest('Account not found');
    if (account.is_demo === 1) {
      throw badRequest('Archive import is disabled for the demo workspace. Connect a real X account to import your archive.');
    }

    const part = await request.file({ limits: { fileSize: config.limits.maxArchiveBytes, files: 1 } });
    if (!part) throw badRequest('Attach your X archive .zip file.');
    if (!/\.zip$/i.test(part.filename)) {
      throw badRequest('The archive must be the .zip file downloaded from X (Settings → Your account → Download an archive).');
    }

    const tmpDir = path.join(config.dataDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `archive-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);

    try {
      await pipeline(part.file, createWriteStream(tmpPath));
    } catch (err) {
      fs.promises.unlink(tmpPath).catch(() => {});
      throw badRequest(
        err instanceof Error && /limit/i.test(err.message)
          ? 'That file is larger than the 512 MB upload limit.'
          : 'The upload was interrupted. Please try again.',
      );
    }

    // Verify the ZIP magic bytes before handing to the parser.
    const handle = await fs.promises.open(tmpPath, 'r');
    try {
      const buf = Buffer.alloc(4);
      await handle.read(buf, 0, 4, 0);
      if (buf.toString('binary') !== 'PK\u0003\u0004') {
        throw badRequest('This file is not a valid ZIP archive.');
      }
    } finally {
      await handle.close();
    }

    const row = await startArchiveImport({
      accountId,
      userId: auth.user.id,
      filePath: tmpPath,
      filename: part.filename,
      ip: request.ip,
    });
    return reply.code(202).send(importDTO(row));
  });
}



