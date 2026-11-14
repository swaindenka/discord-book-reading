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
    /** When set, only members of this Discord server may sign in. */
    guildId: env('DISCORD_GUILD_ID') ?? null,
    /** Members with one of these roles (in DISCORD_GUILD_ID) are site-wide admins. */
    adminRoleIds: list('DISCORD_ADMIN_ROLE_IDS'),
    apiBase: env('DISCORD_API_BASE') ?? 'https://discord.com/api/v10',
  },
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
};

export type Config = typeof config;
