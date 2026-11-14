import { randomBytes } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import type { Database, BookRecord, RoomRecord, UserRecord } from './db.js';
import type { UserCache } from './auth.js';
import type { BookStorage } from './storage.js';
import * as turns from './turns.js';
import {
  DEFAULT_ROOM_SETTINGS,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_LIMITS,
  LIMITS,
  type BookFormat,
  type BookHighlight,
  type ChatMessage,
  type HighlightAnchor,
  type HighlightColor,
  type ClientToServerEvents,
  type MemberInfo,
  type MemberRole,
  type ModAction,
  type Position,
  type RoomSettings,
  type RoomState,
  type RoomSummary,
  type ServerToClientEvents,
} from '../shared/types.js';

export interface SocketData {
  user: UserRecord;
  roomId: string | null;
}

export type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** An error whose message is safe to show to the user. */
export class UserError extends Error {}

export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');

export function newRoomId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const channel = (roomId: string) => `room:${roomId}`;

const RANK: Record<MemberRole, number> = { member: 1, mod: 2, owner: 3, admin: 4 };
const UNLOAD_AFTER_MS = 10 * 60_000;
const CHAT_WINDOW_MS = 10_000;
const CHAT_MAX_IN_WINDOW = 8;
const KEEP_MESSAGES = 500;

export function validatePosition(value: unknown): Position | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (p.kind === 'page') {
    const page = Number(p.page);
    if (!Number.isInteger(page) || page < 1 || page > 1_000_000) return null;
    const scroll = p.scroll === undefined ? undefined : Number(p.scroll);
    if (scroll !== undefined && !(scroll >= 0 && scroll <= 1)) return null;
    return scroll === undefined ? { kind: 'page', page } : { kind: 'page', page, scroll: Math.round(scroll * 10000) / 10000 };
  }
  if (p.kind === 'cfi') {
    if (typeof p.cfi !== 'string' || !p.cfi.startsWith('epubcfi(') || p.cfi.length > 1000) return null;
    const out: Position = { kind: 'cfi', cfi: p.cfi };
    const percent = Number(p.percent);
    if (p.percent !== undefined && percent >= 0 && percent <= 100) out.percent = Math.round(percent * 10) / 10;
    if (typeof p.label === 'string' && p.label.trim()) out.label = p.label.trim().slice(0, 200);
    return out;
  }
  return null;
}

const unit = (n: number) => Number.isFinite(n) && n >= -0.001 && n <= 1.001;
const round4 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;

/** Checks a highlight anchor sent by a client against the book's format. */
export function validateAnchor(value: unknown, format: BookFormat): HighlightAnchor | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  const page = Number(a.page);
  const validPage = Number.isInteger(page) && page >= 1 && page <= 1_000_000;
  if (format === 'epub') {
    if (a.kind !== 'cfi' || typeof a.cfiRange !== 'string' || !a.cfiRange.startsWith('epubcfi(') || a.cfiRange.length > 2000) {
      return null;
    }
    return { kind: 'cfi', cfiRange: a.cfiRange };
  }
  if (format === 'pdf' || format === 'cbz') {
    if (a.kind !== 'rects' || !validPage || !Array.isArray(a.rects)) return null;
    if (a.rects.length === 0 || a.rects.length > HIGHLIGHT_LIMITS.rects) return null;
    const rects: [number, number, number, number][] = [];
    for (const r of a.rects) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === 'number' && unit(n))) return null;
      const [x, y, w, h] = r.map(round4);
      if (w <= 0 || h <= 0) return null;
      rects.push([x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)]);
    }
    return { kind: 'rects', page, rects };
  }
  const start = Number(a.start);
  const end = Number(a.end);
  if (a.kind !== 'text' || !validPage || !Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start || end - start > 50_000) return null;
  return { kind: 'text', page, start, end };
}

