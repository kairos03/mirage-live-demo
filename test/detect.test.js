// Unit tests for live-overlay geometry and output validation (pure helpers in public/detect.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/detect.js');

test('frameSize bounds longest side to 640, keeps aspect, never upscales', () => {
  assert.deepEqual(D.frameSize(1280, 720), { width: 640, height: 360 });
  assert.deepEqual(D.frameSize(720, 1280), { width: 360, height: 640 });
  assert.deepEqual(D.frameSize(342, 512), { width: 342, height: 512 });
  assert.equal(D.frameSize(0, 480), null);
});

test('containRect letterboxes (pillarbox and letterbox) and mapBox scales 0..1000 bbox', () => {
  // 4:3 video in 400x400 element -> 400x300 with 50px bars top/bottom.
  const r = D.containRect(640, 480, 400, 400);
  assert.deepEqual(r, { x: 0, y: 50, w: 400, h: 300 });
  assert.deepEqual(D.mapBox([0, 0, 1000, 1000], r), { x: 0, y: 50, w: 400, h: 300 });
  assert.deepEqual(D.mapBox([250, 500, 750, 1000], r), { x: 100, y: 200, w: 200, h: 150 });
  // Portrait 342x512 fixture in a 4:3 stage of 800x600 -> pillarbox.
  const p = D.containRect(342, 512, 800, 600);
  assert.ok(Math.abs(p.w - 342 * 600 / 512) < 1e-9 && p.h === 600 && Math.abs(p.x - (800 - p.w) / 2) < 1e-9 && p.y === 0);
  // Same box, resized element: relative position within the video rect is invariant.
  const a = D.mapBox([378, 238, 644, 437], p);
  const q = D.containRect(342, 512, 390, 520);
  const b = D.mapBox([378, 238, 644, 437], q);
  assert.ok(Math.abs((a.x - p.x) / p.w - (b.x - q.x) / q.w) < 1e-9);
  assert.ok(Math.abs((a.y - p.y) / p.h - (b.y - q.y) / q.h) < 1e-9);
  assert.equal(D.containRect(0, 0, 10, 10), null);
});

test('parseDetections keeps finite ordered boxes, clamps 0..1000, drops invalid', () => {
  const json = JSON.stringify({ objects: [
    { name: 'stop sign', bbox: [378, 238, 644, 437], score: 0.646 },
    { name: 'swapped', bbox: [600, 500, 100, 50], score: 0.5 },
    { name: 'outside', bbox: [-50, -10, 1200, 1500], score: 2 },
    { name: 'nan', bbox: [0, 0, NaN, 10], score: 0.9 },
    { name: 'str', bbox: ['1', 2, 3, 4] },
    { name: 'zero', bbox: [10, 10, 10, 50], score: 0.9 },
    { name: 'short', bbox: [1, 2, 3] },
    { name: '', bbox: [0, 0, 10, 10] },
    null,
  ] });
  const d = D.parseDetections(json);
  assert.deepEqual(d.map((x) => x.name), ['stop sign', 'swapped', 'outside', '물체']);
  assert.deepEqual(d[1].bbox, [100, 50, 600, 500]);
  assert.deepEqual(d[2].bbox, [0, 0, 1000, 1000]);
  assert.equal(d[2].score, 1);
  assert.equal(d[3].score, null);
  assert.equal(D.label(d[0]), 'stop sign 65%');
  assert.equal(D.label(d[3]), '물체');
  assert.deepEqual(D.parseDetections('{"objects":[]}'), []);
  assert.deepEqual(D.parseDetections('{}'), []);
  assert.throws(() => D.parseDetections('not json'), /not JSON/);
  assert.throws(() => D.parseDetections('{"error":"boom"}'), /boom/);
});

test('labelPos sits above the box when possible and is clamped into view', () => {
  assert.deepEqual(D.labelPos({ x: 50, y: 100, w: 40, h: 40 }, 80, 20, 400, 300), { x: 50, y: 80 });
  // Box at top edge: label moves inside the box.
  assert.deepEqual(D.labelPos({ x: 50, y: 5, w: 40, h: 40 }, 80, 20, 400, 300), { x: 50, y: 5 });
  // Box at right edge: label shifted left to stay visible.
  assert.deepEqual(D.labelPos({ x: 380, y: 100, w: 20, h: 20 }, 80, 20, 400, 300), { x: 320, y: 80 });
  // Box at bottom-left beyond view.
  assert.deepEqual(D.labelPos({ x: -10, y: 320, w: 20, h: 20 }, 80, 20, 400, 300), { x: 0, y: 280 });
});
