import type { FastifyRequest } from 'fastify';
import { get } from '../db/index.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { requireAuth } from './session.js';

export async function resolveAccountId(request: FastifyRequest, requested?: string | null): Promise<string> {
  const auth = requireAuth(request);
  const accountId = requested || auth.account.id;
  if (accountId === auth.account.id) return accountId;
  const owned = await get<{ id: string; is_demo: number }>(
    'SELECT id, is_demo FROM accounts WHERE id = ? AND user_id = ?',
    accountId,
    auth.user.id,
  );
  if (!owned) throw forbidden('You do not have access to that account.');
  return owned.id;
}

