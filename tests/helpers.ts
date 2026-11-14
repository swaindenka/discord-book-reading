import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { io as ioClient, type Socket } from 'socket.io-client';
import { config as baseConfig, type Config } from '../server/config.js';
import { createApp } from '../server/app.js';
import { Database } from '../server/db.js';
import { DatabaseStorage, LocalStorage } from '../server/storage.js';
import type { AckResult, ClientToServerEvents, ServerToClientEvents } from '../shared/types.js';

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type Overrides = Partial<Omit<Config, 'discord'>> & { discord?: Partial<Config['discord']> };

export async function startServer(overrides: Overrides = {}, existing?: { dir: string }) {
  const dir = existing?.dir ?? (await mkdtemp(path.join(os.tmpdir(), 'rr-test-')));
  const config: Config = {
    ...baseConfig,
    isProduction: false,
    devLogin: true,
    sessionSecret: 'test-secret',
    secureCookies: false,
    maxUploadMb: 5,
    maxRoomsPerUser: 3,
    adminUserIds: [],
    dataDir: dir,
    clientDir: path.join(dir, 'no-client-build'),
    storageDriver: 'local',
    ...overrides,
    discord: { ...baseConfig.discord, enabled: false, guildId: null, adminRoleIds: [], ...overrides.discord },
  } as Config;
  const db = await Database.open(`file:${path.join(dir, 'test.db')}`);
  const storage =
    config.storageDriver === 'database' ? new DatabaseStorage(db, path.join(dir, 'cache')) : new LocalStorage(path.join(dir, 'books'));
  const app = createApp({ config, db, storage });
  await new Promise<void>((resolve) => app.http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.http.address() as AddressInfo).port}`;
  const sockets: TestSocket[] = [];

  return {
    base,
    dir,
    db,
    app,
    /** Stops the server; pass keepData to restart on the same files. */
    async close({ keepData = false } = {}) {
      sockets.forEach((s) => s.disconnect());
      await app.close();
      await db.close();
      if (!keepData) await rm(dir, { recursive: true, force: true });
    },
    async login(name: string) {
      const res = await fetch(`${base}/auth/dev`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'reading-room' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`login failed: ${res.status}`);
      return cookieHeader(res);
    },
    async connect(cookie: string): Promise<TestSocket> {
      const socket: TestSocket = ioClient(base, {
        transports: ['websocket'],
        extraHeaders: { cookie },
        forceNew: true,
        reconnection: false,
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      return socket;
    },
    fetch(pathname: string, cookie: string, init: RequestInit = {}) {
      return fetch(`${base}${pathname}`, {
        ...init,
        headers: { cookie, 'x-requested-with': 'reading-room', ...(init.headers ?? {}) },
      });
    },
    async createRoom(cookie: string, name: string, file?: { name: string; data: Uint8Array<ArrayBuffer> | string }) {
      const form = new FormData();
      form.set('name', name);
      if (file) form.set('file', new Blob([file.data]), file.name);
      const res = await fetch(`${base}/api/rooms`, {
        method: 'POST',
        headers: { cookie, 'x-requested-with': 'reading-room' },
        body: form,
      });
      return { status: res.status, body: (await res.json()) as { id?: string; error?: string } };
    },
  };
}

export type TestServer = Awaited<ReturnType<typeof startServer>>;

export function cookieHeader(res: Response) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** Emits an event with an ack and resolves with the server's reply. */
export function emit<T extends object = object>(socket: TestSocket, event: string, payload?: unknown): Promise<AckResult<T>> {
  return new Promise((resolve) => {
    const s = socket as unknown as { emit: (...args: unknown[]) => void };
    if (payload === undefined) s.emit(event, resolve);
    else s.emit(event, payload, resolve);
  });
}

/** Resolves with the next event payload that matches `predicate`. */
export function next<T>(socket: TestSocket, event: string, predicate: (payload: T) => boolean = () => true, timeoutMs = 4000) {
  return new Promise<T>((resolve, reject) => {
    const s = socket as unknown as { on: (e: string, fn: (p: T) => void) => void; off: (e: string, fn: (p: T) => void) => void };
    const timer = setTimeout(() => {
      s.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      s.off(event, handler);
      resolve(payload);
    };
    s.on(event, handler);
  });
}

/** A tiny but valid-looking PDF header is enough for upload validation. */
export const FAKE_PDF = '%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n';
