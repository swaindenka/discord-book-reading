// Types and constants shared by the server and the browser client.

export type BookFormat = 'pdf' | 'epub' | 'txt' | 'md' | 'cbz';

export interface FormatInfo {
  label: string;
  short: string;
  extensions: string[];
  mime: string;
}

export const BOOK_FORMATS: Record<BookFormat, FormatInfo> = {
  pdf: { label: 'PDF', short: 'PDF', extensions: ['.pdf'], mime: 'application/pdf' },
  epub: { label: 'EPUB', short: 'EPUB', extensions: ['.epub'], mime: 'application/epub+zip' },
  txt: { label: 'Plain text', short: 'TXT', extensions: ['.txt'], mime: 'text/plain; charset=utf-8' },
  md: { label: 'Markdown', short: 'MD', extensions: ['.md', '.markdown'], mime: 'text/markdown; charset=utf-8' },
  cbz: { label: 'Comic book (CBZ)', short: 'CBZ', extensions: ['.cbz'], mime: 'application/vnd.comicbook+zip' },
};

export const ACCEPTED_EXTENSIONS = Object.values(BOOK_FORMATS).flatMap((f) => f.extensions);

export function formatFromFilename(name: string): BookFormat | null {
  const lower = name.toLowerCase();
  for (const [format, info] of Object.entries(BOOK_FORMATS) as [BookFormat, FormatInfo][]) {
    if (info.extensions.some((ext) => lower.endsWith(ext))) return format;
  }
  return null;
}

export const LIMITS = {
  roomName: 60,
  roomDescription: 280,
  bookTitle: 120,
  chatMessage: 1000,
  chatHistory: 150,
} as const;

/** Where the group currently is inside a book. */
export type Position =
  | {
      kind: 'page';
      /** 1-based page number (PDF page, comic page or text chunk). */
      page: number;
      /** Vertical point (0–1) of the page shown in the middle of the reader's screen. */
      scroll?: number;
    }
  | {
      kind: 'cfi';
      /** EPUB canonical fragment identifier of the first visible character. */
      cfi: string;
      /** 0–100, when known. */
      percent?: number;
      /** Chapter title, when known. */
      label?: string;
    };

export interface PublicUser {
  id: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  /** Site-wide admin: owner rights in every room. */
  isAdmin: boolean;
  /** Listed in ADMIN_USER_IDS: can add and remove other site admins. */
  isRootAdmin: boolean;
}

export interface SiteAdmin {
  userId: string;
  /** Null when this person hasn't signed in yet. */
  name: string | null;
  avatarUrl: string | null;
  /** From the ADMIN_USER_IDS setting (can't be removed in the app). */
  fromConfig: boolean;
  addedByName: string | null;
  createdAt: number | null;
}

export type MemberRole = 'owner' | 'admin' | 'mod' | 'member';

export interface MemberInfo {
  id: string;
  name: string;
  avatarUrl: string | null;
  online: boolean;
  role: MemberRole;
}

export interface BookInfo {
  id: string;
  title: string;
  format: BookFormat;
  size: number;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: number;
  position: Position | null;
}

export interface RoomSettings {
  /** Readers who finish or pass go back to the end of the queue. */
  rotate: boolean;
  /** Only moderators can add people to the queue. */
  queueLocked: boolean;
  /** Skip the reader automatically if they stay disconnected for `offlineGraceSeconds`. */
  autoSkipOffline: boolean;
  offlineGraceSeconds: number;
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  rotate: true,
  queueLocked: false,
  autoSkipOffline: true,
  offlineGraceSeconds: 60,
};

export interface RoomState {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  settings: RoomSettings;
  /** Everyone currently connected to the room. */
  members: MemberInfo[];
  /** Waiting readers, in order. May include people who are offline. */
  queue: MemberInfo[];
  reader: (MemberInfo & { since: number }) | null;
  moderators: string[];
  banned: { id: string; name: string }[];
  books: BookInfo[];
  activeBookId: string | null;
  position: Position | null;
  serverTime: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  description: string;
  ownerName: string;
  bookTitle: string | null;
  bookFormat: BookFormat | null;
  bookCount: number;
  online: { name: string; avatarUrl: string | null }[];
  readerName: string | null;
  queueLength: number;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  kind: 'user' | 'system';
  userId: string | null;
  authorName: string;
  authorAvatar: string | null;
  body: string;
  createdAt: number;
}

export interface PointerEvent {
  userId: string;
  bookId: string;
  page: number;
  /** 0–1 relative to the page width/height; null hides the pointer. */
  x: number | null;
  y: number | null;
}

