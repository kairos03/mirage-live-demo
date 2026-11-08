// Builds the static GitHub Pages site into dist/: app files, pinned+hash-checked model/runtime, license docs.
// Never includes the test fixture. All URLs in the app are relative, so dist/ works under any sub-path
// (e.g. /mirage-live-demo/). Prints a manifest (path, bytes, sha256); MANIFEST_OUT=<file> also writes it.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS, sha } from './fetch-assets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const APP = ['index.html', 'styles.css', 'app.js', 'detect.js', 'engine.js', 'worker.js'];
const VENDOR = ['cactus.js', 'cactus.wasm', 'mirage.cact']; // cactus.h is a dev reference only
const DOCS = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/APACHE-2.0.txt', 'licenses/CACTUS-LICENSE.txt'];

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

export async function build() {
  for (const name of VENDOR) {
    const a = ASSETS.find((x) => x.out === `public/vendor/${name}`);
    const got = sha(await readFile(join(root, a.out)).catch(() => {
      throw new Error(`missing ${a.out} — run: npm run fetch-assets -- --no-fixture`);
    }));
    if (got !== a.sha256) throw new Error(`sha256 mismatch for ${a.out}: ${got}`);
  }
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, 'vendor'), { recursive: true });
  for (const f of APP) await cp(join(root, 'public', f), join(dist, f));
  for (const f of VENDOR) await cp(join(root, 'public/vendor', f), join(dist, 'vendor', f));
  for (const f of DOCS) await cp(join(root, f), join(dist, f), { recursive: true });
  await writeFile(join(dist, '.nojekyll'), '');

  // Guards: relative URLs only, no test-only fixture shipped.
  for (const f of ['index.html', 'app.js', 'worker.js']) {
    const s = await readFile(join(dist, f), 'utf8');
    if (/(?:src|href)="\/(?!\/)|new Worker\('\/|importScripts\('\/|fetch\('\//.test(s)) throw new Error(`absolute URL in ${f}`);
  }
  const files = (await walk(dist)).map((p) => relative(dist, p)).sort();
  if (files.some((f) => /fixture|\.jpg$|\.png$/.test(f))) throw new Error('test fixture leaked into dist');

  const manifest = [];
  for (const f of files) {
    const buf = await readFile(join(dist, f));
    const src = f.startsWith('vendor/') ? join(root, 'public', f) : APP.includes(f) ? join(root, 'public', f) : join(root, f);
    const srcSha = f === '.nojekyll' ? sha(buf) : sha(await readFile(src));
    if (srcSha !== sha(buf)) throw new Error(`dist/source mismatch: ${f}`);
    manifest.push({ path: f, bytes: buf.length, sha256: sha(buf) });
  }
  const total = (await Promise.all(files.map((f) => stat(join(dist, f))))).reduce((n, s) => n + s.size, 0);
  return { files: manifest, totalBytes: total };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = await build();
  const json = JSON.stringify(m, null, 2);
  if (process.env.MANIFEST_OUT) await writeFile(process.env.MANIFEST_OUT, json + '\n');
  for (const f of m.files) console.log(`${String(f.bytes).padStart(10)}  ${f.sha256.slice(0, 16)}  ${f.path}`);
  console.log(`total ${m.totalBytes} bytes (${(m.totalBytes / 1e6).toFixed(1)} MB) in ${m.files.length} files -> dist/`);
}
