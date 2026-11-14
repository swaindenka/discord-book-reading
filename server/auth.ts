import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Config } from './config.js';
import type { Database, UserRecord } from './db.js';
import type { PublicUser } from '../shared/types.js';

export const SESSION_COOKIE = 'rr_session';
const OAUTH_COOKIE = 'rr_oauth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRecord;
    }
  }
}

export function toPublicUser(user: UserRecord, isRootAdmin = false): PublicUser {
  return {
    id: user.id,
    name: user.displayName,
    username: user.username,
    avatarUrl: user.avatarUrl,
    isAdmin: user.isAdmin || isRootAdmin,
    isRootAdmin,
  };
}

/** Discord user IDs are 17–20 digit snowflakes; developer-login IDs look like "dev-name". */
export function isValidUserId(id: string) {
  return /^\d{15,22}$/.test(id) || /^dev-[a-z0-9-]{1,40}$/.test(id);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** HMAC-signed, expiring tokens used for the session and OAuth state cookies. */
export class Signer {
  constructor(private readonly secret: string) {}

  private mac(data: string) {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }

  sign(payload: object, ttlSeconds: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  verify<T>(token: string | undefined): T | null {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
      if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }
}

/**
 * Small in-memory cache in front of the users table. It also keeps every cached user's
 * `isAdmin` flag current: admins come from ADMIN_USER_IDS ("root" admins), from the
 * site_admins table (added in the app), or from a Discord role.
 */
export class UserCache {
  private cache = new Map<string, UserRecord>();
  private readonly rootAdmins: Set<string>;
  private addedAdmins = new Set<string>();
  private readonly adminsLoaded: Promise<void>;

  constructor(
    private readonly db: Database,
    rootAdminIds: string[] = [],
  ) {
    this.rootAdmins = new Set(rootAdminIds);
    this.adminsLoaded = this.reloadAdmins();
  }

  /** Re-reads the site_admins table and updates every cached user. */
  async reloadAdmins() {
    this.addedAdmins = new Set((await this.db.listSiteAdmins()).map((a) => a.userId));
    for (const user of this.cache.values()) this.apply(user);
  }

  isRootAdmin(id: string) {
    return this.rootAdmins.has(id);
  }

  isAddedAdmin(id: string) {
    return this.addedAdmins.has(id);
  }

  get rootAdminIds() {
    return [...this.rootAdmins];
  }

  private apply(user: UserRecord) {
    user.isAdmin = user.roleAdmin || this.rootAdmins.has(user.id) || this.addedAdmins.has(user.id);
    return user;
  }

  peek(id: string) {
    return this.cache.get(id);
  }

  async get(id: string): Promise<UserRecord | null> {
    await this.adminsLoaded;
    const cached = this.cache.get(id);
    if (cached) return cached;
    const user = await this.db.getUser(id);
    if (user) this.cache.set(id, this.apply(user));
    return user;
  }

  async preload(ids: Iterable<string>) {
    await this.adminsLoaded;
    const missing = [...new Set(ids)].filter((id) => !this.cache.has(id));
    if (missing.length === 0) return;
    for (const user of await this.db.getUsers(missing)) this.cache.set(user.id, this.apply(user));
  }

  async save(user: UserRecord) {
    await this.adminsLoaded;
    await this.db.upsertUser(user);
    // Keep the same object identity so open sockets see profile and role changes.
    const cached = this.cache.get(user.id);
    const target = cached ? Object.assign(cached, user) : user;
    this.cache.set(user.id, this.apply(target));
    return target;
  }
}

interface SessionPayload {
  uid: string;
}

interface OAuthPayload {
  state: string;
  returnTo: string;
}

/** Only allow same-site relative paths as post-login destinations. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value.slice(0, 300);
}

export function discordAvatarUrl(user: { id: string; avatar?: string | null }, guild?: { id: string; avatar?: string | null }) {
  if (guild?.avatar) {
    return `https://cdn.discordapp.com/guilds/${guild.id}/users/${user.id}/avatars/${guild.avatar}.png?size=128`;
  }
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  let index = 0;
  try {
    index = Number((BigInt(user.id) >> 22n) % 6n);
  } catch {
    /* non-numeric id */
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export class Auth {
  readonly signer: Signer;

  constructor(
    private readonly config: Config,
    readonly users: UserCache,
  ) {
    this.signer = new Signer(config.sessionSecret);
  }

  private cookieOptions(maxAgeMs: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.config.secureCookies,
      path: '/',
      maxAge: maxAgeMs,
    };
  }

  /** Resolves the signed-in user from a raw HTTP request (used by Express and Socket.IO). */
  async userFromRequest(req: IncomingMessage): Promise<UserRecord | null> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = this.signer.verify<SessionPayload>(token);
    if (!session) return null;
    return this.users.get(session.uid);
  }

  middleware() {
    return async (req: Request, _res: Response, next: NextFunction) => {
      try {
        req.user = (await this.userFromRequest(req)) ?? undefined;
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  private async startSession(res: Response, user: UserRecord) {
    user = await this.users.save(user);
    const ttl = this.config.sessionDays * 24 * 3600;
    res.cookie(SESSION_COOKIE, this.signer.sign({ uid: user.id }, ttl), this.cookieOptions(ttl * 1000));
  }

  router() {
    const router = Router();
    const { discord } = this.config;

    router.get('/discord', (req, res) => {
      if (!discord.enabled) return res.redirect('/login?error=discord_disabled');
      const state = randomBytes(16).toString('base64url');
      const returnTo = safeReturnTo(req.query.returnTo);
      res.cookie(OAUTH_COOKIE, this.signer.sign({ state, returnTo }, 600), this.cookieOptions(600_000));
      const params = new URLSearchParams({
        client_id: discord.clientId,
        redirect_uri: discord.redirectUri,
        response_type: 'code',
        scope: discord.guildIds.length ? 'identify guilds.members.read' : 'identify',
        state,
        prompt: 'none',
      });
      res.redirect(`https://discord.com/oauth2/authorize?${params}`);
    });

    router.get('/discord/callback', async (req, res) => {
      const saved = this.signer.verify<OAuthPayload>(parseCookies(req.headers.cookie)[OAUTH_COOKIE]);
      res.clearCookie(OAUTH_COOKIE, { path: '/' });
      if (!discord.enabled) return res.redirect('/login?error=discord_disabled');
      if (req.query.error) return res.redirect('/login?error=denied');
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!saved || !code || req.query.state !== saved.state) return res.redirect('/login?error=state');
      try {
        const result = await this.discordLogin(code);
        if ('error' in result) return res.redirect(`/login?error=${result.error}`);
        await this.startSession(res, result.user);
        res.redirect(saved.returnTo);
      } catch (err) {
        console.error('[auth] Discord login failed:', err);
        res.redirect('/login?error=oauth_failed');
      }
    });

    router.post('/dev', async (req, res) => {
      if (!this.config.devLogin) return res.status(404).json({ error: 'Developer login is disabled.' });
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
      if (name.length < 2 || name.length > 32) {
        return res.status(400).json({ error: 'Pick a name between 2 and 32 characters.' });
      }
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'reader';
      const id = `dev-${slug}`;
      const user: UserRecord = {
        id,
        username: slug,
        displayName: name,
        avatarUrl: null,
        roleAdmin: false,
        isAdmin: false,
      };
      await this.startSession(res, user);
      res.json({ user: toPublicUser(user, this.users.isRootAdmin(id)) });
    });

    router.post('/logout', (_req, res) => {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.json({ ok: true });
    });

    return router;
  }

  /** Exchanges an OAuth code for the Discord profile (and server membership, when required). */
  private async discordLogin(code: string): Promise<{ user: UserRecord } | { error: string }> {
    const { discord } = this.config;
    const tokenRes = await fetch(`${discord.apiBase}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: discord.clientId,
        client_secret: discord.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: discord.redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      console.error('[auth] token exchange failed', tokenRes.status, await tokenRes.text().catch(() => ''));
      return { error: 'oauth_failed' };
    }
    const token = (await tokenRes.json()) as { access_token: string; token_type: string };
    const authHeader = { Authorization: `Bearer ${token.access_token}` };

    try {
      const meRes = await fetch(`${discord.apiBase}/users/@me`, { headers: authHeader });
      if (!meRes.ok) return { error: 'oauth_failed' };
      const me = (await meRes.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };

      // With an allow-list of servers, the person must be in at least one of them. Their
      // nickname and avatar come from the first server they're in; roles from all of them.
      let nick: string | null = null;
      let guildAvatar: { id: string; avatar: string | null } | undefined;
      const roles: string[] = [];
      let memberOfAny = false;
      for (const guildId of discord.guildIds) {
        const memberRes = await fetch(`${discord.apiBase}/users/@me/guilds/${guildId}/member`, { headers: authHeader });
        if (memberRes.status === 429 || memberRes.status >= 500) return { error: 'oauth_failed' };
        if (!memberRes.ok) continue;
        const member = (await memberRes.json()) as { nick?: string | null; avatar?: string | null; roles?: string[] };
        if (!memberOfAny) {
          nick = member.nick ?? null;
          guildAvatar = { id: guildId, avatar: member.avatar ?? null };
        }
        memberOfAny = true;
        if (Array.isArray(member.roles)) roles.push(...member.roles);
      }
      if (discord.guildIds.length && !memberOfAny) return { error: 'not_member' };

      const roleAdmin = roles.some((role) => discord.adminRoleIds.includes(role));
      return {
        user: {
          id: me.id,
          username: me.username,
          displayName: (nick || me.global_name || me.username).slice(0, 64),
          avatarUrl: discordAvatarUrl(me, guildAvatar),
          roleAdmin,
          isAdmin: roleAdmin,
        },
      };
    } finally {
      // We never store Discord tokens; revoke this one now that we have what we need.
      fetch(`${discord.apiBase}/oauth2/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: discord.clientId,
          client_secret: discord.clientSecret,
          token: token.access_token,
          token_type_hint: 'access_token',
        }),
      }).catch(() => {});
    }
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in first.' });
  next();
}
