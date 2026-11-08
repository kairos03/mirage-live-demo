/*
 * Thin wrapper over the published Cactus v4.0.0 WASM C ABI (vendor/cactus.h):
 *   int cactus_load(const unsigned char* cact, unsigned long long n);
 *   int cactus_models(void);
 *   const char* cactus_last_error(void);
 *   int cactus_describe(const unsigned char* rgb, int width, int height,
 *                       const char* options, const char* language, const char* keywords,
 *                       char* out, int out_capacity);
 * Classic script (global `MirageEngine`) for the worker, require()-able from Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MirageEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CACTUS_VISION = 4;
  const OUT_CAPACITY = 1 << 20; // bbox/score/name JSON only (no masks)
  // Only objects with bbox + score; Mirage still returns `name`. No mask requested.
  const DESCRIBE_OPTIONS = { sections: ['objects'], fields: ['bbox', 'score'] };

  async function create(createCactus, cactBytes, moduleArg = {}) {
    const M = await createCactus(moduleArg);
    const enc = new TextEncoder();
    const lastError = () => M.UTF8ToString(M._cactus_last_error());
    const cstr = (s) => {
      const b = enc.encode(s);
      const p = M._malloc(b.length + 1);
      M.HEAPU8.set(b, p);
      M.HEAPU8[p + b.length] = 0;
      return p;
    };

    const cactPtr = M._malloc(cactBytes.byteLength);
    M.HEAPU8.set(cactBytes, cactPtr);
    const rc = M._cactus_load(cactPtr, BigInt(cactBytes.byteLength));
    if (rc !== 0) throw new Error(`cactus_load failed (${rc}): ${lastError()}`);
    if (!(M._cactus_models() & CACTUS_VISION)) throw new Error('loaded model has no vision capability');

    const outPtr = M._malloc(OUT_CAPACITY);
    const optPtr = cstr(JSON.stringify(DESCRIBE_OPTIONS));
    const emptyPtr = cstr('');

    /** rgb: Uint8Array of width*height*3 (row-major RGB). Returns { json, ms }. */
    function describe(rgb, width, height) {
      if (rgb.length !== width * height * 3) throw new Error('rgb buffer size mismatch');
      const rgbPtr = M._malloc(rgb.length);
      try {
        M.HEAPU8.set(rgb, rgbPtr);
        M.HEAPU8[outPtr] = 0;
        const t0 = performance.now();
        const n = M._cactus_describe(rgbPtr, width, height, optPtr, emptyPtr, emptyPtr, outPtr, OUT_CAPACITY);
        const ms = performance.now() - t0;
        if (n < 0) throw new Error(`cactus_describe failed (${n}): ${lastError()}`);
        return { json: M.UTF8ToString(outPtr), ms };
      } finally {
        M._free(rgbPtr);
      }
    }

    return { describe, options: DESCRIBE_OPTIONS };
  }

  /** RGBA (ImageData.data) -> packed RGB. */
  function rgbaToRgb(rgba) {
    const n = rgba.length / 4;
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return rgb;
  }

  return { create, rgbaToRgb, DESCRIBE_OPTIONS };
});
