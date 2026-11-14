import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BookHighlight, ChatMessage, DictionaryResult, RoomState, SiteAdmin } from '../shared/types.js';
import { emit, FAKE_PDF, next, startServer, type TestServer } from './helpers.js';

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

type JoinResult = { state: RoomState; messages: ChatMessage[]; highlights: BookHighlight[] };

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('site admins by user ID', () => {
  it('lets root admins add and remove admins who then moderate every room', async () => {
    server = await startServer({ adminUserIds: ['dev-root'] });
    const root = await server.login('Root');
    const helper = await server.login('Helper');
    const owner = await server.login('Owner');
    const { body } = await server.createRoom(owner, 'Owner room');
    const roomId = body.id!;

    const me = await (await server.fetch('/api/me', root)).json();
    expect(me.user).toMatchObject({ id: 'dev-root', isAdmin: true, isRootAdmin: true });

    // Helper joins the room as a plain member.
    const helperSocket = await server.connect(helper);
    const joined = await emit<JoinResult>(helperSocket, 'room:join', { roomId });
    expect(joined.ok && joined.state.members.find((m) => m.id === 'dev-helper')?.role).toBe('member');

    // Only root admins may manage the list; IDs are validated.
    expect((await server.fetch('/api/admins', helper, json({ userId: 'dev-helper' }))).status).toBe(403);
    expect((await server.fetch('/api/admins', root, json({ userId: 'not an id' }))).status).toBe(400);

    const promoted = next<RoomState>(helperSocket, 'room:state', (s) => s.members.some((m) => m.id === 'dev-helper' && m.role === 'admin'));
    const added = await server.fetch('/api/admins', root, json({ userId: 'dev-helper' }));
    expect(added.status).toBe(201);
    const list = (await added.json()).admins as SiteAdmin[];
    expect(list.map((a) => [a.userId, a.fromConfig, a.name])).toEqual([
      ['dev-root', true, 'Root'],
      ['dev-helper', false, 'Helper'],
    ]);
    await promoted; // open connections see the new role right away

    // The new admin moderates a room they don't own, but can't manage admins.
    expect((await emit(helperSocket, 'mod:action', { type: 'queue.shuffle' })).ok).toBe(true);
    expect((await server.fetch('/api/admins', helper, json({ userId: '214716433790140416' }))).status).toBe(403);
    expect((await server.fetch('/api/admins', helper)).status).toBe(200);

    // Root admins from the config can't be removed in the app.
    expect((await server.fetch('/api/admins/dev-root', root, { method: 'DELETE' })).status).toBe(400);
    expect((await server.fetch('/api/admins/dev-helper', root, { method: 'DELETE' })).status).toBe(200);
    const after = await (await server.fetch('/api/me', helper)).json();
    expect(after.user.isAdmin).toBe(false);
    expect((await emit(helperSocket, 'mod:action', { type: 'queue.shuffle' })).ok).toBe(false);
  });
});

