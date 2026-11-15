import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { Config } from './config.js';
import type { Database, BookRecord, UserRecord } from './db.js';
import { isValidUserId, requireUser, toPublicUser, type UserCache } from './auth.js';
import { normalizeQuery, type Dictionary } from './dictionary.js';
import { cleanTitle, looksLikeRawFilename, parseBookFilename } from '../shared/bookname.js';
import type { BookStorage } from './storage.js';
import { newId, UserError, type LiveRoom, type RoomManager } from './rooms.js';
import {
  BOOK_FORMATS,
  LIMITS,
  formatFromFilename,
  type AppConfig,
  type BookFormat,
  type SiteAdmin,
} from '../shared/types.js';

interface ApiDeps {
  config: Config;
  db: Database;
  storage: BookStorage;
  rooms: RoomManager;
  users: UserCache;
  dictionary: Dictionary;
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Wraps async handlers so thrown errors reach the error middleware. */
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/** Checks the first bytes of an upload so a renamed file can't pose as a book. */
async function sniffFormat(file: string, format: BookFormat): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    switch (format) {
      case 'pdf':
        return head.subarray(0, 1024).includes('%PDF-');
      case 'epub':
      case 'cbz':
        return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
      case 'txt':
      case 'md':
        return head.length > 0 && !head.includes(0);
    }
  } finally {
    await handle.close();
  }
}

/** Title and author for an upload: what the uploader typed, or a tidied-up file name. */
function bookName(rawTitle: unknown, rawAuthor: unknown, filename: string) {
  const parsed = parseBookFilename(path.basename(filename));
  const typedTitle = typeof rawTitle === 'string' ? cleanTitle(rawTitle) : '';
  const typedAuthor = typeof rawAuthor === 'string' ? rawAuthor.replace(/\s+/g, ' ').trim() : '';
  return {
    title: (typedTitle || parsed.title).slice(0, LIMITS.bookTitle) || 'Untitled book',
    // An explicitly empty author field means "no author"; a missing one falls back to the file name.
    author: (typeof rawAuthor === 'string' ? typedAuthor : (parsed.author ?? '')).slice(0, LIMITS.bookAuthor) || null,
  };
}

