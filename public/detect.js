/*
 * Pure helpers for live detection overlay (no DOM). Classic script (global `MirageDetect`), require()-able from Node.
 * Mirage bbox = [x1, y1, x2, y2] in 0..1000 space of the frame that was sent to the model.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MirageDetect = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Model input size: keep aspect, longest side <= maxSide (never upscale). */
  function frameSize(vw, vh, maxSide = 640) {
    if (!(vw > 0 && vh > 0)) return null;
    const s = Math.min(1, maxSide / Math.max(vw, vh));
    return { width: Math.max(1, Math.round(vw * s)), height: Math.max(1, Math.round(vh * s)) };
  }

  /** Validate + normalize model JSON into [{ name, score, bbox:[x1,y1,x2,y2] }] (0..1000, ordered, non-empty). */
  function parseDetections(json) {
    let r;
    try { r = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new Error('model output is not JSON'); }
    if (r && r.error) throw new Error(`model error: ${r.error}`);
    if (!r || !Array.isArray(r.objects)) return [];
    const out = [];
    for (const o of r.objects) {
      if (!o || !Array.isArray(o.bbox) || o.bbox.length !== 4) continue;
      if (!o.bbox.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      const c = (v) => Math.min(1000, Math.max(0, v));
      const x1 = c(Math.min(o.bbox[0], o.bbox[2])), x2 = c(Math.max(o.bbox[0], o.bbox[2]));
      const y1 = c(Math.min(o.bbox[1], o.bbox[3])), y2 = c(Math.max(o.bbox[1], o.bbox[3]));
      if (x2 - x1 <= 0 || y2 - y1 <= 0) continue;
      const score = typeof o.score === 'number' && Number.isFinite(o.score) ? Math.min(1, Math.max(0, o.score)) : null;
      const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : '물체';
      out.push({ name, score, bbox: [x1, y1, x2, y2] });
    }
    return out;
  }

  /** Rect where an object-fit:contain video of srcW x srcH lands inside a boxW x boxH element (letterbox). */
  function containRect(srcW, srcH, boxW, boxH) {
    if (!(srcW > 0 && srcH > 0 && boxW > 0 && boxH > 0)) return null;
    const s = Math.min(boxW / srcW, boxH / srcH);
    const w = srcW * s, h = srcH * s;
    return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
  }

  /** Map a 0..1000 bbox into element pixels using the contain rect. */
  function mapBox(bbox, rect) {
    return {
      x: rect.x + (bbox[0] / 1000) * rect.w, y: rect.y + (bbox[1] / 1000) * rect.h,
      w: ((bbox[2] - bbox[0]) / 1000) * rect.w, h: ((bbox[3] - bbox[1]) / 1000) * rect.h,
    };
  }

  /** Label position: above box if room, else inside top; clamped into [0, boxW-labelW] x [0, boxH-labelH]. */
  function labelPos(box, labelW, labelH, boxW, boxH) {
    let y = box.y - labelH;
    if (y < 0) y = box.y;
    const x = Math.min(Math.max(0, box.x), Math.max(0, boxW - labelW));
    y = Math.min(Math.max(0, y), Math.max(0, boxH - labelH));
    return { x, y };
  }

  const label = (d) => (d.score == null ? d.name : `${d.name} ${Math.round(d.score * 100)}%`);

  return { frameSize, parseDetections, containRect, mapBox, labelPos, label };
});
