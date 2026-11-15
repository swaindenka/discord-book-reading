import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ReactionEvent, ReaderStat, RoomState } from '../shared/types.js';
import { emit, FAKE_PDF, next, startServer, type TestServer } from './helpers.js';

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

type JoinResult = { state: RoomState; messages: ChatMessage[] };

const ALICE = '111111111111111111';
const BOB = '222222222222222222';

async function room(overrides: Parameters<typeof startServer>[0] = {}) {
  server = await startServer(overrides);
  const aliceCookie = await server.loginAs(ALICE, 'Alice');
  const bobCookie = await server.loginAs(BOB, 'Bob');
  const { body } = await server.createRoom(aliceCookie, 'Night Owls', { name: 'Circe -- Madeline Miller -- 9f8e7d6c5b4a3f2e -- Z-Library.pdf', data: FAKE_PDF });
  const alice = await server.connect(aliceCookie);
  const bob = await server.connect(bobCookie);
  const join = await emit<JoinResult>(alice, 'room:join', { roomId: body.id });
  await emit(bob, 'room:join', { roomId: body.id });
  if (!join.ok) throw new Error('join failed');
  return { server, alice, bob, roomId: body.id!, state: join.state };
}

describe('Discord channel notifications', () => {
  let hook: Server;
  let hookBase = '';
  let received: { content: string; allowed_mentions: { users: string[] } }[] = [];
  let status = 204;

  beforeAll(async () => {
    hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (status === 204) received.push(JSON.parse(body));
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    hookBase = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/api/webhooks/`;
  });
  afterAll(() => new Promise<void>((resolve) => hook.close(() => resolve())));

  const waitFor = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3000 });

  it('posts session start, turn changes with pings, book switches and schedules', async () => {
    received = [];
    status = 204;
    const { alice, bob, roomId } = await room({ webhookExtraPrefixes: [hookBase], publicUrl: 'https://club.example' });

    expect(await emit(alice, 'mod:action', { type: 'webhook.set', url: 'https://example.com/hook' })).toMatchObject({ ok: false });
    expect(await emit(bob, 'mod:action', { type: 'webhook.set', url: `${hookBase}1/abc` })).toMatchObject({ ok: false });
    const connected = next<RoomState>(bob, 'room:state', (s) => s.webhookConnected);
    expect((await emit(alice, 'mod:action', { type: 'webhook.set', url: `${hookBase}123/secret-token` })).ok).toBe(true);
    // Members only learn that a webhook exists, never its URL.
    expect(JSON.stringify(await connected)).not.toContain('secret-token');

    expect((await emit(alice, 'mod:action', { type: 'webhook.test' })).ok).toBe(true);
    expect(received.at(-1)!.content).toContain('will appear in this channel');

    // First turn of the evening: "reading has started", pinging the reader.
    await emit(bob, 'queue:join');
    await waitFor(() => received.some((m) => m.content.startsWith('📖')));
    const start = received.find((m) => m.content.startsWith('📖'))!;
    expect(start.content).toBe(
      `📖 Reading has started in **Night Owls**: *Circe* by Madeline Miller. <@${BOB}> reads first. Join here: https://club.example/room/${roomId}`,
    );
    expect(start.allowed_mentions.users).toEqual([BOB]);

    // Hand-over: the next reader is pinged.
    await emit(alice, 'queue:join');
    await emit(bob, 'turn:finish');
    await waitFor(() => received.some((m) => m.content.startsWith('🎙️')));
    expect(received.find((m) => m.content.startsWith('🎙️'))!.content).toContain(`<@${ALICE}>, it's your turn to read in **Night Owls**.`);

    // Without pings, names are written out and nobody is mentioned.
    await emit(alice, 'mod:action', { type: 'settings', settings: { pingReaders: false } });
    received = [];
    await emit(alice, 'turn:finish');
    await waitFor(() => received.length > 0);
    expect(received[0].content).toContain('**Bob**, it\'s your turn');
    expect(received[0].allowed_mentions.users).toEqual([]);

    // Scheduling a session posts a Discord timestamp.
    const at = Date.now() + 2 * 86_400_000;
    received = [];
    expect((await emit(alice, 'mod:action', { type: 'settings', settings: { nextSessionAt: at } })).ok).toBe(true);
    await waitFor(() => received.length > 0);
    expect(received[0].content).toMatch(/^🗓️ Next reading session in \*\*Night Owls\*\*: <t:\d+:F> \(<t:\d+:R>\)/);
    expect((await emit(alice, 'mod:action', { type: 'settings', settings: { nextSessionAt: Date.now() + 400 * 86_400_000 } })).ok).toBe(false);

    // A webhook Discord rejects shows a useful error on test.
    status = 404;
    expect(await emit(alice, 'mod:action', { type: 'webhook.test' })).toEqual({
      ok: false,
      error: "Discord didn't accept the test message: the webhook was deleted in Discord.",
    });
  });
});

