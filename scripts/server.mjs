// Local-only static server. Binds 127.0.0.1 (getUserMedia treats it as a secure context).
// Dev: serves public/ (+ test fixture, license docs). `--dist`: serves the built dist/ under BASE_PATH,
// mimicking GitHub Pages project URLs (https://<user>.github.io/mirage-live-demo/).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEV_MOUNTS = [
  ['/test-fixtures/', join(root, 'test', 'fixtures')], // test-only fixture, used with ?test-source=fixture
  ['/licenses/', join(root, 'licenses')],
  ['/THIRD_PARTY_NOTICES.md', join(root, 'THIRD_PARTY_NOTICES.md')],
  ['/', join(root, 'public')],
];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.cact': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png', '.h': 'text/plain',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
};
// No third-party origins: page, worker, wasm and model are all same-origin.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; " +
  "img-src 'self' blob: data:; media-src 'self' blob: mediastream:; style-src 'self'; object-src 'none'; base-uri 'none'";

/** dist: serve that directory only, under `base` (e.g. '/mirage-live-demo/'); default: dev mounts at '/'. */
export function startServer({ port = 5173, host = '127.0.0.1', dist = null, base = '/', log = null } = {}) {
  const mounts = dist ? [[base, dist]] : DEV_MOUNTS;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      if (log) log.push(p);
      if (p.endsWith('/')) p += 'index.html';
      const hit = mounts.find(([m]) => p.startsWith(m));
      if (!hit) throw new Error('outside base');
      const [prefix, dir] = hit;
      const file = prefix.endsWith('/') ? normalize(join(dir, p.slice(prefix.length))) : (p === prefix ? dir : '');
      if (prefix.endsWith('/') && !file.startsWith(dir + sep)) { res.writeHead(403).end(); return; }
      if (!(await stat(file)).isFile()) throw new Error('not file');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Content-Length': body.length,
        'Content-Security-Policy': CSP,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5173;
  const distMode = process.argv.includes('--dist');
  const base = process.env.BASE_PATH || '/mirage-live-demo/';
  const s = distMode ? await startServer({ port, dist: join(root, 'dist'), base }) : await startServer({ port });
  console.log(`Mirage live detection: http://127.0.0.1:${s.address().port}${distMode ? base : '/'}`);
}