function describeProgress(start: Position | null, end: Position | null): string {
  if (!end) return '';
  if (end.kind === 'page' && (!start || start.kind === 'page')) {
    const from = start?.page ?? end.page;
    return from === end.page ? ` (page ${end.page})` : ` (pages ${Math.min(from, end.page)}–${Math.max(from, end.page)})`;
  }
  if (end.kind === 'cfi' && end.percent !== undefined) {
    const from = start?.kind === 'cfi' ? start.percent : undefined;
    return from !== undefined && Math.round(from) !== Math.round(end.percent)
      ? ` (${Math.round(from)}% → ${Math.round(end.percent)}%)`
      : ` (at ${Math.round(end.percent)}%)`;
  }
  return '';
}

interface RoomContext {
  io: IO;
  db: Database;
  users: UserCache;
  storage: BookStorage;
  onUnload: (roomId: string) => void;
}

export class LiveRoom {
  readonly turns: turns.TurnState;
  readonly moderators: Set<string>;
  readonly banned: Set<string>;
  /** userId -> that user's sockets in this room (one per tab/browser). */
  readonly presence = new Map<string, Map<string, AppSocket>>();
  private graceTimer: NodeJS.Timeout | null = null;
  private graceFor: string | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private positionTimer: NodeJS.Timeout | null = null;
  private unloadTimer: NodeJS.Timeout | null = null;
  private turnStartPosition: Position | null = null;
  private chatLog = new Map<string, number[]>();
  /** Highlights per book, loaded on first use. */
  private highlightCache = new Map<string, BookHighlight[]>();
  private messageCount = 0;
  deleted = false;

  constructor(
    readonly record: RoomRecord,
    public books: BookRecord[],
    private readonly ctx: RoomContext,
  ) {
    this.turns = {
      queue: [...record.state.queue],
      reader: record.state.reader,
      turnStartedAt: record.state.turnStartedAt,
    };
    this.moderators = new Set(record.state.moderators);
    this.banned = new Set(record.state.banned);
  }

  get id() {
    return this.record.id;
  }

  get settings() {
    return this.record.settings;
  }

  get activeBook(): BookRecord | null {
    return this.books.find((b) => b.id === this.record.activeBookId) ?? null;
  }

  get position(): Position | null {
    return this.activeBook?.position ?? null;
  }

  isOnline = (userId: string) => this.presence.has(userId);

  roleOf(userId: string): MemberRole {
    if (this.ctx.users.peek(userId)?.isAdmin) return 'admin';
    if (userId === this.record.ownerId) return 'owner';
    if (this.moderators.has(userId)) return 'mod';
    return 'member';
  }

  isMod(userId: string) {
    return RANK[this.roleOf(userId)] >= RANK.mod;
  }

  private name(userId: string) {
    return this.ctx.users.peek(userId)?.displayName ?? 'Someone';
  }

  private member(userId: string): MemberInfo {
    const user = this.ctx.users.peek(userId);
    return {
      id: userId,
      name: user?.displayName ?? 'Unknown reader',
      avatarUrl: user?.avatarUrl ?? null,
      online: this.isOnline(userId),
      role: this.roleOf(userId),
    };
  }