describe('highlights', () => {
  async function setup() {
    server = await startServer();
    const ownerCookie = await server.login('Owner');
    const readerCookie = await server.login('Reader');
    const { body } = await server.createRoom(ownerCookie, 'Club', { name: 'Book.pdf', data: FAKE_PDF });
    const owner = await server.connect(ownerCookie);
    const reader = await server.connect(readerCookie);
    const roomId = body.id!;
    const join = await emit<JoinResult>(owner, 'room:join', { roomId });
    await emit(reader, 'room:join', { roomId });
    if (!join.ok) throw new Error('join failed');
    return { server, owner, reader, roomId, ownerCookie, bookId: join.state.books[0].id };
  }

  const rectHighlight = (bookId: string) => ({
    bookId,
    color: 'yellow',
    anchor: { kind: 'rects', page: 3, rects: [[0.1, 0.2, 0.5, 0.03]] },
    text: '  the   light answered ',
    label: '',
  });

  it('lets moderators highlight and shares highlights with everyone', async () => {
    const { owner, reader, roomId, bookId } = await setup();

    expect(await emit(reader, 'highlight:add', rectHighlight(bookId))).toEqual({
      ok: false,
      error: 'Only moderators can highlight.',
    });
    expect((await emit(owner, 'highlight:add', { ...rectHighlight(bookId), color: 'purple' })).ok).toBe(false);
    const wrongKind = { ...rectHighlight(bookId), anchor: { kind: 'cfi', cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:5)' } };
    expect(await emit(owner, 'highlight:add', wrongKind)).toEqual({ ok: false, error: 'Invalid highlight.' });
    const offPage = { ...rectHighlight(bookId), anchor: { kind: 'rects', page: 3, rects: [[0.5, 0.5, 2, 0.1]] } };
    expect((await emit(owner, 'highlight:add', offPage)).ok).toBe(false);

    const seen = next<BookHighlight>(reader, 'highlight:added');
    const added = await emit<{ highlight: BookHighlight }>(owner, 'highlight:add', rectHighlight(bookId));
    expect(added.ok).toBe(true);
    const highlight = added.ok ? added.highlight : null;
    expect(highlight).toMatchObject({ color: 'yellow', text: 'the light answered', label: 'Page 3', createdByName: 'Owner' });
    expect((await seen).id).toBe(highlight!.id);

    // Highlights come with the room when someone (re)joins.
    const rejoin = await emit<JoinResult>(reader, 'room:join', { roomId });
    expect(rejoin.ok && rejoin.highlights.map((h) => h.id)).toEqual([highlight!.id]);

    expect((await emit(reader, 'highlight:remove', { id: highlight!.id })).ok).toBe(false);
    const removed = next<{ id: string }>(reader, 'highlight:removed');
    expect((await emit(owner, 'highlight:remove', { id: highlight!.id })).ok).toBe(true);
    expect((await removed).id).toBe(highlight!.id);
  });

  it('keeps highlights per book and survives restarts', async () => {
    const { server: first, owner, roomId, bookId, ownerCookie } = await setup();
    await emit(owner, 'highlight:add', rectHighlight(bookId));

    // A second book has its own (empty) set of highlights.
    const form = new FormData();
    form.set('file', new Blob(['Chapter one\n\nIt was a dark night.']), 'Story.txt');
    await first.fetch(`/api/rooms/${roomId}/books`, ownerCookie, { method: 'POST', body: form });
    const state = await emit<JoinResult>(owner, 'room:join', { roomId });
    const txtId = state.ok ? state.state.books.find((b) => b.format === 'txt')!.id : '';
    const switched = next<{ bookId: string; highlights: BookHighlight[] }>(owner, 'highlights:set');
    await emit(owner, 'mod:action', { type: 'book.activate', bookId: txtId });
    expect(await switched).toEqual({ bookId: txtId, highlights: [] });
    const textHighlight = {
      bookId: txtId,
      color: 'blue',
      anchor: { kind: 'text', page: 1, start: 0, end: 7 },
      text: 'Chapter',
      label: 'Page 1',
    };
    expect((await emit(owner, 'highlight:add', textHighlight)).ok).toBe(true);
    await emit(owner, 'mod:action', { type: 'book.activate', bookId });
    await first.close({ keepData: true });

    server = await startServer({}, { dir: first.dir });
    const again = await server.connect(ownerCookie);
    const join = await emit<JoinResult>(again, 'room:join', { roomId });
    expect(join.ok && join.highlights.map((h) => h.anchor.kind)).toEqual(['rects']);
  });
});

describe('dictionary', () => {
  let fake: Server;
  let base = '';
  const calls: string[] = [];

  beforeAll(async () => {
    fake = createServer((req: IncomingMessage, res) => {
      calls.push(`${req.headers.app_id ?? '-'} ${req.url}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      // Free Dictionary API format
      if (url === '/free/lighthouse') {
        return send(200, [
          {
            word: 'lighthouse',
            phonetics: [{ text: '/ˈlaɪthaʊs/' }],
            meanings: [
              {
                partOfSpeech: 'noun',
                definitions: [{ definition: 'A tower containing a strong light to guide ships.', example: 'The lighthouse beam swept the bay.' }],
              },
            ],
          },
        ]);
      }
      if (url.startsWith('/free/')) return send(404, { title: 'No Definitions Found' });
      // Oxford Dictionaries API format
      if (req.headers.app_id !== 'oxid' || req.headers.app_key !== 'oxkey') return send(403, { error: 'Authentication failed' });
      if (url.startsWith('/oxford/entries/en-gb/run?')) {
        return send(200, {
          results: [
            {
              word: 'run',
              lexicalEntries: [
                {
                  lexicalCategory: { text: 'Verb' },
                  entries: [
                    {
                      pronunciations: [{ phoneticSpelling: 'rʌn' }],
                      senses: [{ definitions: ['move at a speed faster than a walk'], examples: [{ text: 'the dog ran across the road' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
      if (url.startsWith('/oxford/entries/')) return send(404, { error: 'No entry found' });
      if (url === '/oxford/lemmas/en-gb/ran') {
        return send(200, { results: [{ lexicalEntries: [{ inflectionOf: [{ id: 'run' }] }] }] });
      }
      send(404, {});
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => fake.close(() => resolve())));

  it('looks words up in the free dictionary, tries base forms and caches answers', async () => {
    server = await startServer({ dictionary: { provider: 'free', freeApiBase: `${base}/free` } });
    const cookie = await server.login('Reader');
    const config = await (await server.fetch('/api/config', cookie)).json();
    expect(config.dictionary).toBe('free');

    const res = await server.fetch(`/api/dictionary?word=${encodeURIComponent('“Lighthouses,”')}`, cookie);
    expect(res.status).toBe(200);
    const result = (await res.json()) as DictionaryResult;
    expect(result.query).toBe('lighthouses');
    expect(result.oxfordUrl).toBe('https://www.oxfordlearnersdictionaries.com/search/english/?q=lighthouses');
    expect(result.entry).toMatchObject({
      word: 'lighthouse',
      phonetic: '/ˈlaɪthaʊs/',
      source: 'free',
      senses: [{ partOfSpeech: 'noun', definitions: [{ example: 'The lighthouse beam swept the bay.' }] }],
    });

    const before = calls.length;
    await server.fetch('/api/dictionary?word=lighthouses', cookie);
    expect(calls.length).toBe(before); // answered from the cache

    const missing = (await (await server.fetch('/api/dictionary?word=zzxq', cookie)).json()) as DictionaryResult;
    expect(missing.entry).toBeNull();
    expect((await server.fetch('/api/dictionary?word=1234', cookie)).status).toBe(400);
    expect((await server.fetch('/api/dictionary?word=he11o', cookie)).status).toBe(400);
    expect((await server.fetch('/api/dictionary?word=one two three four five', cookie)).status).toBe(400);
    expect((await fetch(`${server.base}/api/dictionary?word=hello`)).status).toBe(401);
  });

  it('uses the Oxford Dictionaries API when keys are set, including inflected forms', async () => {
    server = await startServer({
      dictionary: {
        provider: 'oxford',
        oxfordAppId: 'oxid',
        oxfordAppKey: 'oxkey',
        oxfordApiBase: `${base}/oxford`,
        oxfordLanguage: 'en-gb',
      },
    });
    const cookie = await server.login('Reader');
    const result = (await (await server.fetch('/api/dictionary?word=Ran', cookie)).json()) as DictionaryResult;
    expect(result.entry).toMatchObject({
      word: 'run',
      phonetic: '/rʌn/',
      source: 'oxford',
      sourceLabel: 'Oxford Dictionaries',
      senses: [{ partOfSpeech: 'verb', definitions: [{ text: 'move at a speed faster than a walk' }] }],
    });
    expect(calls.some((c) => c.startsWith('oxid /oxford/lemmas/en-gb/ran'))).toBe(true);
  });

  it('reports when look-ups are switched off', async () => {
    server = await startServer({ dictionary: { provider: null } });
    const cookie = await server.login('Reader');
    const result = (await (await server.fetch('/api/dictionary?word=hello', cookie)).json()) as DictionaryResult;
    expect(result.entry).toBeNull();
    expect(result.oxfordUrl).toContain('q=hello');
  });
});