/** The reader's current EPUB text selection, shown live to followers. */
export interface SelectionCue {
  userId: string;
  bookId: string;
  /** EPUB CFI range; null clears it. */
  cfiRange: string | null;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';
export const HIGHLIGHT_COLORS: Record<HighlightColor, { label: string; css: string }> = {
  yellow: { label: 'Yellow', css: '#ffd43b' },
  green: { label: 'Green', css: '#69db7c' },
  blue: { label: 'Blue', css: '#74c0fc' },
  pink: { label: 'Pink', css: '#f783ac' },
};

/** Where a highlight sits. The shape depends on the book format. */
export type HighlightAnchor =
  /** EPUB: a CFI range. */
  | { kind: 'cfi'; cfiRange: string }
  /** PDF / CBZ: boxes on a page as [x, y, width, height], each 0–1 of the page size. */
  | { kind: 'rects'; page: number; rects: [number, number, number, number][] }
  /** TXT / Markdown: character offsets within a page's text. */
  | { kind: 'text'; page: number; start: number; end: number };

export interface BookHighlight {
  id: string;
  bookId: string;
  color: HighlightColor;
  anchor: HighlightAnchor;
  /** The highlighted text (empty for area highlights). */
  text: string;
  /** "Page 12" or the chapter name. */
  label: string;
  createdBy: string;
  createdByName: string;
  createdAt: number;
}

export const HIGHLIGHT_LIMITS = { text: 1000, rects: 200, perBook: 2000 } as const;

export interface DictionarySense {
  partOfSpeech: string;
  definitions: { text: string; example?: string }[];
}

export interface DictionaryEntry {
  word: string;
  phonetic?: string;
  senses: DictionarySense[];
  source: 'oxford' | 'wordnet' | 'wiktionary';
  sourceLabel: string;
}

export interface DictionaryResult {
  query: string;
  entry: DictionaryEntry | null;
  /** Oxford Learner's Dictionaries search page for the word. */
  oxfordUrl: string;
}

export interface AppConfig {
  appName: string;
  discordLogin: boolean;
  devLogin: boolean;
  guildRestricted: boolean;
  maxUploadMb: number;
  /** Which dictionary answers word look-ups first, or null when look-ups are off. */
  dictionary: 'oxford' | 'builtin' | null;
}

export type ModAction =
  | { type: 'queue.move'; userId: string; index: number }
  | { type: 'queue.remove'; userId: string }
  | { type: 'queue.add'; userId: string }
  | { type: 'queue.shuffle' }
  | { type: 'queue.clear' }
  | { type: 'reader.set'; userId: string }
  | { type: 'reader.skip' }
  | { type: 'reader.stop' }
  | { type: 'settings'; settings: Partial<RoomSettings> }
  | { type: 'room.update'; name?: string; description?: string }
  | { type: 'mod.grant'; userId: string }
  | { type: 'mod.revoke'; userId: string }
  | { type: 'member.kick'; userId: string }
  | { type: 'member.ban'; userId: string }
  | { type: 'member.unban'; userId: string }
  | { type: 'book.activate'; bookId: string };

export type AckResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };
export type Ack<T extends object = object> = (result: AckResult<T>) => void;

export interface ClientToServerEvents {
  'room:join': (
    payload: { roomId: string },
    ack: Ack<{ state: RoomState; messages: ChatMessage[]; highlights: BookHighlight[] }>,
  ) => void;
  'room:leave': () => void;
  'queue:join': (ack: Ack) => void;
  'queue:leave': (ack: Ack) => void;
  /** Take the turn when nobody is reading and you are first in line. */
  'turn:start': (ack: Ack) => void;
  'turn:finish': (ack: Ack) => void;
  'turn:pass': (ack: Ack) => void;
  'nav:set': (payload: { bookId: string; position: Position }, ack?: Ack) => void;
  pointer: (payload: Omit<PointerEvent, 'userId'>) => void;
  selection: (payload: Omit<SelectionCue, 'userId'>) => void;
  'highlight:add': (
    payload: { bookId: string; color: HighlightColor; anchor: HighlightAnchor; text: string; label: string },
    ack: Ack<{ highlight: BookHighlight }>,
  ) => void;
  'highlight:remove': (payload: { id: string }, ack: Ack) => void;
  'chat:send': (payload: { body: string }, ack: Ack) => void;
  'chat:delete': (payload: { messageId: string }, ack: Ack) => void;
  'mod:action': (action: ModAction, ack: Ack) => void;
}

export interface ServerToClientEvents {
  'room:state': (state: RoomState) => void;
  'room:kicked': (payload: { banned: boolean }) => void;
  'room:deleted': () => void;
  'nav:position': (payload: { bookId: string; position: Position; by: string }) => void;
  pointer: (payload: PointerEvent) => void;
  selection: (payload: SelectionCue) => void;
  'highlights:set': (payload: { bookId: string; highlights: BookHighlight[] }) => void;
  'highlight:added': (highlight: BookHighlight) => void;
  'highlight:removed': (payload: { id: string; bookId: string }) => void;
  'chat:message': (message: ChatMessage) => void;
  'chat:deleted': (payload: { id: string }) => void;
}
