import { config } from '../config.js';
import { get, run } from '../db/index.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';

export class XApiError extends Error {
  status: number;
  code: number | string;
  resetAt: number | null;
  body: unknown;

  constructor(status: number, message: string, code: number | string = 'x_api_error', body?: unknown, resetAt: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
    this.resetAt = resetAt;
  }
}

interface AccountTokenRow {
  id: string;
  x_user_id: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  scopes: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.x.redirectUri,
    code_verifier: codeVerifier,
  });
  if (!config.x.clientSecret) body.set('client_id', config.x.clientId);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (config.x.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(config.x.clientId)}:${encodeURIComponent(config.x.clientSecret)}`,
    ).toString('base64')}`;
  }

  const res = await fetch(config.x.tokenUrl, { method: 'POST', headers, body });
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    throw new XApiError(res.status, json.error_description ?? json.error ?? 'Token exchange failed', json.error ?? 'token_exchange_failed', json);
  }
  return json;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (!config.x.clientSecret) body.set('client_id', config.x.clientId);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (config.x.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(config.x.clientId)}:${encodeURIComponent(config.x.clientSecret)}`,
    ).toString('base64')}`;
  }
  const res = await fetch(config.x.tokenUrl, { method: 'POST', headers, body });
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    throw new XApiError(res.status, json.error_description ?? json.error ?? 'Token refresh failed', json.error ?? 'token_refresh_failed', json);
  }
  return json;
}

export async function storeTokens(accountId: string, tokens: TokenResponse): Promise<void> {
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
  const accessEnc = encryptSecret(tokens.access_token, `${accountId}:access`);
  const refreshEnc = tokens.refresh_token ? encryptSecret(tokens.refresh_token, `${accountId}:refresh`) : null;
  await run(
    `UPDATE accounts SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc),
      token_expires_at = ?, scopes = COALESCE(?, scopes) WHERE id = ?`,
    accessEnc,
    refreshEnc,
    expiresAt,
    tokens.scope ?? null,
    accountId,
  );
}

export async function getAccessToken(accountId: string): Promise<string> {
  const account = await get<AccountTokenRow>(
    'SELECT id, x_user_id, access_token_enc, refresh_token_enc, token_expires_at, scopes FROM accounts WHERE id = ?',
    accountId,
  );
  if (!account) throw new XApiError(404, 'Account not found', 'account_not_found');
  if (!account.access_token_enc) throw new XApiError(400, 'This account has no X credentials', 'no_credentials');

  const expiresSoon = account.token_expires_at
    ? Date.parse(account.token_expires_at) - Date.now() < 60_000
    : false;

  if (expiresSoon && account.refresh_token_enc) {
    const refreshToken = decryptSecret(account.refresh_token_enc, `${accountId}:refresh`);
    const refreshed = await refreshAccessToken(refreshToken);
    if (!refreshed.refresh_token) refreshed.refresh_token = refreshToken;
    await storeTokens(accountId, refreshed);
    return refreshed.access_token;
  }

  return decryptSecret(account.access_token_enc, `${accountId}:access`);
}

interface XFetchOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  token: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface XFetchResult<T> {
  data: T;
  rateLimit: { limit: number | null; remaining: number | null; reset: number | null };
}

export async function xFetch<T = unknown>(path: string, opts: XFetchOptions): Promise<XFetchResult<T>> {
  const url = new URL(path, config.x.apiBase);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'User-Agent': 'CleanSoc/1.0',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const resetHeader = res.headers.get('x-rate-limit-reset');
  const rateLimit = {
    limit: numberOrNull(res.headers.get('x-rate-limit-limit')),
    remaining: numberOrNull(res.headers.get('x-rate-limit-remaining')),
    reset: resetHeader ? Number(resetHeader) * 1000 : null,
  };

  if (res.status === 204) return { data: null as T, rateLimit };

  const json = (await res.json().catch(() => null)) as any;

  if (!res.ok) {
    const problem = json?.errors?.[0] ?? json?.detail ?? json;
    const message =
      problem?.message ??
      json?.title ??
      (res.status === 429 ? 'X rate limit reached — the job will pause and resume automatically.' : `X API error ${res.status}`);
    throw new XApiError(
      res.status,
      typeof message === 'string' ? message : `X API error ${res.status}`,
      problem?.code ?? problem?.type ?? 'x_api_error',
      json,
      res.status === 429 ? rateLimit.reset : null,
    );
  }

  return { data: json as T, rateLimit };
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

