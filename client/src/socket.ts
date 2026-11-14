import { io, type Socket } from 'socket.io-client';
import type { AckResult, ClientToServerEvents, ServerToClientEvents } from '../../shared/types';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

export function getSocket(): AppSocket {
  if (!socket) {
    socket = io({ autoConnect: false, withCredentials: true });
  }
  if (!socket.connected && !socket.active) socket.connect();
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

type EventsWithAck = {
  [K in keyof ClientToServerEvents]: Parameters<ClientToServerEvents[K]> extends [infer _A, (r: AckResult<infer _R>) => void]
    ? K
    : Parameters<ClientToServerEvents[K]> extends [(r: AckResult<infer _R>) => void]
      ? K
      : never;
}[keyof ClientToServerEvents];

/** Emits an event and resolves with the server's reply, rejecting with a readable message. */
export function request<T extends object = object>(event: EventsWithAck, payload?: unknown, timeoutMs = 10_000): Promise<T> {
  const s = getSocket();
  return new Promise((resolve, reject) => {
    const done = (result: AckResult<T>) => {
      if (result.ok) resolve(result as T);
      else reject(new Error(result.error));
    };
    const timed = s.timeout(timeoutMs) as unknown as {
      emit: (event: string, ...args: unknown[]) => void;
    };
    const callback = (err: Error | null, result: AckResult<T>) => {
      if (err) reject(new Error('The server did not answer. Check your connection.'));
      else done(result);
    };
    if (payload === undefined) timed.emit(event, callback);
    else timed.emit(event, payload, callback);
  });
}
