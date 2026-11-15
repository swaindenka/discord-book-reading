import type { Auth } from './auth.js';
import type { Database } from './db.js';
import { channel, UserError, type AppSocket, type IO, type LiveRoom, type RoomManager } from './rooms.js';
import { LIMITS, type AckResult } from '../shared/types.js';

interface SocketDeps {
  io: IO;
  auth: Auth;
  db: Database;
  rooms: RoomManager;
}

type AnyAck = (result: AckResult<object>) => void;

function clamp01(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

export function setupSockets({ io, auth, db, rooms }: SocketDeps) {
  io.use(async (socket, next) => {
    try {
      const user = await auth.userFromRequest(socket.request);
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = user;
      socket.data.roomId = null;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on('connection', (socket: AppSocket) => {
    const user = socket.data.user;
    let lastCue = 0;

    /** Runs a handler and reports success or a readable error through the ack callback. */
    const handle =
      <A extends unknown[]>(fn: (...args: A) => Promise<object | void> | object | void) =>
      async (...args: unknown[]) => {
        const last = args[args.length - 1];
        const ack: AnyAck = typeof last === 'function' ? (last as AnyAck) : () => {};
        try {
          const result = await fn(...(args as A));
          ack({ ok: true, ...(result ?? {}) });
        } catch (err) {
          if (!(err instanceof UserError)) console.error(`[socket] ${user.id}:`, err);
          ack({ ok: false, error: err instanceof UserError ? err.message : 'Something went wrong. Please try again.' });
        }
      };

    const currentRoom = async (): Promise<LiveRoom> => {
      const roomId = socket.data.roomId;
      const room = roomId ? await rooms.get(roomId) : null;
      if (!room || room.deleted) throw new UserError('Join a room first.');
      return room;
    };

    const leaveCurrent = async () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const room = await rooms.get(roomId);
      room?.leave(socket);
      socket.data.roomId = null;
    };

    socket.on(
      'room:join',
      handle(async (payload: { roomId?: unknown }) => {
        const roomId = typeof payload?.roomId === 'string' ? payload.roomId : '';
        if (socket.data.roomId && socket.data.roomId !== roomId) await leaveCurrent();
        const room = roomId ? await rooms.get(roomId) : null;
        if (!room || room.deleted) throw new UserError('This room does not exist (anymore).');
        await room.join(socket);
        const [messages, highlights] = await Promise.all([
          db.recentMessages(room.id, LIMITS.chatHistory),
          room.highlightsFor(room.record.activeBookId),
        ]);
        return { state: room.snapshot(), messages, highlights };
      }),
    );

    socket.on('room:leave', () => void leaveCurrent());

    socket.on(
      'queue:join',
      handle(async () => (await currentRoom()).queueJoin(user)),
    );
    socket.on(
      'queue:leave',
      handle(async () => (await currentRoom()).queueLeave(user)),
    );
    socket.on(
      'turn:start',
      handle(async () => (await currentRoom()).turnStart(user)),
    );
    socket.on(
      'turn:finish',
      handle(async () => (await currentRoom()).turnEnd(user, 'finished')),
    );
    socket.on(
      'turn:pass',
      handle(async () => (await currentRoom()).turnEnd(user, 'passed')),
    );

    socket.on(
      'nav:set',
      handle(async (payload: { bookId?: unknown; position?: unknown }) => {
        const room = await currentRoom();
        const bookId = String(payload?.bookId ?? '');
        const position = room.navigate(user, bookId, payload?.position);
        socket.to(channel(room.id)).emit('nav:position', { bookId, position, by: user.id });
      }),
    );

    // Live cues (pointer / highlight) are fire-and-forget and may be dropped under load.
    socket.on('pointer', async (payload) => {
      const now = Date.now();
      if (now - lastCue < 30) return;
      lastCue = now;
      const room = socket.data.roomId ? await rooms.get(socket.data.roomId) : null;
      if (!room || !room.canControl(user.id) || room.activeBook?.id !== payload?.bookId) return;
      const page = Number(payload.page);
      if (!Number.isInteger(page) || page < 1) return;
      const x = payload.x === null ? null : clamp01(payload.x);
      const y = payload.y === null ? null : clamp01(payload.y);
      socket.to(channel(room.id)).volatile.emit('pointer', { userId: user.id, bookId: payload.bookId, page, x, y });
    });

    socket.on('selection', async (payload) => {
      const room = socket.data.roomId ? await rooms.get(socket.data.roomId) : null;
      if (!room || !room.canControl(user.id) || room.activeBook?.id !== payload?.bookId) return;
      const cfiRange = payload.cfiRange;
      if (cfiRange !== null && (typeof cfiRange !== 'string' || !cfiRange.startsWith('epubcfi(') || cfiRange.length > 2000)) {
        return;
      }
      socket.to(channel(room.id)).emit('selection', { userId: user.id, bookId: payload.bookId, cfiRange });
    });

    socket.on(
      'highlight:add',
      handle(async (payload: Record<string, unknown>) => ({
        highlight: await (await currentRoom()).addHighlight(user, payload),
      })),
    );
    socket.on(
      'highlight:remove',
      handle(async (payload: { id?: unknown }) => (await currentRoom()).removeHighlight(user, payload?.id)),
    );

    socket.on('reaction', async (payload) => {
      const room = socket.data.roomId ? await rooms.get(socket.data.roomId) : null;
      const emoji = room?.react(user, payload?.emoji);
      if (!room || !emoji) return;
      io.to(channel(room.id)).emit('reaction', { userId: user.id, name: user.displayName, emoji });
    });

    socket.on('book:pages', async (payload) => {
      const room = socket.data.roomId ? await rooms.get(socket.data.roomId) : null;
      await room?.setPageCount(user, payload?.bookId, payload?.pageCount).catch(() => {});
    });

    socket.on(
      'stats:get',
      handle(async (payload: { scope?: unknown }) => ({
        stats: await (await currentRoom()).stats(payload?.scope === 'room' ? 'room' : 'book'),
      })),
    );

    socket.on(
      'chat:send',
      handle(async (payload: { body?: unknown }) => (await currentRoom()).chat(user, payload?.body)),
    );
    socket.on(
      'chat:delete',
      handle(async (payload: { messageId?: unknown }) => (await currentRoom()).deleteMessage(user, payload?.messageId)),
    );
    socket.on(
      'mod:action',
      handle(async (action) => (await currentRoom()).moderate(user, action as never)),
    );

    socket.on('disconnect', () => void leaveCurrent());
  });
}
