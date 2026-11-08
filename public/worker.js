/* Inference worker: owns the WASM runtime so the camera video stays smooth. Handles one frame at a time. */
importScripts('vendor/cactus.js', 'engine.js');

let enginePromise = null;

/** Fetches the model, posting real byte counts. `total` only when Content-Length is the decoded size. */
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model fetch HTTP ${res.status}`);
  const len = Number(res.headers.get('Content-Length'));
  const total = len > 0 && !res.headers.get('Content-Encoding') ? len : 0;
  const report = (loaded) => self.postMessage({ type: 'progress', phase: 'download', loaded, total: loaded <= total ? total : 0 });
  if (!res.body) { const b = new Uint8Array(await res.arrayBuffer()); report(b.length); return b; }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0, last = 0;
  report(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = performance.now();
    if (now - last > 100) { last = now; report(loaded); }
  }
  report(loaded);
  if (total && loaded !== total) throw new Error(`model truncated (${loaded}/${total} bytes)`);
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return bytes;
}

function init() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const t0 = performance.now();
      const bytes = await download('vendor/mirage.cact');
      self.postMessage({ type: 'progress', phase: 'runtime' });
      // Published cactus.js has no locateFile hook (resolves wasm next to worker.js), so pass bytes directly.
      const wasm = await fetch('vendor/cactus.wasm');
      if (!wasm.ok) throw new Error(`runtime fetch HTTP ${wasm.status}`);
      const engine = await MirageEngine.create(createCactus, bytes, { wasmBinary: await wasm.arrayBuffer() });
      return { engine, loadMs: performance.now() - t0 };
    })();
    enginePromise.catch(() => { enginePromise = null; }); // allow retry after init failure
  }
  return enginePromise;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      const { loadMs } = await init();
      self.postMessage({ type: 'ready', loadMs });
    } else if (msg.type === 'detect') {
      const { engine } = await init();
      const rgb = MirageEngine.rgbaToRgb(new Uint8ClampedArray(msg.rgba));
      const { json, ms } = engine.describe(rgb, msg.width, msg.height);
      self.postMessage({ type: 'result', id: msg.id, json, ms });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, stage: msg.type, message: String(err && err.message || err) });
  }
};
