import { cp, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pdfjsDir = path.join(rootDir, 'node_modules', 'pdfjs-dist');
// Runtime assets pdf.js fetches on demand (CJK fonts, standard fonts, image decoders, colour profiles).
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

const MIME: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.icc': 'application/vnd.iccprofile',
};

/** Serves pdf.js runtime assets at /pdfjs/* in dev and copies them into the build output. */
function pdfjsAssets(): Plugin {
  let outDir = '';
  return {
    name: 'pdfjs-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', async (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const [dir] = rel.split('/');
        const file = path.join(pdfjsDir, rel);
        if (!PDFJS_ASSET_DIRS.includes(dir) || !file.startsWith(pdfjsDir + path.sep)) return next();
        try {
          if (!(await stat(file)).isFile()) return next();
          res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
          createReadStream(file).pipe(res);
        } catch {
          next();
        }
      });
    },
    async closeBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        await cp(path.join(pdfjsDir, dir), path.join(outDir, 'pdfjs', dir), { recursive: true });
      }
    },
  };
}

const serverPort = Number(process.env.PORT ?? 3000);
const backend = `http://localhost:${serverPort}`;

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  plugins: [react(), pdfjsAssets()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/auth': backend,
      '/healthz': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
});
