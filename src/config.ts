import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const isProd = process.env.NODE_ENV === 'production';
const dataDir = path.resolve(process.env.DATA_DIR ?? './data');

function loadEncryptionKey(): Buffer {
  const fromEnv = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
    return buf;
  }
  if (isProd) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required in production');
  }
  // Developer convenience: persist a generated key so tokens survive restarts.
  fs.mkdirSync(dataDir, { recursive: true });
  const keyPath = path.join(dataDir, '.dev-encryption-key');
  if (fs.existsSync(keyPath)) {
    return Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
  }
  const key = randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  console.warn('[config] Generated a development TOKEN_ENCRYPTION_KEY in data/.dev-encryption-key');
  return key;
}

function databaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  if (isProd) {
    throw new Error('DATABASE_URL is required in production');
  }
  return 'postgres://postgres:postgres@localhost:5432/cleansoc';
}

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 8787),
  appUrl: (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  dataDir,
  database: {
    url: databaseUrl(),
    poolMax: Math.max(1, Number(process.env.DATABASE_POOL_MAX ?? 10)),
    ssl: process.env.DATABASE_SSL === 'true',
    sslRejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
  },
  encryptionKey: loadEncryptionKey(),
  x: {
    clientId: process.env.X_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.X_CLIENT_SECRET?.trim() ?? '',
    redirectUri: process.env.X_REDIRECT_URI?.trim() ?? 'http://localhost:8787/api/auth/x/callback',
    apiBase: 'https://api.x.com',
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  },
  limits: {
    maxJobItems: Math.min(Number(process.env.MAX_JOB_ITEMS ?? 1000), 5000),
    syncMaxPages: Math.min(Number(process.env.SYNC_MAX_PAGES ?? 32), 32),
    pageSize: 50,
    maxArchiveBytes: 512 * 1024 * 1024,
  },
  demoMode: process.env.DEMO_MODE !== 'false',
  sessionCookie: 'cleansoc_session',
  sessionTtlDays: 30,
};

export function assertRuntimeConfig() {
  if (!process.env.DATABASE_URL && config.isProd) {
    throw new Error('DATABASE_URL is required in production');
  }
  if (!config.x.clientId && !config.demoMode) {
    console.warn('[config] X_CLIENT_ID is not set — only demo mode will be available.');
  }
  if (config.isProd && !config.x.clientId) {
    console.warn('[config] X_CLIENT_ID missing in production.');
  }
}

