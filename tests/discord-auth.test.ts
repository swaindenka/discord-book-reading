import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cookieHeader, startServer, type TestServer } from './helpers.js';

const GUILD = '111111111111111111';
const OTHER_GUILD = '444444444444444444';
const MOD_ROLE = '222222222222222222';

/** A stand-in for the few Discord API endpoints the OAuth flow uses. */
let discord: Server;
let discordBase = '';
const revoked: string[] = [];
const users: Record<string, { user: object; members: Record<string, object> }> = {
  'code-member': {
    user: { id: '80351110224678912', username: 'nelly', global_name: 'Nelly', avatar: 'abc123' },
    members: { [GUILD]: { nick: 'Nelly the Reader', roles: ['333'], avatar: null } },
  },
  'code-mod': {
    user: { id: '80351110224678913', username: 'modkat', global_name: null, avatar: null },
    members: { [GUILD]: { nick: null, roles: [MOD_ROLE], avatar: 'guildav' } },
  },
  'code-other-server': {
    user: { id: '80351110224678915', username: 'visitor', global_name: 'Visitor', avatar: null },
    members: { [OTHER_GUILD]: { nick: 'Guest Reader', roles: [], avatar: null } },
  },
  'code-outsider': {
    user: { id: '80351110224678914', username: 'stranger', global_name: 'Stranger', avatar: null },
    members: {},
  },
};

beforeAll(async () => {
  discord = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.replace('Bearer ', '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url === '/oauth2/token' && req.method === 'POST') {
        const params = new URLSearchParams(body);
        if (params.get('client_secret') !== 'secret' || !users[params.get('code') ?? '']) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: `token-${params.get('code')}`, token_type: 'Bearer' });
      }
      if (req.url === '/oauth2/token/revoke') {
        revoked.push(new URLSearchParams(body).get('token') ?? '');
        return json(200, {});
      }
      const entry = users[token.replace('token-', '')];
      if (!entry) return json(401, { message: '401: Unauthorized' });
      if (req.url === '/users/@me') return json(200, entry.user);
      const memberMatch = req.url?.match(/^\/users\/@me\/guilds\/(\d+)\/member$/);
      if (memberMatch) {
        const member = entry.members[memberMatch[1]];
        return member ? json(200, member) : json(404, { message: 'Unknown Guild', code: 10004 });
      }
      json(404, {});
    });
  });
  await new Promise<void>((resolve) => discord.listen(0, '127.0.0.1', resolve));
  discordBase = `http://127.0.0.1:${(discord.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => discord.close(() => resolve())));

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(guildIds: string[] = [GUILD], adminUserIds: string[] = []) {
  server = await startServer({
    devLogin: false,
    publicUrl: 'http://reading.test',
    adminUserIds,
    discord: {
      enabled: true,
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'http://reading.test/auth/discord/callback',
      guildIds,
      adminRoleIds: [MOD_ROLE],
      apiBase: discordBase,
    },
  });
  return server;
}

/** Runs the OAuth dance and returns the final redirect plus session cookie. */
async function signIn(s: TestServer, code: string, opts: { tamperState?: boolean; scope?: string } = {}) {
  const start = await fetch(`${s.base}/auth/discord?returnTo=${encodeURIComponent('/room/abcd1234')}`, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  expect(authorize.origin).toBe('https://discord.com');
  expect(authorize.searchParams.get('scope')).toBe(opts.scope ?? 'identify guilds.members.read');
  expect(authorize.searchParams.get('redirect_uri')).toBe('http://reading.test/auth/discord/callback');
  const state = opts.tamperState ? 'forged' : authorize.searchParams.get('state')!;
  const callback = await fetch(`${s.base}/auth/discord/callback?code=${code}&state=${state}`, {
    headers: { cookie: cookieHeader(start) },
    redirect: 'manual',
  });
  return { location: callback.headers.get('location'), cookie: cookieHeader(callback) };
}

describe('Discord sign-in', () => {
  it('signs in server members with their server nickname', async () => {
    const s = await start();
    const { location, cookie } = await signIn(s, 'code-member');
    expect(location).toBe('/room/abcd1234');
    const me = await (await s.fetch('/api/me', cookie)).json();
    expect(me.user).toMatchObject({
      id: '80351110224678912',
      name: 'Nelly the Reader',
      username: 'nelly',
      avatarUrl: 'https://cdn.discordapp.com/avatars/80351110224678912/abc123.png?size=128',
      isAdmin: false,
    });
    // We never keep Discord tokens around: each one is revoked after sign-in.
    await vi.waitFor(() => expect(revoked).toContain('token-code-member'));
  });

  it('makes members with an admin role site admins', async () => {
    const s = await start();
    const { cookie } = await signIn(s, 'code-mod');
    const me = await (await s.fetch('/api/me', cookie)).json();
    expect(me.user).toMatchObject({ name: 'modkat', isAdmin: true });
    expect(me.user.avatarUrl).toContain(`/guilds/${GUILD}/users/80351110224678913/avatars/guildav.png`);
  });

  it('turns away people who are not in the Discord server', async () => {
    const s = await start();
    const { location, cookie } = await signIn(s, 'code-outsider');
    expect(location).toBe('/login?error=not_member');
    expect(cookie).not.toContain('rr_session=');
  });

  it('rejects a forged OAuth state', async () => {
    const s = await start();
    const { location } = await signIn(s, 'code-member', { tamperState: true });
    expect(location).toBe('/login?error=state');
  });

  it('reports failed code exchanges', async () => {
    const s = await start();
    const { location } = await signIn(s, 'code-unknown');
    expect(location).toBe('/login?error=oauth_failed');
  });

  it('lets anyone with a Discord account in when no server list is set', async () => {
    const s = await start([]);
    const { location, cookie } = await signIn(s, 'code-outsider', { scope: 'identify' });
    expect(location).toBe('/room/abcd1234');
    const me = await (await s.fetch('/api/me', cookie)).json();
    expect(me.user).toMatchObject({ name: 'Stranger', isAdmin: false, isRootAdmin: false });
  });

  it('accepts members of any server in the allow-list', async () => {
    const s = await start([GUILD, OTHER_GUILD]);
    const { location, cookie } = await signIn(s, 'code-other-server');
    expect(location).toBe('/room/abcd1234');
    const me = await (await s.fetch('/api/me', cookie)).json();
    expect(me.user.name).toBe('Guest Reader');
  });

  it('makes people listed by user ID root site admins', async () => {
    const s = await start([], ['80351110224678914']);
    const { cookie } = await signIn(s, 'code-outsider', { scope: 'identify' });
    const me = await (await s.fetch('/api/me', cookie)).json();
    expect(me.user).toMatchObject({ isAdmin: true, isRootAdmin: true });
  });

  it('disables developer login when Discord is configured', async () => {
    const s = await start();
    const res = await fetch(`${s.base}/auth/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'reading-room' },
      body: JSON.stringify({ name: 'Sneaky' }),
    });
    expect(res.status).toBe(404);
  });
});
