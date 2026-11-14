import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, RoomState } from '../shared/types.js';
import { emit, FAKE_PDF, next, startServer, type TestServer } from './helpers.js';

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

type JoinResult = { state: RoomState; messages: ChatMessage[] };

async function setupRoom() {
  server = await startServer();
  const aliceCookie = await server.login('Alice');
  const bobCookie = await server.login('Bob');
  const { body } = await server.createRoom(aliceCookie, 'Book Club', { name: 'Dune.pdf', data: FAKE_PDF });
  const roomId = body.id!;
  const alice = await server.connect(aliceCookie);
  const bob = await server.connect(bobCookie);
  const aliceJoin = await emit<JoinResult>(alice, 'room:join', { roomId });
  const bobJoin = await emit<JoinResult>(bob, 'room:join', { roomId });
  if (!aliceJoin.ok || !bobJoin.ok) throw new Error('join failed');
  return { server, roomId, alice, bob, aliceCookie, bobCookie, state: bobJoin.state };
}

describe('HTTP API', () => {
  it('requires sign-in and the CSRF header', async () => {
    server = await startServer();
    expect((await fetch(`${server.base}/api/rooms`)).status).toBe(401);
    const noHeader = await fetch(`${server.base}/auth/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mallory' }),
    });
    expect(noHeader.status).toBe(403);
    const me = await (await fetch(`${server.base}/api/me`)).json();
    expect(me).toEqual({ user: null });
  });

  it('rejects sockets without a session', async () => {
    server = await startServer();
    await expect(server.connect('')).rejects.toThrow('unauthorized');
  });

  it('validates uploads by extension and content', async () => {
    server = await startServer();
    const cookie = await server.login('Alice');
    const fake = await server.createRoom(cookie, 'Bad', { name: 'virus.pdf', data: 'MZ this is not a pdf' });
    expect(fake.status).toBe(400);
    expect(fake.body.error).toMatch(/does not look like a valid PDF/);
    const unknown = await server.createRoom(cookie, 'Bad', { name: 'book.docx', data: 'PK\u0003\u0004' });
    expect(unknown.body.error).toMatch(/Unsupported file type/);
    const noName = await server.createRoom(cookie, '  ');
    expect(noName.status).toBe(400);
    // Failed uploads must not leave half-created rooms behind.
    const list = await (await server.fetch('/api/rooms', cookie)).json();
    expect(list.rooms).toHaveLength(0);
  });

  it('limits rooms per user', async () => {
    server = await startServer({ maxRoomsPerUser: 1 });
    const cookie = await server.login('Alice');
    expect((await server.createRoom(cookie, 'One')).status).toBe(201);
    const second = await server.createRoom(cookie, 'Two');
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/up to 1 rooms/);
  });

  it('serves book files to signed-in members', async () => {
    const { server, roomId, state, bobCookie } = await setupRoom();
    const book = state.books[0];
    expect(book).toMatchObject({ title: 'Dune', format: 'pdf' });
    const res = await server.fetch(`/api/books/${book.id}/file`, bobCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(await res.text()).toBe(FAKE_PDF);
    expect((await fetch(`${server.base}/api/books/${book.id}/file`)).status).toBe(401);
    const list = await (await server.fetch('/api/rooms', bobCookie)).json();
    expect(list.rooms[0]).toMatchObject({ id: roomId, bookTitle: 'Dune', bookFormat: 'pdf' });
    expect(list.rooms[0].online).toHaveLength(2);
  });
});

describe('reading turns', () => {
  it('runs a full turn cycle with finish and pass', async () => {
    const { alice, bob } = await setupRoom();

    const aliceReading = next<RoomState>(bob, 'room:state', (s) => s.reader?.name === 'Alice');
    expect(await emit(alice, 'queue:join')).toEqual({ ok: true });
    await aliceReading;

    expect((await emit(bob, 'queue:join')).ok).toBe(true);
    expect(await emit(bob, 'queue:join')).toEqual({ ok: false, error: 'You are already in the queue.' });

    // Only the reader may finish or pass.
    expect(await emit(bob, 'turn:finish')).toEqual({ ok: false, error: 'It is not your turn.' });

    const bobReading = next<RoomState>(alice, 'room:state', (s) => s.reader?.name === 'Bob');
    const finishedMessage = next<ChatMessage>(bob, 'chat:message', (m) => m.kind === 'system' && m.body.includes('finished'));
    expect((await emit(alice, 'turn:finish')).ok).toBe(true);
    const afterFinish = await bobReading;
    expect(afterFinish.queue.map((m) => m.name)).toEqual(['Alice']);
    expect((await finishedMessage).body).toBe('Alice finished their turn. Bob is reading now.');

    const aliceAgain = next<RoomState>(bob, 'room:state', (s) => s.reader?.name === 'Alice');
    expect((await emit(bob, 'turn:pass')).ok).toBe(true);
    expect((await aliceAgain).queue.map((m) => m.name)).toEqual(['Bob']);
  });

  it('only lets the reader or a moderator turn pages, and syncs everyone else', async () => {
    const { alice, bob, state } = await setupRoom();
    const bookId = state.books[0].id;

    const denied = await emit(bob, 'nav:set', { bookId, position: { kind: 'page', page: 3 } });
    expect(denied).toEqual({ ok: false, error: 'Only the current reader can turn pages.' });

    // Alice owns the room, so she can steer even when nobody is reading.
    const moved = next<{ position: unknown }>(bob, 'nav:position');
    expect((await emit(alice, 'nav:set', { bookId, position: { kind: 'page', page: 4, scroll: 0.5 } })).ok).toBe(true);
    expect((await moved).position).toEqual({ kind: 'page', page: 4, scroll: 0.5 });

    expect((await emit(alice, 'nav:set', { bookId, position: { kind: 'cfi', cfi: 'epubcfi(/6/2)' } })).ok).toBe(false);
    expect((await emit(alice, 'nav:set', { bookId, position: { kind: 'page', page: -1 } })).ok).toBe(false);

    await emit(bob, 'queue:join');
    const pageFive = next<{ position: unknown }>(alice, 'nav:position');
    expect((await emit(bob, 'nav:set', { bookId, position: { kind: 'page', page: 5 } })).ok).toBe(true);
    expect((await pageFive).position).toEqual({ kind: 'page', page: 5 });
  });

  it('keeps the position after a restart', async () => {
    const { server: first, alice, roomId, state, aliceCookie } = await setupRoom();
    await emit(alice, 'nav:set', { bookId: state.books[0].id, position: { kind: 'page', page: 7 } });
    await emit(alice, 'queue:join');
    await first.close({ keepData: true });

    server = await startServer({}, { dir: first.dir });
    const again = await server.connect(aliceCookie);
    const join = await emit<JoinResult>(again, 'room:join', { roomId });
    expect(join.ok && join.state.position).toEqual({ kind: 'page', page: 7 });
    expect(join.ok && join.state.reader?.name).toBe('Alice');
    expect(join.ok && join.messages.some((m) => m.body === 'Alice is reading now.')).toBe(true);
  });
});

describe('chat and moderation', () => {
  it('delivers chat and enforces delete permissions', async () => {
    const { alice, bob } = await setupRoom();
    const received = next<ChatMessage>(alice, 'chat:message', (m) => m.kind === 'user');
    expect((await emit(bob, 'chat:send', { body: '  Hello there  ' })).ok).toBe(true);
    const message = await received;
    expect(message).toMatchObject({ body: 'Hello there', authorName: 'Bob' });

    expect((await emit(bob, 'chat:send', { body: '' })).ok).toBe(false);
    expect((await emit(bob, 'chat:send', { body: 'x'.repeat(1001) })).ok).toBe(false);

    const aliceMessage = next<ChatMessage>(bob, 'chat:message', (m) => m.authorName === 'Alice');
    await emit(alice, 'chat:send', { body: 'Mine' });
    const mine = await aliceMessage;
    expect(await emit(bob, 'chat:delete', { messageId: mine.id })).toEqual({
      ok: false,
      error: 'You can only delete your own messages.',
    });
    // The owner moderates everything.
    const deleted = next<{ id: string }>(bob, 'chat:deleted');
    expect((await emit(alice, 'chat:delete', { messageId: message.id })).ok).toBe(true);
    expect((await deleted).id).toBe(message.id);
  });

  it('rate-limits chat floods', async () => {
    const { bob } = await setupRoom();
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await emit(bob, 'chat:send', { body: `spam ${i}` }));
    expect(results.filter((r) => !r.ok)).not.toHaveLength(0);
  });

  it('lets owners manage moderators, queue and bans', async () => {
    const { server, alice, bob, roomId, bobCookie, state } = await setupRoom();
    const bobId = state.members.find((m) => m.name === 'Bob')!.id;
    const aliceId = state.ownerId;

    expect(await emit(bob, 'mod:action', { type: 'queue.shuffle' })).toEqual({ ok: false, error: 'Only moderators can do that.' });

    // Lock the queue: regular members can no longer join.
    expect((await emit(alice, 'mod:action', { type: 'settings', settings: { queueLocked: true } })).ok).toBe(true);
    expect((await emit(bob, 'queue:join')).ok).toBe(false);
    expect((await emit(alice, 'mod:action', { type: 'queue.add', userId: bobId })).ok).toBe(true);

    // Moderators cannot act on the owner.
    expect((await emit(alice, 'mod:action', { type: 'mod.grant', userId: bobId })).ok).toBe(true);
    expect(await emit(bob, 'mod:action', { type: 'member.kick', userId: aliceId })).toEqual({
      ok: false,
      error: 'You cannot moderate someone with the same or a higher role.',
    });
    expect((await emit(bob, 'mod:action', { type: 'mod.grant', userId: aliceId })).ok).toBe(false);

    // Banning removes Bob (who is reading) and keeps him out.
    const kicked = next<{ banned: boolean }>(bob, 'room:kicked');
    expect((await emit(alice, 'mod:action', { type: 'member.ban', userId: bobId })).ok).toBe(true);
    expect(await kicked).toEqual({ banned: true });
    const rejoin = await emit(bob, 'room:join', { roomId });
    expect(rejoin).toEqual({ ok: false, error: 'You are banned from this room.' });
    expect((await server.fetch(`/api/books/${state.books[0].id}/file`, bobCookie)).status).toBe(403);

    const after = await emit<JoinResult>(alice, 'room:join', { roomId });
    expect(after.ok && after.state.reader).toBeNull();
    expect(after.ok && after.state.moderators).toEqual([]);
    expect((await emit(alice, 'mod:action', { type: 'member.unban', userId: bobId })).ok).toBe(true);
    expect((await emit(bob, 'room:join', { roomId })).ok).toBe(true);
  });

  it('only lets the owner delete a room', async () => {
    const { server, roomId, aliceCookie, bobCookie, bob } = await setupRoom();
    expect((await server.fetch(`/api/rooms/${roomId}`, bobCookie, { method: 'DELETE' })).status).toBe(403);
    const gone = next(bob, 'room:deleted');
    expect((await server.fetch(`/api/rooms/${roomId}`, aliceCookie, { method: 'DELETE' })).status).toBe(200);
    await gone;
    expect((await emit(bob, 'room:join', { roomId })).ok).toBe(false);
  });
});

describe('database storage driver', () => {
  it('stores books as chunks and serves identical bytes', async () => {
    server = await startServer({ storageDriver: 'database' });
    const cookie = await server.login('Alice');
    const data = new Uint8Array(700 * 1024 + 123);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) % 256;
    data.set(new TextEncoder().encode('%PDF-1.7'), 0);
    const { body } = await server.createRoom(cookie, 'Big', { name: 'big.pdf', data });
    const socket = await server.connect(cookie);
    const join = await emit<JoinResult>(socket, 'room:join', { roomId: body.id });
    const book = join.ok ? join.state.books[0] : null;
    const res = await server.fetch(`/api/books/${book!.id}/file`, cookie);
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(data.length);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(data))).toBe(0);
    const chunks = await server.db.client.execute('SELECT COUNT(*) AS n FROM book_chunks');
    expect(Number(chunks.rows[0].n)).toBe(3);
  });
});