describe('reading stats', () => {
  it('adds up reading time and orders the queue by who has read least', async () => {
    const { server, alice, bob, roomId, state } = await room();
    const bookId = state.books[0].id;
    const carolCookie = await server.loginAs('333333333333333333', 'Carol');
    const carol = await server.connect(carolCookie);
    await emit(carol, 'room:join', { roomId });

    // History: Alice read 10 min, Bob 2 min and passed once.
    const now = Date.now();
    const add = (userId: string, name: string, minutes: number, reason: string, i: number) =>
      server.db.addTurn({ id: `t${i}`, roomId, bookId, userId, userName: name, startedAt: now - minutes * 60_000 - 1000, endedAt: now - 1000, reason });
    await add(ALICE, 'Alice', 10, 'finished', 1);
    await add(BOB, 'Bob', 2, 'finished', 2);
    await add(BOB, 'Bob', 0, 'passed', 3);

    const stats = await emit<{ stats: ReaderStat[] }>(bob, 'stats:get', { scope: 'book' });
    expect(stats.ok && stats.stats.map((s) => [s.name, s.turns, s.passes, s.seconds])).toEqual([
      ['Alice', 1, 0, 600],
      ['Bob', 1, 1, 120],
    ]);

    // Alice reads; Bob then Carol wait. Least-read first puts Carol (never read) ahead of Bob.
    await emit(alice, 'queue:join');
    await emit(bob, 'queue:join');
    await emit(carol, 'queue:join');
    expect((await emit(bob, 'mod:action', { type: 'queue.fair' })).ok).toBe(false);
    const fair = next<RoomState>(alice, 'room:state', (s) => s.queue[0]?.name === 'Carol');
    expect((await emit(alice, 'mod:action', { type: 'queue.fair' })).ok).toBe(true);
    expect((await fair).queue.map((m) => m.name)).toEqual(['Carol', 'Bob']);
  });

  it('records real turns, including the one in progress', async () => {
    const { alice, bob } = await room();
    await emit(bob, 'queue:join');
    await emit(alice, 'queue:join');
    await emit(bob, 'turn:pass');
    const stats = await emit<{ stats: ReaderStat[] }>(alice, 'stats:get', { scope: 'room' });
    const byName = Object.fromEntries((stats.ok ? stats.stats : []).map((s) => [s.name, s]));
    expect(byName.Bob).toMatchObject({ turns: 0, passes: 1 });
    expect(byName.Alice).toMatchObject({ turns: 1, passes: 0 }); // reading right now
  });
});

describe('reactions and page counts', () => {
  it('broadcasts allowed reactions and drops floods', async () => {
    const { alice, bob } = await room();
    const seen: ReactionEvent[] = [];
    alice.on('reaction', (r) => seen.push(r));
    (bob as unknown as { emit: (e: string, p: unknown) => void }).emit('reaction', { emoji: '👏' });
    (bob as unknown as { emit: (e: string, p: unknown) => void }).emit('reaction', { emoji: '<script>' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ name: 'Bob', emoji: '👏' });
    for (let i = 0; i < 20; i++) (bob as unknown as { emit: (e: string, p: unknown) => void }).emit('reaction', { emoji: '🔥' });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.length).toBeLessThan(10);
  });

  it('keeps the first reported page count; only moderators or the reader can correct it', async () => {
    const { alice, bob, state } = await room();
    const bookId = state.books[0].id;
    const counted = next<RoomState>(alice, 'room:state', (s) => s.books[0].pageCount === 300);
    (bob as unknown as { emit: (e: string, p: unknown) => void }).emit('book:pages', { bookId, pageCount: 300 });
    await counted;
    (bob as unknown as { emit: (e: string, p: unknown) => void }).emit('book:pages', { bookId, pageCount: 5 });
    const corrected = next<RoomState>(bob, 'room:state', (s) => s.books[0].pageCount === 301);
    (alice as unknown as { emit: (e: string, p: unknown) => void }).emit('book:pages', { bookId, pageCount: 301 });
    expect((await corrected).books[0].pageCount).toBe(301);
  });
});
