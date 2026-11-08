// End-to-end proof against a deployed (or locally served) build:
//   node scripts/pages-proof.mjs [URL] [--out DIR]
// URL defaults to serving ./dist locally at http://127.0.0.1:<port>/mirage-live-demo/.
// Checks: model download starts on page arrival with NO click, getUserMedia not called before the click,
// real progress + ready state shown, then >=2 real inference cycles, stop cleans up, no console errors,
// no failed requests, no requests to other origins.
// The camera is replaced by a synthetic MediaStream (a still photo drawn to a canvas) injected by this
// harness only — the site itself is unmodified. Detections come from the real model.
// Needs Google Chrome (CHROME_PATH to override) and playwright-core.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CHROME = process.env.CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');

/** Synthetic camera image: local test fixture if present (never deployed), else a generated pattern. */
function cameraImage() {
  const f = join(root, 'test/fixtures/coco-231049.jpg');
  return existsSync(f) ? `data:image/jpeg;base64,${readFileSync(f).toString('base64')}` : null;
}

export async function runProof(url, { outDir, serverLog = null, timeoutMs = 180000 } = {}) {
  const { chromium } = require('playwright-core');
  if (outDir) mkdirSync(outDir, { recursive: true });
  const origin = new URL(url).origin;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const r = { url, requests: [], failed: [], foreign: [], consoleErrors: [], statusSamples: [] };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 1100 } });
    // Harness-only fake camera + call counter. Runs before any page script.
    await ctx.addInitScript((img) => {
      const h = window.__proof = { gumCalls: 0, streams: [], status: [], t0: performance.now() };
      const fake = async () => {
        h.gumCalls++;
        const c = document.createElement('canvas');
        const g = c.getContext('2d');
        if (img) {
          const im = new Image(); im.src = img; await im.decode();
          c.width = im.naturalWidth; c.height = im.naturalHeight;
          h.draw = () => g.drawImage(im, 0, 0);
        } else {
          c.width = 480; c.height = 360;
          h.draw = () => { g.fillStyle = '#345'; g.fillRect(0, 0, 480, 360); g.fillStyle = '#c33'; g.fillRect(150, 90, 180, 180); };
        }
        h.draw(); h.timer = setInterval(h.draw, 50);
        const s = c.captureStream(20); h.streams.push(s); return s;
      };
      if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
      navigator.mediaDevices.getUserMedia = fake;
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.getElementById('status');
        const rec = () => h.status.push({ t: Math.round(performance.now() - h.t0), text: s.textContent,
          progress: (() => { const p = document.getElementById('model-progress'); return p ? { hidden: p.hidden, value: p.getAttribute('value'), max: p.max } : null; })() });
        rec(); new MutationObserver(rec).observe(s, { childList: true, characterData: true, subtree: true });
      });
    }, cameraImage());
    const page = await ctx.newPage();
    const t0 = Date.now();
    const onReq = (q) => {
      const u = q.url();
      if (u.startsWith('data:') || u.startsWith('blob:')) return;
      r.requests.push({ t: Date.now() - t0, url: u.slice(origin.length), type: q.resourceType() });
      if (!u.startsWith(origin)) r.foreign.push(u);
    };
    ctx.on('request', onReq);
    ctx.on('requestfailed', (q) => r.failed.push(`${q.url()} ${q.failure()?.errorText}`));
    ctx.on('response', (s) => { if (s.status() >= 400) r.failed.push(`${s.url()} HTTP ${s.status()}`); });
    page.on('console', (m) => { if (m.type() === 'error') r.consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => r.consoleErrors.push(String(e)));

    await page.goto(url);
    // --- Arrival: no click. Model must download and become ready on its own.
    await page.waitForFunction(() => /모델 준비 완료/.test(document.getElementById('status').textContent), null, { timeout: timeoutMs });
    r.readyAtMs = Date.now() - t0;
    r.gumCallsBeforeClick = await page.evaluate(() => window.__proof.gumCalls);
    r.statusBeforeClick = await page.locator('#status').innerText();
    r.progressHiddenWhenReady = await page.evaluate(() => document.getElementById('model-progress').hidden);
    r.placeholderVisibleBeforeClick = await page.locator('#placeholder').isVisible();
    r.modelRequestBeforeClick = r.requests.some((x) => x.url.endsWith('vendor/mirage.cact'));
    r.statusSamples = await page.evaluate(() => window.__proof.status);
    if (outDir) await page.screenshot({ path: join(outDir, 'pages-ready-before-click.png'), fullPage: true });

    // --- Click: camera (fake) starts, >=2 real inference cycles.
    const clickAt = Date.now() - t0;
    await page.getByRole('button', { name: '카메라 시작' }).click();
    await page.waitForFunction(() => /완료 ([2-9]|\d\d+)회/.test(document.getElementById('metrics').textContent), null, { timeout: timeoutMs });
    r.gumCallsAfterClick = await page.evaluate(() => window.__proof.gumCalls);
    r.metricsText = await page.locator('#metrics').innerText();
    r.detsText = await page.locator('#dets').innerText();
    if (outDir) await page.screenshot({ path: join(outDir, 'pages-detecting.png'), fullPage: true });
    r.modelRequestsAfterClick = r.requests.filter((x) => x.t >= clickAt && x.url.endsWith('vendor/mirage.cact')).length;

    // --- Stop: tracks ended, video detached, boxes gone.
    await page.getByRole('button', { name: '카메라 끄기' }).click();
    r.afterStop = await page.evaluate(() => ({
      tracks: window.__proof.streams.flatMap((s) => s.getTracks().map((t) => t.readyState)),
      srcObject: document.getElementById('video').srcObject === null ? null : 'attached',
      startVisible: !document.getElementById('btn-start').hidden,
      status: document.getElementById('status').textContent,
    }));
    await page.waitForTimeout(500);
  } finally {
    await browser.close();
  }
  if (serverLog) r.serverLog = [...serverLog];
  r.checks = {
    modelRequestedBeforeClick: r.modelRequestBeforeClick,
    readyBeforeClick: /모델 준비 완료/.test(r.statusBeforeClick),
    downloadProgressShown: r.statusSamples.some((s) => /다운로드 중… [\d.]+/.test(s.text)),
    getUserMediaNotCalledBeforeClick: r.gumCallsBeforeClick === 0,
    getUserMediaCalledOnceOnClick: r.gumCallsAfterClick === 1,
    placeholderBeforeClick: r.placeholderVisibleBeforeClick,
    atLeastTwoInferences: /완료 ([2-9]|\d\d+)회/.test(r.metricsText || ''),
    modelNotRefetchedOnClick: r.modelRequestsAfterClick === 0,
    stopEndedTracks: r.afterStop.tracks.length > 0 && r.afterStop.tracks.every((x) => x === 'ended'),
    stopDetachedVideo: r.afterStop.srcObject === null,
    noFailedRequests: r.failed.length === 0,
    noForeignRequests: r.foreign.length === 0,
    noConsoleErrors: r.consoleErrors.length === 0,
  };
  r.ok = Object.values(r.checks).every(Boolean);
  if (outDir) writeFileSync(join(outDir, 'pages-proof.json'), JSON.stringify(r, null, 2));
  return r;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const outDir = oi >= 0 ? args.splice(oi, 2)[1] : join(root, 'test/output');
  let url = args[0], server = null;
  const log = [];
  if (!url) {
    const { startServer } = await import('./server.mjs');
    server = await startServer({ port: 0, dist: join(root, 'dist'), base: '/mirage-live-demo/', log });
    url = `http://127.0.0.1:${server.address().port}/mirage-live-demo/`;
  }
  try {
    const r = await runProof(url, { outDir, serverLog: server ? log : null });
    console.log(JSON.stringify({ url, ok: r.ok, checks: r.checks, readyAtMs: r.readyAtMs, metrics: r.metricsText, dets: r.detsText,
      failed: r.failed, foreign: r.foreign, consoleErrors: r.consoleErrors }, null, 2));
    process.exitCode = r.ok ? 0 : 1;
  } finally { server?.close(); }
}
