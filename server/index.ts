import path from 'node:path';
import { config } from './config.js';
import { Database } from './db.js';
import { createApp } from './app.js';
import { DatabaseStorage, LocalStorage, type BookStorage } from './storage.js';

async function main() {
  if (!config.discord.enabled && !config.devLogin) {
    console.error(
      '[startup] No way to sign in: set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET (see .env.example), ' +
        'or DEV_LOGIN=true for a private test instance.',
    );
    process.exit(1);
  }

  const db = await Database.open(config.database.url, config.database.authToken);
  const storage: BookStorage =
    config.storageDriver === 'database' ? new DatabaseStorage(db) : new LocalStorage(path.join(config.dataDir, 'books'));

  const app = createApp({ config, db, storage });
  app.http.listen(config.port, config.host, () => {
    console.log(`[startup] ${config.appName} listening on http://${config.host}:${config.port}`);
    console.log(`[startup] Public URL: ${config.publicUrl}`);
    console.log(`[startup] Database: ${config.database.remote ? 'remote libSQL' : config.database.url}`);
    console.log(`[startup] Book storage: ${storage.driver}`);
    console.log(
      `[startup] Sign-in: ${[config.discord.enabled && 'Discord', config.devLogin && 'developer login'].filter(Boolean).join(' + ')}`,
    );
    if (config.discord.enabled) console.log(`[startup] Discord redirect URI: ${config.discord.redirectUri}`);
    if (config.devLogin && config.isProduction) {
      console.warn('[startup] DEV_LOGIN is on: anyone can sign in with any name. Turn it off for real use.');
    }
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${signal} received, saving rooms…`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
      await db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[startup] Failed to start:', err);
  process.exit(1);
});
