import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { Auth, UserCache } from './auth.js';
import { apiRouter } from './api.js';
import { Dictionary } from './dictionary.js';
import { RoomManager, UserError, type IO } from './rooms.js';
import { setupSockets } from './sockets.js';
import type { BookStorage } from './storage.js';

export interface AppDeps {
  config: Config;
  db: Database;
  storage: BookStorage;
}

export interface App {
  http: HttpServer;
  io: IO;
  rooms: RoomManager;
  close(): Promise<void>;
}

/** Rejects cross-site form posts: browsers can't add custom headers cross-origin without CORS. */
function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get('x-requested-with') !== 'reading-room') {
    return res.status(403).json({ error: 'Missing request header.' });
  }
  next();
}

export function createApp({ config, db, storage }: AppDeps): App {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          // pdf.js decodes some images with WebAssembly.
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          // EPUB styles/fonts/images are loaded through blob: URLs inside a sandboxed iframe.
          styleSrc: ["'self'", "'unsafe-inline'", 'blob:'],
          imgSrc: ["'self'", 'data:', 'blob:', 'https://cdn.discordapp.com'],
          fontSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'blob:', 'data:'],
          workerSrc: ["'self'", 'blob:'],
          frameSrc: ["'self'", 'blob:'],
          childSrc: ["'self'", 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.secureCookies ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  const users = new UserCache(db, config.adminUserIds);
  const dictionary = new Dictionary(config.dictionary, db);
  const auth = new Auth(config, users);
  const http = createServer(app);
  const io: IO = new Server(http, {
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });
  const rooms = new RoomManager({ io, db, users, storage });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(express.json({ limit: '32kb' }));
  app.use(auth.middleware());
  app.use(['/api', '/auth'], csrfGuard);
  app.use('/auth', auth.router());
  app.use('/api', apiRouter({ config, db, storage, rooms, users, dictionary }));

  setupSockets({ io, auth, db, rooms });

  // Serve the built React app.
  const indexHtml = path.join(config.clientDir, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(
      express.static(config.clientDir, {
        index: false,
        setHeaders(res, file) {
          if (file.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
          }
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== 'GET' || !req.accepts('html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  } else if (config.isProduction) {
    console.warn(`[app] No client build found at ${config.clientDir}. Run "npm run build".`);
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? (err instanceof UserError ? 400 : 500);
    if (status >= 500) console.error('[http]', err);
    if (res.headersSent) return;
    res.status(status).json({
      error: err instanceof UserError ? err.message : status === 404 ? 'Not found.' : 'Something went wrong.',
    });
  });

  return {
    http,
    io,
    rooms,
    async close() {
      await rooms.flushAll();
      io.disconnectSockets(true);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