export function apiRouter({ config, db, storage, rooms, users, dictionary }: ApiDeps) {
  const router = Router();
  const upload = multer({
    dest: path.join(config.dataDir, 'tmp'),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 10, fieldSize: 4096 },
  });
  const single = (req: Request, res: Response, next: NextFunction) =>
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE' ? `Books can be up to ${config.maxUploadMb} MB.` : 'The upload could not be read.';
        return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
      }
      next(err);
    });

  /** Validates and stores an uploaded file; always removes the temp file. */
  async function storeBook(
    file: Express.Multer.File,
    rawTitle: unknown,
    rawAuthor: unknown,
    roomId: string,
    user: UserRecord,
  ) {
    try {
      const format = formatFromFilename(file.originalname);
      if (!format) {
        const accepted = Object.values(BOOK_FORMATS)
          .flatMap((f) => f.extensions)
          .join(', ');
        throw new UserError(`Unsupported file type. Accepted: ${accepted}`);
      }
      if (!(await sniffFormat(file.path, format))) {
        throw new UserError(`That file does not look like a valid ${BOOK_FORMATS[format].label} file.`);
      }
      const id = newId(12);
      const book: BookRecord = {
        id,
        roomId,
        ...bookName(rawTitle, rawAuthor, file.originalname),
        format,
        storageKey: `${id}.${format}`,
        size: file.size,
        uploadedBy: user.id,
        position: null,
        pageCount: null,
        createdAt: Date.now(),
      };
      await storage.save(book.storageKey, file.path);
      await db.createBook(book);
      return book;
    } finally {
      await unlink(file.path).catch(() => {});
    }
  }

  async function loadRoom(req: Request) {
    const room = await rooms.get(String(req.params.roomId));
    if (!room) throw Object.assign(new UserError('Room not found.'), { status: 404 });
    return room;
  }

  function assertMod(room: LiveRoom, user: UserRecord) {
    if (!room.isMod(user.id)) throw Object.assign(new UserError('Only moderators can do that.'), { status: 403 });
  }

  router.get('/config', (_req, res) => {
    const body: AppConfig = {
      appName: config.appName,
      discordLogin: config.discord.enabled,
      devLogin: config.devLogin,
      guildRestricted: config.discord.guildIds.length > 0,
      maxUploadMb: config.maxUploadMb,
      dictionary: dictionary.provider,
    };
    res.json(body);
  });

  router.get('/me', (req, res) => {
    res.json({ user: req.user ? toPublicUser(req.user, users.isRootAdmin(req.user.id)) : null });
  });

  // ---- dictionary --------------------------------------------------------------

  router.get(
    '/dictionary',
    requireUser,
    wrap(async (req, res) => {
      const query = normalizeQuery(req.query.word);
      if (!query) return res.status(400).json({ error: 'Select a word (or a short phrase) to look it up.' });
      if (!dictionary.allow(req.user!.id)) return res.status(429).json({ error: 'Too many look-ups. Try again in a minute.' });
      try {
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.json(await dictionary.define(query));
      } catch (err) {
        console.warn('[dictionary]', (err as Error).message);
        res.status(502).json({ error: 'The dictionary is not answering right now.' });
      }
    }),
  );

  // ---- site admins -------------------------------------------------------------

  const listAdmins = async (): Promise<SiteAdmin[]> => {
    const added = await db.listSiteAdmins();
    const ids = [...new Set([...users.rootAdminIds, ...added.map((a) => a.userId), ...added.map((a) => a.addedBy)])];
    await users.preload(ids);
    const fromConfig = new Set(users.rootAdminIds);
    const describe = (userId: string, extra: Partial<SiteAdmin>): SiteAdmin => {
      const user = users.peek(userId);
      return {
        userId,
        name: user?.displayName ?? null,
        avatarUrl: user?.avatarUrl ?? null,
        fromConfig: fromConfig.has(userId),
        addedByName: null,
        createdAt: null,
        ...extra,
      };
    };
    return [
      ...users.rootAdminIds.map((id) => describe(id, {})),
      ...added
        .filter((a) => !fromConfig.has(a.userId))
        .map((a) => describe(a.userId, { addedByName: users.peek(a.addedBy)?.displayName ?? null, createdAt: a.createdAt })),
    ];
  };

  const requireRootAdmin = (req: Request) => {
    if (!users.isRootAdmin(req.user!.id)) {
      throw Object.assign(new UserError('Only the admins listed in ADMIN_USER_IDS can manage site admins.'), { status: 403 });
    }
  };

  router.get(
    '/admins',
    requireUser,
    wrap(async (req, res) => {
      if (!req.user!.isAdmin) return res.status(403).json({ error: 'Only site admins can see this.' });
      res.json({ admins: await listAdmins() });
    }),
  );

  router.post(
    '/admins',
    requireUser,
    wrap(async (req, res) => {
      requireRootAdmin(req);
      const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
      if (!isValidUserId(userId)) throw new UserError('That does not look like a Discord user ID (17–20 digits).');
      await db.addSiteAdmin(userId, req.user!.id);
      await users.reloadAdmins();
      rooms.broadcastAll();
      res.status(201).json({ admins: await listAdmins() });
    }),
  );

  router.delete(
    '/admins/:userId',
    requireUser,
    wrap(async (req, res) => {
      requireRootAdmin(req);
      const userId = String(req.params.userId);
      if (users.isRootAdmin(userId)) {
        throw new UserError('This admin comes from the ADMIN_USER_IDS setting; remove them there.');
      }
      await db.removeSiteAdmin(userId);
      await users.reloadAdmins();
      rooms.broadcastAll();
      res.json({ admins: await listAdmins() });
    }),
  );

  router.get(
    '/rooms',
    requireUser,
    wrap(async (_req, res) => {
      res.json({ rooms: await rooms.summaries() });
    }),
  );

  router.post(
    '/rooms',
    requireUser,
    single,
    wrap(async (req, res) => {
      const user = req.user!;
      const file = req.file;
      try {
        const rawName = typeof req.body?.name === 'string' ? req.body.name.replace(/\s+/g, ' ').trim() : '';
        const name = (looksLikeRawFilename(rawName) ? parseBookFilename(rawName).title : rawName).slice(0, LIMITS.roomName);
        const description =
          typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, LIMITS.roomDescription) : '';
        if (!name) throw new UserError('Give your room a name.');
        if (!user.isAdmin && (await db.countRoomsOwnedBy(user.id)) >= config.maxRoomsPerUser) {
          throw new UserError(`You can own up to ${config.maxRoomsPerUser} rooms. Delete one first.`);
        }
        const room = await rooms.create(user, name, description);
        if (file) {
          try {
            const book = await storeBook(file, req.body?.title, req.body?.author, room.id, user);
            await room.addBook(book, user);
          } catch (err) {
            await rooms.delete(room);
            throw err;
          }
        }
        await room.flush();
        res.status(201).json({ id: room.id });
      } finally {
        if (file) await unlink(file.path).catch(() => {});
      }
    }),
  );

  router.delete(
    '/rooms/:roomId',
    requireUser,
    wrap(async (req, res) => {
      const room = await loadRoom(req);
      const role = room.roleOf(req.user!.id);
      if (role !== 'owner' && role !== 'admin') {
        throw Object.assign(new UserError('Only the room owner can delete it.'), { status: 403 });
      }
      await rooms.delete(room);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/rooms/:roomId/books',
    requireUser,
    single,
    wrap(async (req, res) => {
      const file = req.file;
      try {
        const room = await loadRoom(req);
        assertMod(room, req.user!);
        if (!file) throw new UserError('Choose a file to upload.');
        if (room.books.length >= config.maxBooksPerRoom) {
          throw new UserError(`A room can hold up to ${config.maxBooksPerRoom} books. Delete one first.`);
        }
        const book = await storeBook(file, req.body?.title, req.body?.author, room.id, req.user!);
        await room.addBook(book, req.user!);
        res.status(201).json({ id: book.id });
      } finally {
        if (file) await unlink(file.path).catch(() => {});
      }
    }),
  );

  router.delete(
    '/rooms/:roomId/books/:bookId',
    requireUser,
    wrap(async (req, res) => {
      const room = await loadRoom(req);
      await room.removeBook(req.user!, String(req.params.bookId));
      res.json({ ok: true });
    }),
  );

  router.get(
    '/books/:bookId/file',
    requireUser,
    wrap(async (req, res) => {
      const book = await db.getBook(String(req.params.bookId));
      if (!book) return res.status(404).json({ error: 'Book not found.' });
      const room = await rooms.get(book.roomId);
      if (!room || (room.banned.has(req.user!.id) && !req.user!.isAdmin)) {
        return res.status(403).json({ error: 'You cannot open this book.' });
      }
      const file = await storage.localPath(book.storageKey);
      const ascii = book.title.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '');
      res.setHeader('Content-Type', BOOK_FORMATS[book.format].mime);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${ascii}${BOOK_FORMATS[book.format].extensions[0]}"; filename*=UTF-8''${encodeURIComponent(book.title)}${BOOK_FORMATS[book.format].extensions[0]}`,
      );
      res.sendFile(file, { dotfiles: 'allow' });
    }),
  );

  router.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

  return router;
}
