// End-to-end in headless Chrome with a SYNTHETIC camera (?test-source=fixture: official public
// example photo played through canvas.captureStream) and REAL Mirage WASM inference. Never touches a real camera.
// Uses locally installed Google Chrome via playwright-core (set CHROME_PATH to override).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../scripts/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root = new URL('..', import.meta.url).pathname;
const outDir = process.env.EVIDENCE_DIR || join(root, 'test', 'output');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('live detection: continuous inference, overlay, single in-flight, stop/restart/pagehide stale guards', { skip: !existsSync(CHROME) && 'Chrome not found' }, async (t) => {
  mkdirSync(outDir, { recursive: true });
  const log = [];
  const server = await startServer({ port: 0, log });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(async () => { await browser.close(); server.close(); });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1100 } });
  const page = await ctx.newPage();
  const foreign = [];
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) foreign.push(r.url()); });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const S = () => page.evaluate(() => window.__mirageTest.state());
  const visible = (id) => page.evaluate((i) => { const n = document.getElementById(i); return getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0; }, id);

  await page.goto(base + '?test-source=fixture');
  assert.equal(await page.title(), 'Mirage 실시간 탐지');
  await page.locator('#synthetic-banner').waitFor({ state: 'visible' });
  assert.equal(await visible('placeholder'), true);
  // No upload / scan / save / segmentation UI.
  assert.equal(await page.locator('input[type=file], a[download], #btn-scan, #btn-save, #btn-rescan, .chip, #preview, #frozen').count(), 0);
  const buttons = await page.locator('button').allTextContents();
  assert.deepEqual(buttons.sort(), ['카메라 끄기', '카메라 시작'].sort());
  for (const word of ['스캔', 'PNG', '오려', '저장하기', '업로드', '마스크']) {
    assert.ok(!(await page.locator('body').innerText()).includes(word), `no "${word}" in UI`);
  }

  // 0) Eager model load: model is fetched and ready on arrival, before any click; camera untouched.
  await page.waitForFunction(() => window.__mirageTest.state().modelReady, null, { timeout: 90000 });
  assert.ok(log.includes('/vendor/mirage.cact'), 'model fetched before click');
  assert.ok(!log.includes('/test-fixtures/coco-231049.jpg'), 'camera source not opened before click');
  assert.match(await page.locator('#status').innerText(), /모델 준비 완료 \(21\.6 MB/);
  assert.equal(await visible('model-progress'), false, 'progress hidden once ready');
  const pre = await S();
  assert.equal(pre.running, false); assert.equal(pre.load.loaded, 21611043);
  await page.screenshot({ path: join(outDir, 'browser-ready-before-click.png'), fullPage: true });

  // 1) Start -> >=3 automatic completions with no further clicks.
  await page.getByRole('button', { name: '카메라 시작' }).click();
  await page.waitForFunction(() => window.__mirageTest.state().m.done >= 3, null, { timeout: 90000 });
  let s = await S();
  assert.equal(s.m.maxInflight, 1, 'never more than one frame in flight');
  assert.equal(s.workers, 1);
  assert.deepEqual(s.frame, [342, 512], 'model input = fixture size (<=640 longest side)');
  assert.ok(s.dets.some((d) => d.name === 'stop sign'), `stop sign in ${JSON.stringify(s.dets.map((d) => d.name))}`);
  const stopDrawn = s.drawn.find((d) => d.text.startsWith('stop sign '));
  assert.ok(stopDrawn, 'stop sign label drawn on overlay');
  assert.match(await page.locator('#dets').innerText(), /stop sign \d+%/);
  assert.match(await page.locator('#metrics').innerText(), /추론 \d+ms .*상자 갱신 [\d.]+회\/초/);

  // Box geometry: drawn box == letterboxed contain-rect mapping of the model bbox within the stage element.
  const geo = await page.evaluate(() => {
    const st = document.getElementById('stage').getBoundingClientRect();
    const v = document.getElementById('video');
    return { bw: st.width, bh: st.height, vw: v.videoWidth, vh: v.videoHeight };
  });
  const sc = Math.min(geo.bw / geo.vw, geo.bh / geo.vh);
  const rx = (geo.bw - geo.vw * sc) / 2;
  const stopDet = s.dets.find((d) => d.name === 'stop sign');
  assert.ok(Math.abs(stopDrawn.box.x - (rx + stopDet.bbox[0] / 1000 * geo.vw * sc)) < 0.5, 'box x aligned with letterboxed video');
  for (const d of s.drawn) {
    assert.ok(d.label.x >= 0 && d.label.y >= 0 && d.label.x + d.label.w <= geo.bw + 0.5 && d.label.y + d.label.h <= geo.bh + 0.5, `label in view ${JSON.stringify(d.label)}`);
  }

  // 2) Video keeps presenting frames while inference runs (not paused / frozen / swapped for a still).
  const vid = await page.evaluate(() => new Promise((res) => {
    const v = document.getElementById('video'); const t0 = v.currentTime; let frames = 0; const s0 = performance.now();
    const cb = () => { frames++; if (performance.now() - s0 < 2000) v.requestVideoFrameCallback(cb); else res({ frames, paused: v.paused, advanced: v.currentTime - t0, hidden: v.hidden }); };
    v.requestVideoFrameCallback(cb);
  }));
  assert.equal(vid.paused, false); assert.equal(vid.hidden, false);
  assert.ok(vid.frames >= 10 && vid.advanced > 1, `video frames in 2s: ${JSON.stringify(vid)}`);
  s = await S();
  const metrics = {
    completions: s.m.done, describeMs: s.m.ms.map(Math.round), roundTripMs: s.m.rtt.map(Math.round),
    videoFramesIn2s: vid.frames, videoAdvancedSec: +vid.advanced.toFixed(2), maxInflight: s.m.maxInflight,
    modelInput: s.frame, videoSize: s.video, detections: s.dets,
    metricsText: await page.locator('#metrics').innerText(),
  };
  await page.screenshot({ path: join(outDir, 'browser-detection.png'), fullPage: true });

  // 3) Stop while a frame is in flight: tracks end, boxes cleared, late result dropped (no resurrection).
  await page.waitForFunction(() => window.__mirageTest.state().inflight, null, { timeout: 30000 });
  const doneBeforeStop = (await S()).m.done;
  await page.getByRole('button', { name: '카메라 끄기' }).click();
  const tracks = await page.evaluate(() => window.__mirageTest.lastStream.getTracks().map((x) => x.readyState));
  assert.ok(tracks.length > 0 && tracks.every((x) => x === 'ended'), `tracks ${tracks}`);
  assert.equal(await page.evaluate(() => document.getElementById('video').srcObject), null);
  await page.waitForFunction(() => !window.__mirageTest.state().inflight, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  s = await S();
  assert.equal(s.m.done, doneBeforeStop, 'late result not applied');
  assert.ok(s.m.dropped >= 1, 'stale result counted as dropped');
  assert.deepEqual(s.dets, []); assert.deepEqual(s.drawn, []);
  assert.equal(await visible('dets'), false); assert.equal(await visible('placeholder'), true);
  const sentAfterStop = s.m.sent;
  await page.waitForTimeout(2500);
  assert.equal((await S()).m.sent, sentAfterStop, 'no inference loop while stopped');

  // 4) Restart (twice quickly): single worker, still at most one in flight, inference resumes.
  await page.getByRole('button', { name: '카메라 시작' }).click();
  await page.getByRole('button', { name: '카메라 끄기' }).click();
  await page.getByRole('button', { name: '카메라 시작' }).click();
  const doneAtRestart = (await S()).m.done;
  await page.waitForFunction((n) => window.__mirageTest.state().m.done >= n + 2, doneAtRestart, { timeout: 60000 });
  s = await S();
  assert.equal(s.m.maxInflight, 1); assert.equal(s.workers, 1);
  // Rate check: completions over a window can't exceed what one serial loop allows.
  const w0 = s.m.done; const t0 = Date.now();
  await page.waitForTimeout(4000);
  s = await S();
  const perSec = (s.m.done - w0) / ((Date.now() - t0) / 1000);
  const avgRtt = s.m.rtt.reduce((a, b) => a + b, 0) / s.m.rtt.length;
  assert.ok(perSec <= 1000 / avgRtt * 1.6 + 0.5, `single loop rate ${perSec.toFixed(2)}/s vs rtt ${avgRtt.toFixed(0)}ms`);
  metrics.updatesPerSecObserved = +perSec.toFixed(2);
  metrics.avgRoundTripMs = Math.round(avgRtt);

  // 5) Pending camera acquisition invalidated by stop and by pagehide: returned stream is stopped, never attached.
  await page.getByRole('button', { name: '카메라 끄기' }).click();
  for (const how of ['stop', 'pagehide']) {
    await page.evaluate(() => { const t = window.__mirageTest; t.cameraGate = new Promise((r) => { t.release = r; }); });
    await page.getByRole('button', { name: '카메라 시작' }).click();
    if (how === 'stop') await page.getByRole('button', { name: '카메라 끄기' }).click();
    else await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.evaluate(() => { const t = window.__mirageTest; t.cameraGate = null; t.release(); });
    await page.waitForFunction((n) => window.__mirageTest.staleStreams.length >= n, how === 'stop' ? 1 : 2, { timeout: 10000 });
    const stale = await page.evaluate(() => window.__mirageTest.staleStreams.at(-1).getTracks().map((x) => x.readyState));
    assert.ok(stale.every((x) => x === 'ended'), `${how}: stale stream stopped`);
    assert.equal(await page.evaluate(() => document.getElementById('video').srcObject), null, `${how}: not attached`);
    assert.equal((await S()).running, false);
    assert.equal(await page.getByRole('button', { name: '카메라 시작' }).isVisible(), true);
  }

  // 6) Mobile 390px: live detection screenshot, no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '카메라 시작' }).click();
  const d0 = (await S()).m.done;
  await page.waitForFunction((n) => window.__mirageTest.state().m.done >= n + 1, d0, { timeout: 60000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'no horizontal overflow');
  s = await S();
  for (const d of s.drawn) assert.ok(d.label.x >= 0 && d.label.x + d.label.w <= 390, 'mobile label in view');
  await page.screenshot({ path: join(outDir, 'browser-detection-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '카메라 끄기' }).click();

  assert.deepEqual(foreign, [], 'no requests leave 127.0.0.1');
  assert.deepEqual(consoleErrors, [], 'no console errors');
  metrics.foreignRequests = foreign;
  metrics.note = 'Headless Chrome, single-thread WASM, Apple Silicon host, synthetic canvas camera; not a phone, not NPU.';
  writeFileSync(join(outDir, 'browser-metrics.json'), JSON.stringify(metrics, null, 2));
  t.diagnostic(JSON.stringify({ describeMs: metrics.describeMs, updatesPerSec: metrics.updatesPerSecObserved, videoFramesIn2s: vid.frames }));
});
