import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Load a local .env file when present (Node >= 20.12). Real environment variables win.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function bool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function list(name: string): string[] {
  return (env(name) ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const isProduction = env('NODE_ENV') === 'production';
const port = int('PORT', 3000);
const publicUrl = (env('PUBLIC_URL') ?? env('RENDER_EXTERNAL_URL') ?? (isProduction ? `http://localhost:${port}` : 'http://localhost:5173')).replace(/\/+$/, '');
const dataDir = path.resolve(env('DATA_DIR') ?? 'data');
const databaseUrl = env('DATABASE_URL') ?? `file:${path.join(dataDir, 'reading-room.db')}`;
const remoteDatabase = !databaseUrl.startsWith('file:') && databaseUrl !== ':memory:';

const discordClientId = env('DISCORD_CLIENT_ID');
const discordClientSecret = env('DISCORD_CLIENT_SECRET');
const discordLogin = Boolean(discordClientId && discordClientSecret);

let sessionSecret = env('SESSION_SECRET');
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString('hex');
  if (isProduction) {
    console.warn('[config] SESSION_SECRET is not set: using a random one, so everyone is signed out on every restart.');
  }
}

const storageDriverSetting = (env('STORAGE_DRIVER') ?? 'auto').toLowerCase();
const storageDriver: 'local' | 'database' =
  storageDriverSetting === 'local' || storageDriverSetting === 'database'
    ? storageDriverSetting
    : remoteDatabase
      ? 'database'
      : 'local';

export const config = {
  isProduction,
  port,
  host: env('HOST') ?? '0.0.0.0',
  appName: env('APP_NAME') ?? 'Reading Room',
  publicUrl,
  secureCookies: publicUrl.startsWith('https://'),
  trustProxy: int('TRUST_PROXY_HOPS', 1),
  sessionSecret,
  sessionDays: int('SESSION_DAYS', 30),

  discord: {
    enabled: discordLogin,
    clientId: discordClientId ?? '',
    clientSecret: discordClientSecret ?? '',
    redirectUri: `${publicUrl}/auth/discord/callback`,
    /**
     * Optional allow-list of Discord servers. Empty (the default) lets anyone with a Discord
     * account sign in; otherwise people must be a member of at least one of these servers.
     */
    guildIds: [...new Set([...list('DISCORD_GUILD_IDS'), ...list('DISCORD_GUILD_ID')])],
    /** Members holding one of these roles in an allowed server are site-wide admins. */
    adminRoleIds: list('DISCORD_ADMIN_ROLE_IDS'),
    apiBase: env('DISCORD_API_BASE') ?? 'https://discord.com/api/v10',
  },
  /** Discord user IDs that are always site admins and can add more admins in the app. */
  adminUserIds: list('ADMIN_USER_IDS'),
  /** Username-only login for local development and demos. Never enable this on a public site. */
  devLogin: bool('DEV_LOGIN', !isProduction && !discordLogin),

  dataDir,
  database: {
    url: databaseUrl,
    authToken: env('DATABASE_AUTH_TOKEN'),
    remote: remoteDatabase,
  },
  storageDriver,
  maxUploadMb: int('MAX_UPLOAD_MB', 100),
  maxRoomsPerUser: int('MAX_ROOMS_PER_USER', 10),
  maxBooksPerRoom: int('MAX_BOOKS_PER_ROOM', 25),
  clientDir: path.resolve(env('CLIENT_DIR') ?? 'dist/client'),

  dictionary: {
    /**
     * auto: Oxford Dictionaries first when keys are set, then the built-in WordNet dictionary,
     * then Wiktionary for rare words. "builtin" skips Oxford, "offline" uses WordNet only,
     * "off" disables look-ups.
     */
    mode: (() => {
      const value = (env('DICTIONARY_PROVIDER') ?? 'auto').toLowerCase();
      if (value === 'off' || value === 'offline' || value === 'builtin') return value;
      if (value === 'free' || value === 'wordnet' || value === 'wiktionary') return 'builtin' as const;
      return 'auto' as const;
    })() as 'auto' | 'builtin' | 'offline' | 'off',
    oxfordAppId: env('OXFORD_APP_ID') ?? '',
    oxfordAppKey: env('OXFORD_APP_KEY') ?? '',
    oxfordApiBase: (env('OXFORD_API_BASE') ?? 'https://od-api.oxforddictionaries.com/api/v2').replace(/\/+$/, ''),
    oxfordLanguage: env('OXFORD_LANGUAGE') ?? 'en-gb',
    wiktionaryApiBase: (env('WIKTIONARY_API_BASE') ?? 'https://en.wiktionary.org/api/rest_v1/page/definition').replace(/\/+$/, ''),
  },
};

export type Config = typeof config;
