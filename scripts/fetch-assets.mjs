// Downloads pinned public Mirage model + Cactus WASM runtime v4.0.0 into public/vendor.
// Re-run safe: skips files whose sha256 already matches. Fails loudly on mismatch.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_REV = '3d03cee88c0acbe4e71b94b567ab14e6e55f40c9'; // Cactus-Compute/mirage commit
const RUNTIME_REV = '1a028f5a3972b67dd8d8752f882113d475e7ec4c'; // Cactus-Compute/cactus commit (runtime 4.0.0)
const RUNTIME = `https://huggingface.co/Cactus-Compute/cactus/resolve/${RUNTIME_REV}/releases/4.0.0/wasm`;
const MODEL = `https://huggingface.co/Cactus-Compute/mirage/resolve/${MODEL_REV}`;

export const ASSETS = [
  { url: `${RUNTIME}/cactus.js`, out: 'public/vendor/cactus.js', sha256: 'bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc' },
  { url: `${RUNTIME}/cactus.wasm`, out: 'public/vendor/cactus.wasm', sha256: '4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6' },
  { url: `${RUNTIME}/cactus.h`, out: 'public/vendor/cactus.h', sha256: 'facefca17a0d5e715bd92a8b0ea272c1ac34a20a798003b1e691c8fba5ace6e2' },
  { url: `${MODEL}/mirage.cact`, out: 'public/vendor/mirage.cact', sha256: '4249a0f7515272ff76b9414bec17d7e7daf84b15b66c7fb4f17fce1e66f9f237' },
  // Test-only fixture (official Mirage example photo). Never loaded by default UI, never in the Pages build.
  { fixture: true, url: 'https://cactuscompute.com/mirage/coco-231049.jpg', out: 'test/fixtures/coco-231049.jpg', sha256: '327de5cf31c479b7f4a5ca73b8b757f534f2e31ff6c452348f72aee86fb5b49b' },
];

export const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export async function fetchAssets({ fixture = true } = {}) {
  for (const a of ASSETS) {
    if (a.fixture && !fixture) continue;
    const out = join(root, a.out);
    if (existsSync(out)) {
      const cur = sha(await readFile(out));
      if (!a.sha256 || cur === a.sha256) { console.log(`ok    ${a.out}`); continue; }
    }
    process.stdout.write(`fetch ${a.url}\n`);
    const res = await fetch(a.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${a.url} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha(buf);
    if (a.sha256 && got !== a.sha256) throw new Error(`sha256 mismatch for ${a.out}: ${got}`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out + '.part', buf);
    await rename(out + '.part', out);
    console.log(`saved ${a.out} (${buf.length} bytes, sha256 ${got})`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fetchAssets({ fixture: !process.argv.includes('--no-fixture') });
}