  snapshot(): RoomState {
    const { record } = this;
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      ownerId: record.ownerId,
      settings: { ...record.settings },
      members: [...this.presence.keys()].map((id) => this.member(id)),
      queue: this.turns.queue.map((id) => this.member(id)),
      reader: this.turns.reader
        ? { ...this.member(this.turns.reader), since: this.turns.turnStartedAt ?? Date.now() }
        : null,
      moderators: [...this.moderators],
      banned: [...this.banned].map((id) => ({ id, name: this.name(id) })),
      books: this.books.map((b) => ({
        id: b.id,
        title: b.title,
        author: b.author,
        format: b.format,
        size: b.size,
        uploadedBy: b.uploadedBy,
        uploadedByName: this.name(b.uploadedBy),
        createdAt: b.createdAt,
        position: b.position,
      })),
      activeBookId: record.activeBookId,
      position: this.position,
      serverTime: Date.now(),
    };
  }

  summary(): RoomSummary {
    const book = this.activeBook;
    return {
      id: this.id,
      name: this.record.name,
      description: this.record.description,
      ownerName: this.name(this.record.ownerId),
      bookTitle: book?.title ?? null,
      bookAuthor: book?.author ?? null,
      bookFormat: book?.format ?? null,
      bookPosition: book?.position ?? null,
      bookCount: this.books.length,
      online: [...this.presence.keys()].slice(0, 8).map((id) => {
        const user = this.ctx.users.peek(id);
        return { name: user?.displayName ?? 'Reader', avatarUrl: user?.avatarUrl ?? null };
      }),
      readerName: this.turns.reader ? this.name(this.turns.reader) : null,
      queueLength: this.turns.queue.length,
      createdAt: this.record.createdAt,
    };
  }

  // ---- broadcasting & persistence --------------------------------------------

  broadcast() {
    if (this.deleted) return;
    this.ctx.io.to(channel(this.id)).emit('room:state', this.snapshot());
  }

  private changed() {
    this.checkReaderPresence();
    this.scheduleSave();
    this.broadcast();
  }

  private scheduleSave() {
    if (this.saveTimer || this.deleted) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 300);
  }

  async save() {
    if (this.deleted) return;
    this.record.state = {
      queue: [...this.turns.queue],
      reader: this.turns.reader,
      turnStartedAt: this.turns.turnStartedAt,
      moderators: [...this.moderators],
      banned: [...this.banned],
    };
    this.record.updatedAt = Date.now();
    try {
      await this.ctx.db.saveRoom(this.record);
    } catch (err) {
      console.error(`[room ${this.id}] save failed`, err);
    }
  }

  private schedulePositionSave(book: BookRecord) {
    if (this.positionTimer) clearTimeout(this.positionTimer);
    this.positionTimer = setTimeout(() => {
      this.positionTimer = null;
      this.ctx.db.saveBookPosition(book.id, book.position).catch((err) => console.error('[room] position save failed', err));
    }, 1500);
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.save();
    }
    if (this.positionTimer) {
      clearTimeout(this.positionTimer);
      this.positionTimer = null;
      const book = this.activeBook;
      if (book) await this.ctx.db.saveBookPosition(book.id, book.position).catch(() => {});
    }
  }

  async systemMessage(body: string) {
    const message: ChatMessage = {
      id: newId(),
      kind: 'system',
      userId: null,
      authorName: 'System',
      authorAvatar: null,
      body,
      createdAt: Date.now(),
    };
    await this.storeMessage(message);
  }

  private async storeMessage(message: ChatMessage) {
    this.ctx.io.to(channel(this.id)).emit('chat:message', message);
    try {
      await this.ctx.db.addMessage(this.id, message);
      if (++this.messageCount % 50 === 0) await this.ctx.db.pruneMessages(this.id, KEEP_MESSAGES);
    } catch (err) {
      console.error(`[room ${this.id}] message save failed`, err);
    }
  }

  // ---- presence ------------------------------------------------------------

  async join(socket: AppSocket) {
    const user = socket.data.user;
    if (this.banned.has(user.id) && !user.isAdmin) throw new UserError('You are banned from this room.');
    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer);
      this.unloadTimer = null;
    }
    await socket.join(channel(this.id));
    socket.data.roomId = this.id;
    let sockets = this.presence.get(user.id);
    const cameOnline = !sockets;
    if (!sockets) {
      sockets = new Map();
      this.presence.set(user.id, sockets);
    }
    sockets.set(socket.id, socket);
    if (cameOnline) this.changed();
  }

  leave(socket: AppSocket) {
    const userId = socket.data.user.id;
    void socket.leave(channel(this.id));
    if (socket.data.roomId === this.id) socket.data.roomId = null;
    const sockets = this.presence.get(userId);
    if (!sockets?.delete(socket.id)) return;
    if (sockets.size === 0) {
      this.presence.delete(userId);
      this.changed();
    }
    if (this.presence.size === 0) this.scheduleUnload();
  }

  /** Drops the room from memory after a while if nobody is in it. */
  scheduleUnload() {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      if (this.presence.size > 0) return;
      void this.flush().then(() => {
        this.clearTimers();
        this.ctx.onUnload(this.id);
      });
    }, UNLOAD_AFTER_MS);
    this.unloadTimer.unref();
  }

  private clearTimers() {
    for (const timer of [this.graceTimer, this.saveTimer, this.positionTimer, this.unloadTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.graceTimer = this.saveTimer = this.positionTimer = this.unloadTimer = null;
    this.graceFor = null;
  }

  /** Skips a reader who stays disconnected for longer than the grace period. */
  private checkReaderPresence() {
    const reader = this.turns.reader;
    const shouldWait = Boolean(reader && this.settings.autoSkipOffline && !this.isOnline(reader));
    if (!shouldWait) {
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = null;
      this.graceFor = null;
      return;
    }
    if (this.graceTimer && this.graceFor === reader) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceFor = reader;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.graceFor = null;
      if (this.deleted || this.turns.reader !== reader || this.isOnline(reader!)) return;
      void this.advanceTurn('disconnected');
    }, this.settings.offlineGraceSeconds * 1000);
    this.graceTimer.unref();
  }

  // ---- turns ---------------------------------------------------------------

  private beginTurn(next: string | null) {
    if (next) this.turnStartPosition = this.position;
  }

  private async advanceTurn(reason: 'finished' | 'passed' | 'skipped' | 'disconnected', actor?: UserRecord) {
    const endPosition = this.position;
    const { previous, next } = turns.advance(this.turns, {
      rotate: this.settings.rotate,
      isOnline: this.isOnline,
      now: Date.now(),
    });
    if (!previous) return;
    const progress = reason === 'finished' ? describeProgress(this.turnStartPosition, endPosition) : '';
    this.beginTurn(next);
    this.changed();
    const who = this.name(previous);
    const head = {
      finished: `${who} finished their turn${progress}.`,
      passed: `${who} passed.`,
      skipped: `${actor ? this.name(actor.id) : 'A moderator'} skipped ${who}.`,
      disconnected: `${who} was skipped (disconnected).`,
    }[reason];
    await this.systemMessage(next ? `${head} ${this.name(next)} is reading now.` : `${head} Nobody is reading right now.`);
  }

  private async tryAutoStart() {
    if (this.turns.reader) return;
    const next = turns.startNext(this.turns, this.isOnline, Date.now());
    if (!next) return;
    this.beginTurn(next);
    await this.systemMessage(`${this.name(next)} is reading now.`);
  }

  async queueJoin(user: UserRecord) {
    if (this.settings.queueLocked && !this.isMod(user.id)) {
      throw new UserError('The queue is locked. Ask a moderator to add you.');
    }
    if (!turns.enqueue(this.turns, user.id)) throw new UserError('You are already in the queue.');
    await this.tryAutoStart();
    this.changed();
  }

  queueLeave(user: UserRecord) {
    if (!turns.dequeue(this.turns, user.id)) throw new UserError('You are not in the queue.');
    this.changed();
  }

  async turnStart(user: UserRecord) {
    if (this.turns.reader) throw new UserError('Someone is already reading.');
    const first = this.turns.queue.find(this.isOnline);
    if (!this.isMod(user.id) && first !== user.id) throw new UserError('Only the first person in line can start.');
    await this.tryAutoStart();
    this.changed();
  }

  async turnEnd(user: UserRecord, reason: 'finished' | 'passed') {
    if (this.turns.reader !== user.id) throw new UserError('It is not your turn.');
    await this.advanceTurn(reason);
  }

  // ---- reading position & live cues ----------------------------------------

  canControl(userId: string) {
    return this.turns.reader === userId || this.isMod(userId);
  }

  navigate(user: UserRecord, bookId: string, position: unknown): Position {
    if (!this.canControl(user.id)) throw new UserError('Only the current reader can turn pages.');
    const book = this.activeBook;
    if (!book || book.id !== bookId) throw new UserError('That book is not open in this room.');
    const valid = validatePosition(position);
    if (!valid) throw new UserError('Invalid position.');
    if ((valid.kind === 'cfi') !== (book.format === 'epub')) throw new UserError('Invalid position for this book.');
    book.position = valid;
    this.schedulePositionSave(book);
    return valid;
  }

  // ---- highlights (moderators) --------------------------------------------------

  async highlightsFor(bookId: string | null | undefined): Promise<BookHighlight[]> {
    if (!bookId) return [];
    let list = this.highlightCache.get(bookId);
    if (!list) {
      list = await this.ctx.db.listHighlights(bookId);
      this.highlightCache.set(bookId, list);
    }
    return list;
  }

  private async announceHighlights() {
    const bookId = this.record.activeBookId;
    if (!bookId) return;
    this.ctx.io.to(channel(this.id)).emit('highlights:set', { bookId, highlights: await this.highlightsFor(bookId) });
  }

  async addHighlight(user: UserRecord, payload: Record<string, unknown> | undefined): Promise<BookHighlight> {
    if (!this.isMod(user.id)) throw new UserError('Only moderators can highlight.');
    const book = this.activeBook;
    if (!book || book.id !== payload?.bookId) throw new UserError('That book is not open in this room.');
    const color = String(payload.color) as HighlightColor;
    if (!(color in HIGHLIGHT_COLORS)) throw new UserError('Unknown highlight colour.');
    const anchor = validateAnchor(payload.anchor, book.format);
    if (!anchor) throw new UserError('Invalid highlight.');
    const list = await this.highlightsFor(book.id);
    if (list.length >= HIGHLIGHT_LIMITS.perBook) throw new UserError('This book has too many highlights already.');
    const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
    const highlight: BookHighlight = {
      id: newId(),
      bookId: book.id,
      color,
      anchor,
      text: clean(payload.text, HIGHLIGHT_LIMITS.text),
      label: clean(payload.label, 120) || (anchor.kind === 'cfi' ? '' : `Page ${anchor.page}`),
      createdBy: user.id,
      createdByName: user.displayName,
      createdAt: Date.now(),
    };
    await this.ctx.db.addHighlight(this.id, highlight);
    list.push(highlight);
    this.ctx.io.to(channel(this.id)).emit('highlight:added', highlight);
    return highlight;
  }

  async removeHighlight(user: UserRecord, id: unknown) {
    if (!this.isMod(user.id)) throw new UserError('Only moderators can remove highlights.');
    for (const [bookId, list] of this.highlightCache) {
      const index = list.findIndex((h) => h.id === id);
      if (index < 0) continue;
      await this.ctx.db.deleteHighlight(list[index].id);
      list.splice(index, 1);
      this.ctx.io.to(channel(this.id)).emit('highlight:removed', { id: String(id), bookId });
      return;
    }
    throw new UserError('That highlight no longer exists.');
  }

  // ---- chat ----------------------------------------------------------------

  async chat(user: UserRecord, rawBody: unknown) {
    const body = typeof rawBody === 'string' ? rawBody.replace(/\r\n/g, '\n').trim() : '';
    if (!body) throw new UserError('Message is empty.');
    if (body.length > LIMITS.chatMessage) throw new UserError(`Messages can be up to ${LIMITS.chatMessage} characters.`);
    const now = Date.now();
    const recent = (this.chatLog.get(user.id) ?? []).filter((t) => now - t < CHAT_WINDOW_MS);
    if (recent.length >= CHAT_MAX_IN_WINDOW) throw new UserError('Slow down a little.');
    recent.push(now);
    this.chatLog.set(user.id, recent);
    await this.storeMessage({
      id: newId(),
      kind: 'user',
      userId: user.id,
      authorName: user.displayName,
      authorAvatar: user.avatarUrl,
      body,
      createdAt: now,
    });
  }

  async deleteMessage(user: UserRecord, messageId: unknown) {
    if (typeof messageId !== 'string') throw new UserError('Unknown message.');
    const message = await this.ctx.db.getMessage(messageId);
    if (!message || message.roomId !== this.id) throw new UserError('Unknown message.');
    if (message.userId !== user.id && !this.isMod(user.id)) throw new UserError('You can only delete your own messages.');
    await this.ctx.db.deleteMessage(messageId);
    this.ctx.io.to(channel(this.id)).emit('chat:deleted', { id: messageId });
  }

  // ---- books ---------------------------------------------------------------

  async addBook(book: BookRecord, uploader: UserRecord) {
    this.books.push(book);
    const activate = !this.record.activeBookId;
    if (activate) this.record.activeBookId = book.id;
    this.changed();
    await this.systemMessage(
      activate
        ? `${uploader.displayName} opened “${book.title}”.`
        : `${uploader.displayName} added “${book.title}” to the library.`,
    );
  }

  async removeBook(user: UserRecord, bookId: string) {
    if (!this.isMod(user.id)) throw new UserError('Only moderators can remove books.');
    const book = this.books.find((b) => b.id === bookId);
    if (!book) throw new UserError('Unknown book.');
    this.books = this.books.filter((b) => b.id !== bookId);
    if (this.record.activeBookId === bookId) this.record.activeBookId = this.books.at(-1)?.id ?? null;
    await this.ctx.db.deleteBook(bookId);
    this.highlightCache.delete(bookId);
    await this.ctx.storage.remove(book.storageKey).catch((err) => console.error('[room] file removal failed', err));
    this.changed();
    await this.announceHighlights();
    await this.systemMessage(`${user.displayName} removed “${book.title}”.`);
  }

  // ---- moderation ----------------------------------------------------------

  private assertCanTarget(actor: UserRecord, targetId: string) {
    if (actor.id === targetId) throw new UserError('You cannot do that to yourself.');
    if (RANK[this.roleOf(actor.id)] <= RANK[this.roleOf(targetId)]) {
      throw new UserError('You cannot moderate someone with the same or a higher role.');
    }
  }

  private disconnectUser(userId: string, banned: boolean) {
    const sockets = this.presence.get(userId);
    if (!sockets) return;
    for (const socket of [...sockets.values()]) {
      socket.emit('room:kicked', { banned });
      this.leave(socket);
    }
  }

  async moderate(actor: UserRecord, action: ModAction) {
    if (!this.isMod(actor.id)) throw new UserError('Only moderators can do that.');
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') throw new UserError('Unknown action.');
    const now = Date.now();
    const s = this.turns;
    const targetId = 'userId' in action && typeof action.userId === 'string' ? action.userId : '';

    switch (action.type) {
      case 'queue.move':
        turns.moveInQueue(s, targetId, Number(action.index) || 0);
        break;
      case 'queue.remove':
        if (!turns.dequeue(s, targetId)) throw new UserError('That person is not in the queue.');
        break;
      case 'queue.add':
        if (!this.isOnline(targetId)) throw new UserError('That person is not in the room.');
        if (!turns.enqueue(s, targetId)) throw new UserError('That person is already in the queue.');
        await this.tryAutoStart();
        break;
      case 'queue.shuffle':
        turns.shuffleQueue(s);
        await this.systemMessage(`${actor.displayName} shuffled the queue.`);
        break;
      case 'queue.clear':
        s.queue.length = 0;
        await this.systemMessage(`${actor.displayName} cleared the queue.`);
        break;
      case 'reader.set': {
        if (!this.isOnline(targetId) && !s.queue.includes(targetId)) throw new UserError('That person is not here.');
        if (s.reader === targetId) throw new UserError('They are already reading.');
        turns.setReader(s, targetId, { rotate: this.settings.rotate, now });
        this.beginTurn(targetId);
        await this.systemMessage(`${actor.displayName} handed the turn to ${this.name(targetId)}.`);
        break;
      }
      case 'reader.skip':
        if (!s.reader) throw new UserError('Nobody is reading.');
        await this.advanceTurn('skipped', actor);
        return;
      case 'reader.stop': {
        const previous = turns.endTurn(s, 'front');
        if (!previous) throw new UserError('Nobody is reading.');
        await this.systemMessage(`${actor.displayName} paused ${this.name(previous)}'s turn.`);
        break;
      }
      case 'settings':
        this.applySettings(action.settings);
        break;
      case 'room.update': {
        if (typeof action.name === 'string') {
          const name = action.name.trim().slice(0, LIMITS.roomName);
          if (!name) throw new UserError('The room needs a name.');
          this.record.name = name;
        }
        if (typeof action.description === 'string') {
          this.record.description = action.description.trim().slice(0, LIMITS.roomDescription);
        }
        break;
      }
      case 'mod.grant':
      case 'mod.revoke': {
        const role = this.roleOf(actor.id);
        if (role !== 'owner' && role !== 'admin') throw new UserError('Only the room owner can change moderators.');
        if (!this.ctx.users.peek(targetId)) throw new UserError('Unknown person.');
        if (action.type === 'mod.grant') {
          if (this.moderators.has(targetId)) throw new UserError('Already a moderator.');
          this.moderators.add(targetId);
          await this.systemMessage(`${this.name(targetId)} is now a moderator.`);
        } else {
          if (!this.moderators.delete(targetId)) throw new UserError('Not a moderator.');
          await this.systemMessage(`${this.name(targetId)} is no longer a moderator.`);
        }
        break;
      }
      case 'member.kick':
      case 'member.ban': {
        this.assertCanTarget(actor, targetId);
        const banned = action.type === 'member.ban';
        if (banned) {
          this.banned.add(targetId);
          this.moderators.delete(targetId);
        }
        const { wasReader, next } = turns.removeUser(s, targetId, { isOnline: this.isOnline, now });
        if (wasReader) this.beginTurn(next);
        this.disconnectUser(targetId, banned);
        await this.systemMessage(
          `${this.name(targetId)} was ${banned ? 'banned' : 'removed'} by ${actor.displayName}.` +
            (wasReader && next ? ` ${this.name(next)} is reading now.` : ''),
        );
        break;
      }
      case 'member.unban':
        if (!this.banned.delete(targetId)) throw new UserError('That person is not banned.');
        break;
      case 'book.update': {
        const book = this.books.find((b) => b.id === action.bookId);
        if (!book) throw new UserError('Unknown book.');
        const title = typeof action.title === 'string' ? action.title.replace(/\s+/g, ' ').trim().slice(0, LIMITS.bookTitle) : '';
        if (!title) throw new UserError('The book needs a title.');
        const author =
          typeof action.author === 'string' ? action.author.replace(/\s+/g, ' ').trim().slice(0, LIMITS.bookAuthor) || null : null;
        book.title = title;
        book.author = author;
        await this.ctx.db.updateBookDetails(book.id, title, author);
        break;
      }
      case 'book.activate': {
        const book = this.books.find((b) => b.id === action.bookId);
        if (!book) throw new UserError('Unknown book.');
        if (this.record.activeBookId === book.id) break;
        await this.flush();
        this.record.activeBookId = book.id;
        this.turnStartPosition = book.position;
        await this.announceHighlights();
        await this.systemMessage(`${actor.displayName} switched the book to “${book.title}”.`);
        break;
      }
      default:
        throw new UserError('Unknown action.');
    }
    this.changed();
  }

  private applySettings(input: Partial<RoomSettings> | undefined) {
    if (!input || typeof input !== 'object') throw new UserError('Invalid settings.');
    const next = { ...this.settings };
    for (const key of ['rotate', 'queueLocked', 'autoSkipOffline'] as const) {
      if (typeof input[key] === 'boolean') next[key] = input[key];
    }
    if (input.turnMinutes !== undefined) {
      const minutes = Number(input.turnMinutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 180) {
        throw new UserError('Turn length must be between 0 (no limit) and 180 minutes.');
      }
      next.turnMinutes = minutes;
    }
    if (input.offlineGraceSeconds !== undefined) {
      const seconds = Number(input.offlineGraceSeconds);
      if (!Number.isFinite(seconds) || seconds < 10 || seconds > 3600) {
        throw new UserError('Grace period must be between 10 seconds and an hour.');
      }
      next.offlineGraceSeconds = Math.round(seconds);
      if (this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
        this.graceFor = null;
      }
    }
    this.record.settings = next;
  }

  async destroy() {
    this.deleted = true;
    this.clearTimers();
    this.ctx.io.to(channel(this.id)).emit('room:deleted');
    for (const sockets of this.presence.values()) {
      for (const socket of sockets.values()) {
        void socket.leave(channel(this.id));
        socket.data.roomId = null;
      }
    }
    this.presence.clear();
    for (const book of this.books) {
      await this.ctx.storage.remove(book.storageKey).catch(() => {});
    }
    await this.ctx.db.deleteRoom(this.id);
  }
}

