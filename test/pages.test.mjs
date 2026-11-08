// Built GitHub Pages artifact (dist/) served under the exact project prefix /mirage-live-demo/.
// Proves eager model load on arrival (before any click, before getUserMedia), then real inference
// with a harness-injected synthetic camera. Same checks as `npm run proof:pages -- <deployed URL>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from '../scripts/build-pages.mjs';
import { startServer } from '../scripts/server.mjs';
import { runProof, CHROME } from '../scripts/pages-proof.mjs';

const root = new URL('..', import.meta.url).pathname;
const outDir = process.env.EVIDENCE_DIR || join(root, 'test', 'output');

test('pages build: dist contents, no fixture, licenses present', async () => {
  const m = await build();
  const paths = m.files.map((f) => f.path);
  for (const p of ['.nojekyll', 'index.html', 'worker.js', 'vendor/mirage.cact', 'vendor/cactus.wasm', 'vendor/cactus.js',
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/APACHE-2.0.txt', 'licenses/CACTUS-LICENSE.txt']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => /fixture|\.jpg$|cactus\.h$/.test(p)), 'no fixture / dev-only files');
  assert.ok(m.totalBytes > 20e6 && m.totalBytes < 26e6, `dist size ${m.totalBytes}`);
});

test('pages artifact under /mirage-live-demo/: eager model load before click, >=2 real inferences', { skip: !existsSync(CHROME) && 'Chrome not found' }, async (t) => {
  assert.ok(readdirSync(join(root, 'dist')).includes('index.html'), 'dist built by previous test');
  const log = [];
  const server = await startServer({ port: 0, dist: join(root, 'dist'), base: '/mirage-live-demo/', log });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/mirage-live-demo/`;
  const r = await runProof(url, { outDir, serverLog: log });
  t.diagnostic(JSON.stringify({ readyAtMs: r.readyAtMs, metrics: r.metricsText, dets: r.detsText }));
  assert.deepEqual(r.checks, Object.fromEntries(Object.keys(r.checks).map((k) => [k, true])), JSON.stringify({ failed: r.failed, foreign: r.foreign, consoleErrors: r.consoleErrors }));
  // Server-side view: the model was served before the user ever clicked (no getUserMedia yet at that point).
  assert.ok(r.serverLog.includes('/mirage-live-demo/vendor/mirage.cact'));
  assert.ok(r.serverLog.every((p) => p.startsWith('/mirage-live-demo/')), 'everything under the project prefix');
  // Content-Length known here, so a real byte percentage must have been shown at least once.
  assert.ok(r.statusSamples.some((s) => /다운로드 중… [\d.]+ \/ 21\.6 MB \(\d+%\)/.test(s.text)), JSON.stringify(r.statusSamples));
});
