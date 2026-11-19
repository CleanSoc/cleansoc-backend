import { buildApp } from './app.js';
import { assertRuntimeConfig, config } from './config.js';
import { closePool, migrate, ping } from './db/index.js';
import { cleanupExpiredOAuthStates } from './x/oauth.js';
import { cleanupDemoUsers } from './services/demo.js';
import { startCleanupWorker, stopCleanupWorker } from './services/cleanup.js';

async function main() {
  assertRuntimeConfig();

  if (!(await ping())) {
    throw new Error(
      `Could not reach PostgreSQL at ${config.database.url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')}. ` +
        'Check DATABASE_URL and make sure the server is running.',
    );
  }

  await migrate();
  await cleanupExpiredOAuthStates();
  await cleanupDemoUsers();

  const app = await buildApp();
  startCleanupWorker();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`\n  CleanSoc API  →  http://localhost:${config.port}`);
  console.log(`  Frontend      →  ${config.appUrl}`);
  console.log(`  Database      →  PostgreSQL`);
  console.log(`  Demo mode     →  ${config.demoMode ? 'enabled' : 'disabled'}\n`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received, shutting down…`);
    stopCleanupWorker();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});