export class RoomManager {
  private live = new Map<string, LiveRoom>();
  private loading = new Map<string, Promise<LiveRoom | null>>();

  constructor(private readonly ctx: Omit<RoomContext, 'onUnload'>) {}

  private context(): RoomContext {
    return { ...this.ctx, onUnload: (id) => this.live.delete(id) };
  }

  /** Returns the live room, loading it from the database if needed. */
  get(roomId: string): Promise<LiveRoom | null> {
    const room = this.live.get(roomId);
    if (room) return Promise.resolve(room);
    let pending = this.loading.get(roomId);
    if (!pending) {
      pending = this.load(roomId).finally(() => this.loading.delete(roomId));
      this.loading.set(roomId, pending);
    }
    return pending;
  }

  private async load(roomId: string) {
    const record = await this.ctx.db.getRoom(roomId);
    if (!record) return null;
    const books = await this.ctx.db.listBooks(roomId);
    await this.ctx.users.preload([
      record.ownerId,
      ...record.state.queue,
      ...(record.state.reader ? [record.state.reader] : []),
      ...record.state.moderators,
      ...record.state.banned,
      ...books.map((b) => b.uploadedBy),
    ]);
    const room = new LiveRoom(record, books, this.context());
    this.live.set(roomId, room);
    room.scheduleUnload();
    return room;
  }

