import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient, type Client, type InValue, type Row } from '@libsql/client';
import type {
  BookFormat,
  BookHighlight,
  ChatMessage,
  HighlightAnchor,
  HighlightColor,
  Position,
  RoomSettings,
} from '../shared/types.js';
import { DEFAULT_ROOM_SETTINGS, LIMITS } from '../shared/types.js';
import { looksLikeRawFilename, parseBookFilename } from '../shared/bookname.js';

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Admin through a Discord role (DISCORD_ADMIN_ROLE_IDS), checked at sign-in. */
  roleAdmin: boolean;
  /** Effective site-admin flag; kept up to date by UserCache. */
  isAdmin: boolean;
}

export interface SiteAdminRecord {
  userId: string;
  addedBy: string;
  createdAt: number;
}

export interface PersistedTurnState {
  queue: string[];
  reader: string | null;
  turnStartedAt: number | null;
  moderators: string[];
  banned: string[];
}

export interface RoomRecord {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  activeBookId: string | null;
  settings: RoomSettings;
  state: PersistedTurnState;
  createdAt: number;
  updatedAt: number;
}

export interface BookRecord {
  id: string;
  roomId: string;
  title: string;
  author: string | null;
  format: BookFormat;
  storageKey: string;
  size: number;
  uploadedBy: string;
  position: Position | null;
  createdAt: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id TEXT NOT NULL,
    active_book_id TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    title TEXT NOT NULL,
    format TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL,
    position TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_books_room ON books(room_id)`,
  `CREATE TABLE IF NOT EXISTS book_chunks (
    storage_key TEXT NOT NULL,
    idx INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (storage_key, idx)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    user_id TEXT,
    author_name TEXT NOT NULL,
    author_avatar TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS site_admins (
    user_id TEXT PRIMARY KEY,
    added_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    color TEXT NOT NULL,
    anchor TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS dictionary_cache (
    key TEXT PRIMARY KEY,
    data TEXT,
    fetched_at INTEGER NOT NULL
  )`,
];

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => Number(v ?? 0);

function rowToUser(row: Row): UserRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    avatarUrl: str(row.avatar_url),
    roleAdmin: num(row.is_admin) === 1,
    isAdmin: num(row.is_admin) === 1,
  };
}

function rowToHighlight(row: Row): BookHighlight {
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    color: String(row.color) as HighlightColor,
    anchor: parseJson<HighlightAnchor>(row.anchor, { kind: 'text', page: 1, start: 0, end: 0 }),
    text: String(row.text ?? ''),
    label: String(row.label ?? ''),
    createdBy: String(row.created_by),
    createdByName: String(row.created_by_name),
    createdAt: num(row.created_at),
  };
}

function rowToRoom(row: Row): RoomRecord {
  const state = parseJson<Partial<PersistedTurnState>>(row.state, {});
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    ownerId: String(row.owner_id),
    activeBookId: str(row.active_book_id),
    settings: { ...DEFAULT_ROOM_SETTINGS, ...parseJson<Partial<RoomSettings>>(row.settings, {}) },
    state: {
      queue: Array.isArray(state.queue) ? state.queue : [],
      reader: typeof state.reader === 'string' ? state.reader : null,
      turnStartedAt: typeof state.turnStartedAt === 'number' ? state.turnStartedAt : null,
      moderators: Array.isArray(state.moderators) ? state.moderators : [],
      banned: Array.isArray(state.banned) ? state.banned : [],
    },
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function rowToBook(row: Row): BookRecord {
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    title: String(row.title),
    author: str(row.author),
    format: String(row.format) as BookFormat,
    storageKey: String(row.storage_key),
    size: num(row.size),
    uploadedBy: String(row.uploaded_by),
    position: parseJson<Position | null>(row.position, null),
    createdAt: num(row.created_at),
  };
}

function rowToMessage(row: Row): ChatMessage {
  return {
    id: String(row.id),
    kind: row.kind === 'system' ? 'system' : 'user',
    userId: str(row.user_id),
    authorName: String(row.author_name),
    authorAvatar: str(row.author_avatar),
    body: String(row.body),
    createdAt: num(row.created_at),
  };
}

export class Database {
  constructor(readonly client: Client) {}

  static async open(url: string, authToken?: string): Promise<Database> {
    if (url.startsWith('file:')) {
      mkdirSync(path.dirname(url.slice('file:'.length)), { recursive: true });
    }
    const client = createClient({ url, authToken });
    const db = new Database(client);
    await db.migrate();
    return db;
  }

  async migrate() {
    await this.client.batch(SCHEMA, 'write');
    // Columns added after the first release.
    const bookColumns = (await this.all('PRAGMA table_info(books)')).map((r) => String(r.name));
    if (!bookColumns.includes('author')) await this.run('ALTER TABLE books ADD COLUMN author TEXT');
    await this.cleanupImportedNames();
  }

  /**
   * Early versions used the raw download file name as the book title and room name
   * ("A Man Called Ove A Novel -- Fredrik Backman -- 064e81… -- Anna's Archive").
   * Tidy those up once; names people chose themselves are left alone.
   */
  private async cleanupImportedNames() {
    const statements: { sql: string; args: InValue[] }[] = [];
    for (const row of await this.all('SELECT id, title, author FROM books')) {
      const title = String(row.title);
      if (!looksLikeRawFilename(title)) continue;
      const parsed = parseBookFilename(title);
      statements.push({
        sql: 'UPDATE books SET title = ?, author = ? WHERE id = ?',
        args: [parsed.title.slice(0, LIMITS.bookTitle), str(row.author) ?? parsed.author, String(row.id)],
      });
    }
    for (const row of await this.all('SELECT id, name FROM rooms')) {
      const name = String(row.name);
      if (!looksLikeRawFilename(name)) continue;
      statements.push({
        sql: 'UPDATE rooms SET name = ? WHERE id = ?',
        args: [parseBookFilename(name).title.slice(0, LIMITS.roomName), String(row.id)],
      });
    }
    if (statements.length) {
      await this.client.batch(statements, 'write');
      console.log(`[db] Tidied ${statements.length} book/room name(s) that were raw file names.`);
    }
  }

  async close() {
    this.client.close();
  }

  private async all(sql: string, args: InValue[] = []): Promise<Row[]> {
    return (await this.client.execute({ sql, args })).rows;
  }

  private async run(sql: string, args: InValue[] = []) {
    return this.client.execute({ sql, args });
  }

  // ---- users ---------------------------------------------------------------

  async upsertUser(user: UserRecord): Promise<void> {
    const now = Date.now();
    await this.run(
      `INSERT INTO users (id, username, display_name, avatar_url, is_admin, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name,
         avatar_url = excluded.avatar_url, is_admin = excluded.is_admin, last_login_at = excluded.last_login_at`,
      [user.id, user.username, user.displayName, user.avatarUrl, user.roleAdmin ? 1 : 0, now, now],
    );
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const [row] = await this.all('SELECT * FROM users WHERE id = ?', [id]);
    return row ? rowToUser(row) : null;
  }

  async getUsers(ids: string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.all(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    return rows.map(rowToUser);
  }

  // ---- rooms ---------------------------------------------------------------

  async createRoom(room: RoomRecord): Promise<void> {
    await this.run(
      `INSERT INTO rooms (id, name, description, owner_id, active_book_id, settings, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        room.id,
        room.name,
        room.description,
        room.ownerId,
        room.activeBookId,
        JSON.stringify(room.settings),
        JSON.stringify(room.state),
        room.createdAt,
        room.updatedAt,
      ],
    );
  }

  async saveRoom(room: RoomRecord): Promise<void> {
    await this.run(
      `UPDATE rooms SET name = ?, description = ?, active_book_id = ?, settings = ?, state = ?, updated_at = ? WHERE id = ?`,
      [
        room.name,
        room.description,
        room.activeBookId,
        JSON.stringify(room.settings),
        JSON.stringify(room.state),
        room.updatedAt,
        room.id,
      ],
    );
  }

  async getRoom(id: string): Promise<RoomRecord | null> {
    const [row] = await this.all('SELECT * FROM rooms WHERE id = ?', [id]);
    return row ? rowToRoom(row) : null;
  }

  async listRooms(): Promise<
    (RoomRecord & {
      ownerName: string | null;
      bookCount: number;
      bookTitle: string | null;
      bookFormat: BookFormat | null;
      bookAuthor: string | null;
      bookPosition: Position | null;
    })[]
  > {
    const rows = await this.all(
      `SELECT r.*, u.display_name AS owner_name, ab.title AS book_title, ab.format AS book_format,
         ab.author AS book_author, ab.position AS book_position,
         (SELECT COUNT(*) FROM books b WHERE b.room_id = r.id) AS book_count
       FROM rooms r
       LEFT JOIN users u ON u.id = r.owner_id
       LEFT JOIN books ab ON ab.id = r.active_book_id
       ORDER BY r.updated_at DESC LIMIT 200`,
    );
    return rows.map((row) => ({
      ...rowToRoom(row),
      ownerName: str(row.owner_name),
      bookCount: num(row.book_count),
      bookTitle: str(row.book_title),
      bookFormat: (str(row.book_format) as BookFormat | null) ?? null,
      bookAuthor: str(row.book_author),
      bookPosition: parseJson<Position | null>(row.book_position, null),
    }));
  }

  async countRoomsOwnedBy(userId: string): Promise<number> {
    const [row] = await this.all('SELECT COUNT(*) AS n FROM rooms WHERE owner_id = ?', [userId]);
    return num(row?.n);
  }

  async deleteRoom(id: string): Promise<void> {
    await this.client.batch(
      [
        { sql: 'DELETE FROM messages WHERE room_id = ?', args: [id] },
        { sql: 'DELETE FROM highlights WHERE room_id = ?', args: [id] },
        { sql: 'DELETE FROM books WHERE room_id = ?', args: [id] },
        { sql: 'DELETE FROM rooms WHERE id = ?', args: [id] },
      ],
      'write',
    );
  }

  // ---- books ---------------------------------------------------------------

  async createBook(book: BookRecord): Promise<void> {
    await this.run(
      `INSERT INTO books (id, room_id, title, author, format, storage_key, size, uploaded_by, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        book.id,
        book.roomId,
        book.title,
        book.author,
        book.format,
        book.storageKey,
        book.size,
        book.uploadedBy,
        book.position ? JSON.stringify(book.position) : null,
        book.createdAt,
      ],
    );
  }

  async getBook(id: string): Promise<BookRecord | null> {
    const [row] = await this.all('SELECT * FROM books WHERE id = ?', [id]);
    return row ? rowToBook(row) : null;
  }

  async listBooks(roomId: string): Promise<BookRecord[]> {
    const rows = await this.all('SELECT * FROM books WHERE room_id = ? ORDER BY created_at ASC', [roomId]);
    return rows.map(rowToBook);
  }

  async updateBookDetails(id: string, title: string, author: string | null): Promise<void> {
    await this.run('UPDATE books SET title = ?, author = ? WHERE id = ?', [title, author, id]);
  }

  async saveBookPosition(id: string, position: Position | null): Promise<void> {
    await this.run('UPDATE books SET position = ? WHERE id = ?', [position ? JSON.stringify(position) : null, id]);
  }

  async deleteBook(id: string): Promise<void> {
    await this.client.batch(
      [
        { sql: 'DELETE FROM highlights WHERE book_id = ?', args: [id] },
        { sql: 'DELETE FROM books WHERE id = ?', args: [id] },
      ],
      'write',
    );
  }

  // ---- highlights ------------------------------------------------------------

  async listHighlights(bookId: string): Promise<BookHighlight[]> {
    const rows = await this.all('SELECT * FROM highlights WHERE book_id = ? ORDER BY created_at ASC', [bookId]);
    return rows.map(rowToHighlight);
  }

  async addHighlight(roomId: string, h: BookHighlight): Promise<void> {
    await this.run(
      `INSERT INTO highlights (id, book_id, room_id, color, anchor, text, label, created_by, created_by_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [h.id, h.bookId, roomId, h.color, JSON.stringify(h.anchor), h.text, h.label, h.createdBy, h.createdByName, h.createdAt],
    );
  }

  async deleteHighlight(id: string): Promise<void> {
    await this.run('DELETE FROM highlights WHERE id = ?', [id]);
  }

  // ---- site admins -----------------------------------------------------------

  async listSiteAdmins(): Promise<SiteAdminRecord[]> {
    const rows = await this.all('SELECT * FROM site_admins ORDER BY created_at ASC');
    return rows.map((row) => ({ userId: String(row.user_id), addedBy: String(row.added_by), createdAt: num(row.created_at) }));
  }

  async addSiteAdmin(userId: string, addedBy: string): Promise<void> {
    await this.run('INSERT OR IGNORE INTO site_admins (user_id, added_by, created_at) VALUES (?, ?, ?)', [
      userId,
      addedBy,
      Date.now(),
    ]);
  }

  async removeSiteAdmin(userId: string): Promise<void> {
    await this.run('DELETE FROM site_admins WHERE user_id = ?', [userId]);
  }

  // ---- dictionary cache ------------------------------------------------------

  async getCached(key: string): Promise<{ data: string | null; fetchedAt: number } | null> {
    const [row] = await this.all('SELECT data, fetched_at FROM dictionary_cache WHERE key = ?', [key]);
    return row ? { data: str(row.data), fetchedAt: num(row.fetched_at) } : null;
  }

  async putCached(key: string, data: string | null): Promise<void> {
    await this.run('INSERT OR REPLACE INTO dictionary_cache (key, data, fetched_at) VALUES (?, ?, ?)', [key, data, Date.now()]);
  }

  // ---- book file chunks (database storage driver) ----------------------------

  async writeChunks(storageKey: string, startIndex: number, chunks: Uint8Array[]): Promise<void> {
    await this.client.batch(
      chunks.map((data, i) => ({
        sql: 'INSERT OR REPLACE INTO book_chunks (storage_key, idx, data) VALUES (?, ?, ?)',
        args: [storageKey, startIndex + i, data],
      })),
      'write',
    );
  }

  async readChunks(storageKey: string, fromIndex: number, limit: number): Promise<Uint8Array[]> {
    const rows = await this.all(
      'SELECT data FROM book_chunks WHERE storage_key = ? AND idx >= ? ORDER BY idx ASC LIMIT ?',
      [storageKey, fromIndex, limit],
    );
    return rows.map((row) => {
      const data = row.data as ArrayBuffer | Uint8Array;
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    });
  }

  async deleteChunks(storageKey: string): Promise<void> {
    await this.run('DELETE FROM book_chunks WHERE storage_key = ?', [storageKey]);
  }

  // ---- chat ----------------------------------------------------------------

  async addMessage(roomId: string, message: ChatMessage): Promise<void> {
    await this.run(
      `INSERT INTO messages (id, room_id, kind, user_id, author_name, author_avatar, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        roomId,
        message.kind,
        message.userId,
        message.authorName,
        message.authorAvatar,
        message.body,
        message.createdAt,
      ],
    );
  }

  async recentMessages(roomId: string, limit: number): Promise<ChatMessage[]> {
    const rows = await this.all(
      'SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      [roomId, limit],
    );
    return rows.map(rowToMessage).reverse();
  }

  async getMessage(id: string): Promise<(ChatMessage & { roomId: string }) | null> {
    const [row] = await this.all('SELECT * FROM messages WHERE id = ?', [id]);
    return row ? { ...rowToMessage(row), roomId: String(row.room_id) } : null;
  }

  async deleteMessage(id: string): Promise<void> {
    await this.run('DELETE FROM messages WHERE id = ?', [id]);
  }

  /** Keeps only the newest `keep` messages of a room. */
  async pruneMessages(roomId: string, keep: number): Promise<void> {
    await this.run(
      `DELETE FROM messages WHERE room_id = ? AND id NOT IN (
         SELECT id FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?
       )`,
      [roomId, roomId, keep],
    );
  }
}
