import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, rename, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Database } from './db.js';

/** Stores uploaded book files. Every driver can hand back a local file path to stream from. */
export interface BookStorage {
  readonly driver: 'local' | 'database';
  /** Moves the uploaded temp file into storage. */
  save(key: string, sourcePath: string): Promise<void>;
  /** Returns a path on local disk holding the file contents. */
  localPath(key: string): Promise<string>;
  remove(key: string): Promise<void>;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+\.[a-z0-9]+$/;

function assertKey(key: string) {
  if (!KEY_PATTERN.test(key)) throw new Error(`Invalid storage key: ${key}`);
}

async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function moveFile(from: string, to: string) {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}

/** Keeps files in a directory on disk. Use a persistent volume in production. */
export class LocalStorage implements BookStorage {
  readonly driver = 'local' as const;
  constructor(private readonly dir: string) {}

  async save(key: string, sourcePath: string) {
    assertKey(key);
    await mkdir(this.dir, { recursive: true });
    await moveFile(sourcePath, path.join(this.dir, key));
  }

  async localPath(key: string) {
    assertKey(key);
    const file = path.join(this.dir, key);
    if (!(await exists(file))) throw Object.assign(new Error('File not found'), { status: 404 });
    return file;
  }

  async remove(key: string) {
    assertKey(key);
    await rm(path.join(this.dir, key), { force: true });
  }
}

const CHUNK_SIZE = 256 * 1024;
// Keep each request to a remote database around 1 MB.
const CHUNKS_PER_BATCH = 4;

/**
 * Splits files into 256 KB blobs inside the database. This keeps everything in one free
 * hosted database (e.g. Turso) when the web host has no persistent disk (e.g. Render free).
 * Files are cached on local disk after the first read.
 */
export class DatabaseStorage implements BookStorage {
  readonly driver = 'database' as const;
  private pending = new Map<string, Promise<string>>();

  constructor(
    private readonly db: Database,
    private readonly cacheDir = path.join(os.tmpdir(), 'reading-room-cache'),
  ) {}

  async save(key: string, sourcePath: string) {
    assertKey(key);
    await this.db.deleteChunks(key);
    let index = 0;
    let batch: Uint8Array[] = [];
    const stream = createReadStream(sourcePath, { highWaterMark: CHUNK_SIZE });
    try {
      // highWaterMark only caps the chunk size, so re-slice into exact CHUNK_SIZE pieces.
      let carry: Buffer = Buffer.alloc(0);
      const flush = async () => {
        if (batch.length === 0) return;
        await this.db.writeChunks(key, index, batch);
        index += batch.length;
        batch = [];
      };
      for await (const piece of stream as AsyncIterable<Buffer>) {
        carry = carry.length ? Buffer.concat([carry, piece]) : piece;
        while (carry.length >= CHUNK_SIZE) {
          batch.push(new Uint8Array(carry.subarray(0, CHUNK_SIZE)));
          carry = carry.subarray(CHUNK_SIZE);
          if (batch.length >= CHUNKS_PER_BATCH) await flush();
        }
      }
      if (carry.length) batch.push(new Uint8Array(carry));
      await flush();
    } catch (err) {
      await this.db.deleteChunks(key).catch(() => {});
      throw err;
    } finally {
      await unlink(sourcePath).catch(() => {});
    }
  }

  localPath(key: string) {
    assertKey(key);
    let promise = this.pending.get(key);
    if (!promise) {
      promise = this.materialize(key).finally(() => this.pending.delete(key));
      this.pending.set(key, promise);
    }
    return promise;
  }

  private async materialize(key: string) {
    const file = path.join(this.cacheDir, key);
    if (await exists(file)) return file;
    await mkdir(this.cacheDir, { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.part`;
    const out = createWriteStream(temp);
    let index = 0;
    try {
      for (;;) {
        const chunks = await this.db.readChunks(key, index, CHUNKS_PER_BATCH);
        for (const chunk of chunks) {
          if (!out.write(chunk)) await once(out, 'drain');
        }
        index += chunks.length;
        if (chunks.length < CHUNKS_PER_BATCH) break;
      }
      out.end();
      await once(out, 'finish');
      if (index === 0) {
        await unlink(temp).catch(() => {});
        throw Object.assign(new Error('File not found'), { status: 404 });
      }
      await rename(temp, file);
      return file;
    } catch (err) {
      out.destroy();
      await unlink(temp).catch(() => {});
      throw err;
    }
  }

  async remove(key: string) {
    assertKey(key);
    await this.db.deleteChunks(key);
    await rm(path.join(this.cacheDir, key), { force: true });
  }
}
