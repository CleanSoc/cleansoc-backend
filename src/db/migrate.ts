import { migrate, closePool } from './index.js';

async function main() {
  try {
    await migrate();
    console.log('[db] migrations are up to date');
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('[db] migration failed', err);
  process.exit(1);
});

