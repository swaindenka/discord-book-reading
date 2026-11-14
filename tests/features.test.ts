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
      // Wiktionary REST API format
      if (url === '/wiktionary/frobnicate') {
        if (!String(req.headers['user-agent']).includes('ReadingRoom')) return send(403, {});
        return send(200, {
          en: [
            {
              partOfSpeech: 'Verb',
              language: 'English',
              definitions: [
                {
                  definition: 'To <a href="/wiki/tweak">tweak</a> or adjust, often pointlessly.',
                  parsedExamples: [{ example: 'He <b>frobnicated</b> the knobs.' }],
                },
              ],
            },
          ],
        });
      }
      if (url === '/wiktionary/glitchword') return send(503, {});
      if (url.startsWith('/wiktionary/')) return send(404, {});
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

  const define = async (s: TestServer, cookie: string, word: string) => {
    const res = await s.fetch(`/api/dictionary?word=${encodeURIComponent(word)}`, cookie);
    return { status: res.status, body: (await res.json()) as DictionaryResult };
  };

  it('answers from the built-in WordNet dictionary, including inflected forms', async () => {
    server = await startServer({ dictionary: { mode: 'offline' } });
    const cookie = await server.login('Reader');
    expect((await (await server.fetch('/api/config', cookie)).json()).dictionary).toBe('builtin');

    const lighthouse = await define(server, cookie, '“Lighthouses,”');
    expect(lighthouse.body.query).toBe('lighthouses');
    expect(lighthouse.body.oxfordUrl).toBe('https://www.oxfordlearnersdictionaries.com/search/english/?q=lighthouses');
    expect(lighthouse.body.entry).toMatchObject({ word: 'lighthouse', source: 'wordnet', senses: [{ partOfSpeech: 'noun' }] });
    expect(lighthouse.body.entry!.senses[0].definitions[0].text).toMatch(/tower with a light/);

    for (const [form, lemma, pos] of [
      ['ran', 'run', 'verb'],
      ['mice', 'mouse', 'noun'],
      ['freshening', 'freshen', 'verb'],
      ['look up', 'look up', 'verb'],
    ]) {
      const { body } = await define(server, cookie, form);
      expect(body.entry?.word).toBe(lemma);
      expect(body.entry?.senses.map((x) => x.partOfSpeech)).toContain(pos);
    }

    expect((await define(server, cookie, 'xyzzyq')).body.entry).toBeNull();
    expect((await define(server, cookie, '1234')).status).toBe(400);
    expect((await define(server, cookie, 'he11o')).status).toBe(400);
    expect((await define(server, cookie, 'one two three four five')).status).toBe(400);
    expect((await fetch(`${server.base}/api/dictionary?word=hello`)).status).toBe(401);
    expect(calls).toHaveLength(0); // never went online
  });

  it('asks Wiktionary for words WordNet lacks, caches the answer and survives outages', async () => {
    server = await startServer({ dictionary: { mode: 'builtin', wiktionaryApiBase: `${base}/wiktionary` } });
    const cookie = await server.login('Reader');

    const rare = await define(server, cookie, 'frobnicate');
    expect(rare.body.entry).toEqual({
      word: 'frobnicate',
      senses: [
        { partOfSpeech: 'verb', definitions: [{ text: 'To tweak or adjust, often pointlessly.', example: 'He frobnicated the knobs.' }] },
      ],
      source: 'wiktionary',
      sourceLabel: 'Wiktionary',
    });
    const before = calls.length;
    await define(server, cookie, 'frobnicate');
    expect(calls.length).toBe(before); // cached

    // Common words never need the network.
    expect((await define(server, cookie, 'breakwater')).body.entry?.source).toBe('wordnet');
    expect(calls.length).toBe(before);

    // A failing online service doesn't turn into an error for the reader.
    const outage = await define(server, cookie, 'glitchword');
    expect(outage.status).toBe(200);
    expect(outage.body.entry).toBeNull();
  });

  it('prefers Oxford when keys are set and falls back to WordNet when Oxford fails', async () => {
    const oxford = { oxfordAppId: 'oxid', oxfordAppKey: 'oxkey', oxfordApiBase: `${base}/oxford`, oxfordLanguage: 'en-gb' };
    server = await startServer({ dictionary: { mode: 'auto', ...oxford, wiktionaryApiBase: `${base}/wiktionary` } });
    let cookie = await server.login('Reader');
    expect((await (await server.fetch('/api/config', cookie)).json()).dictionary).toBe('oxford');
    const ran = await define(server, cookie, 'Ran');
    expect(ran.body.entry).toMatchObject({
      word: 'run',
      phonetic: '/rʌn/',
      source: 'oxford',
      senses: [{ partOfSpeech: 'verb', definitions: [{ text: 'move at a speed faster than a walk' }] }],
    });
    expect(calls.some((c) => c.startsWith('oxid /oxford/lemmas/en-gb/ran'))).toBe(true);
    await server.close();

    // Wrong keys: Oxford answers 403, the built-in dictionary takes over.
    server = await startServer({ dictionary: { mode: 'auto', ...oxford, oxfordAppKey: 'wrong', wiktionaryApiBase: `${base}/wiktionary` } });
    cookie = await server.login('Reader');
    expect((await define(server, cookie, 'lighthouse')).body.entry?.source).toBe('wordnet');
  });

  it('reports when look-ups are switched off', async () => {
    server = await startServer({ dictionary: { mode: 'off' } });
    const cookie = await server.login('Reader');
    expect((await (await server.fetch('/api/config', cookie)).json()).dictionary).toBeNull();
    const { body } = await define(server, cookie, 'hello');
    expect(body.entry).toBeNull();
    expect(body.oxfordUrl).toContain('q=hello');
  });
});
