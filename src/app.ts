import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { ApiError } from './lib/errors.js';
import { loadAuthFromRequest } from './auth/session.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/accounts.js';
import { activityRoutes } from './routes/activity.js';
import { cleanupRoutes } from './routes/cleanup.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { historyRoutes } from './routes/history.js';
import { ruleRoutes } from './routes/rules.js';
import { archiveRoutes } from './routes/archive.js';
import { settingsRoutes } from './routes/settings.js';
import { XApiError } from './x/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({
    logger: config.isProd
      ? { level: 'info' }
      : { level: 'warn', transport: undefined },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/api/health',
    errorResponseBuilder: () => ({ error: 'Too many requests. Please slow down.', code: 'rate_limited' }),
  });
  await app.register(multipart, {
    limits: { fileSize: config.limits.maxArchiveBytes, files: 1, fields: 10 },
  });
  await app.register(cors, {
    origin: [config.appUrl, `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`],
    credentials: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.isProd) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob: https://pbs.twimg.com https://abs.twimg.com; media-src 'self' blob: https://video.twimg.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
      );
    }
  });

  // CSRF: state-changing requests must come from a known origin.
  app.addHook('onRequest', async (request) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return; // same-origin fetch from some browsers/tools; SameSite cookie still applies
    const allowed = new Set([
      config.appUrl,
      `http://localhost:${config.port}`,
      `http://127.0.0.1:${config.port}`,
    ]);
    if (!allowed.has(origin)) {
      throw new ApiError(403, 'Cross-origin request blocked.', 'csrf_blocked');
    }
  });

  app.addHook('onRequest', async (request) => {
    request.auth = (await loadAuthFromRequest(request)) ?? undefined;
  });

  app.get('/api/health', async () => ({
    ok: true,
    version: '1.0.0',
    demoMode: config.demoMode,
    time: new Date().toISOString(),
  }));

  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(activityRoutes);
  await app.register(cleanupRoutes);
  await app.register(dashboardRoutes);
  await app.register(historyRoutes);
  await app.register(ruleRoutes);
  await app.register(archiveRoutes);
  await app.register(settingsRoutes);

  const distDir = path.resolve(__dirname, '../../cleansoc/dist');
  if (config.isProd && fs.existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found', code: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: error.issues[0]?.message ?? 'Invalid request',
        code: 'validation_error',
        details: error.issues,
      });
    }
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code, details: error.details });
    }
    if (error instanceof XApiError) {
      return reply.code(502).send({ error: error.message, code: 'x_api_error' });
    }
    if ((error as any).statusCode === 413) {
      return reply.code(413).send({ error: 'Upload too large.', code: 'payload_too_large' });
    }
    const statusCode = (error as any).statusCode ?? 500;
    request.log.error(error);
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Something went wrong on our side.' : error instanceof Error ? error.message : 'Request failed',
      code: 'internal_error',
    });
  });

  return app;
}

