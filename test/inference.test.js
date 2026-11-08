// Real Mirage WASM inference on the official public example photo (test fixture, not product input).
// Same options as the live UI: objects with bbox + score only (no mask). Writes artifacts to test/output (or $EVIDENCE_DIR).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jpeg = require('jpeg-js');
const Engine = require('../public/engine.js');
const D = require('../public/detect.js');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'public', 'vendor');
const outDir = process.env.EVIDENCE_DIR || path.join(root, 'test', 'output');

test('real Mirage detection: bbox/score/name, no mask, repeated runs', async (t) => {
  assert.deepEqual(Engine.DESCRIBE_OPTIONS, { sections: ['objects'], fields: ['bbox', 'score'] });
  const createCactus = require(path.join(vendor, 'cactus.js'));
  const engine = await Engine.create(createCactus, fs.readFileSync(path.join(vendor, 'mirage.cact')),
    { locateFile: (p) => path.join(vendor, p) });
  const img = jpeg.decode(fs.readFileSync(path.join(root, 'test/fixtures/coco-231049.jpg')), { useTArray: true });
  const rgb = Engine.rgbaToRgb(img.data);
  const runs = [];
  let json;
  for (let i = 0; i < 3; i++) { const r = engine.describe(rgb, img.width, img.height); json = r.json; runs.push(Math.round(r.ms)); }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'mirage-output-detect.json'), json);
  t.diagnostic(`node WASM describe ${img.width}x${img.height}: ${runs.join(', ')} ms (not NPU)`);
  const raw = JSON.parse(json).objects;
  assert.ok(raw.length >= 1);
  for (const o of raw) assert.equal(o.mask, undefined, 'mask must not be requested/returned');
  const d = D.parseDetections(json);
  assert.equal(d.length, raw.length, 'all real boxes valid');
  const stop = d.filter((x) => x.name === 'stop sign');
  assert.equal(stop.length, 1, 'stop sign detected');
  // Stop sign occupies upper-middle of the fixture (x ~38-64%, y ~24-44%).
  const [x1, y1, x2, y2] = stop[0].bbox;
  assert.ok(x1 > 300 && x2 < 700 && y1 > 150 && y2 < 500, `stop sign bbox ${stop[0].bbox}`);
  fs.writeFileSync(path.join(outDir, 'node-metrics.json'), JSON.stringify({ size: [img.width, img.height], ms: runs, objects: d }, null, 2));
});