  async create(owner: UserRecord, name: string, description: string): Promise<LiveRoom> {
    const now = Date.now();
    const record: RoomRecord = {
      id: newRoomId(),
      name,
      description,
      ownerId: owner.id,
      activeBookId: null,
      settings: { ...DEFAULT_ROOM_SETTINGS },
      state: { queue: [], reader: null, turnStartedAt: null, moderators: [], banned: [] },
      createdAt: now,
      updatedAt: now,
    };
    await this.ctx.db.createRoom(record);
    const room = new LiveRoom(record, [], this.context());
    this.live.set(record.id, room);
    room.scheduleUnload();
    return room;
  }

  async delete(room: LiveRoom) {
    this.live.delete(room.id);
    await room.destroy();
  }

  async summaries(): Promise<RoomSummary[]> {
    const rows = await this.ctx.db.listRooms();
    const out: RoomSummary[] = [];
    for (const row of rows) {
      const live = this.live.get(row.id);
      if (live) {
        out.push(live.summary());
        continue;
      }
      out.push({
        id: row.id,
        name: row.name,
        description: row.description,
        ownerName: row.ownerName ?? 'Someone',
        bookTitle: row.bookTitle,
        bookAuthor: row.bookAuthor,
        bookFormat: row.bookFormat,
        bookPosition: row.bookPosition,
        bookCount: row.bookCount,
        online: [],
        readerName: null,
        queueLength: row.state.queue.length,
        createdAt: row.createdAt,
      });
    }
    // Rooms with people in them first.
    return out.sort((a, b) => b.online.length - a.online.length);
  }

  /** Re-sends every live room's state, e.g. after site admins change. */
  broadcastAll() {
    for (const room of this.live.values()) room.broadcast();
  }

  async flushAll() {
    await Promise.all([...this.live.values()].map((room) => room.flush()));
  }
}
