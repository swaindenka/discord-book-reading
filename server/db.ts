import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient, type Client, type InValue, type Row } from '@libsql/client';
import type { BookFormat, ChatMessage, Position, RoomSettings } from '../shared/types.js';
import { DEFAULT_ROOM_SETTINGS } from '../shared/types.js';

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
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
    isAdmin: num(row.is_admin) === 1,
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
      [user.id, user.username, user.displayName, user.avatarUrl, user.isAdmin ? 1 : 0, now, now],
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
    (RoomRecord & { ownerName: string | null; bookCount: number; bookTitle: string | null; bookFormat: BookFormat | null })[]
  > {
    const rows = await this.all(
      `SELECT r.*, u.display_name AS owner_name, ab.title AS book_title, ab.format AS book_format,
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
        { sql: 'DELETE FROM books WHERE room_id = ?', args: [id] },
        { sql: 'DELETE FROM rooms WHERE id = ?', args: [id] },
      ],
      'write',
    );
  }

  // ---- books ---------------------------------------------------------------

  async createBook(book: BookRecord): Promise<void> {
    await this.run(
      `INSERT INTO books (id, room_id, title, format, storage_key, size, uploaded_by, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        book.id,
        book.roomId,
        book.title,
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

  async saveBookPosition(id: string, position: Position | null): Promise<void> {
    await this.run('UPDATE books SET position = ? WHERE id = ?', [position ? JSON.stringify(position) : null, id]);
  }

  async deleteBook(id: string): Promise<void> {
    await this.run('DELETE FROM books WHERE id = ?', [id]);
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
