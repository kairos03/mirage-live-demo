/* Live detection overlay. Inference runs in worker.js, at most one frame in flight; the video is never paused for it. */
(() => {
  'use strict';
  const D = window.MirageDetect;
  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('stage'), video: $('video'), overlay: $('overlay'), placeholder: $('placeholder'),
    start: $('btn-start'), stop: $('btn-stop'), status: $('status'), metrics: $('metrics'), dets: $('dets'),
    error: $('error'), banner: $('synthetic-banner'), progress: $('model-progress'),
  };
  const MAX_SIDE = 640;      // model input longest side
  const EXPIRE_MS = 4000;    // clear boxes if no fresh result for this long
  const params = new URLSearchParams(location.search);
  // Test-only synthetic camera; local dev server only (the fixture is never deployed).
  const SYNTHETIC = params.get('test-source') === 'fixture' && ['127.0.0.1', 'localhost'].includes(location.hostname);

  const st = {
    worker: null, modelReady: false, initPending: false,
    load: { phase: 'start', loaded: 0, total: 0, t0: performance.now(), ms: 0 }, // model load status (also exposed for tests)
    gen: 0,                  // bumped on start/stop/pagehide; results/streams from older gens are dropped
    running: false, stream: null, synthetic: null,
    seq: 0, inflight: null,  // { id, gen, sentAt } — the only frame the worker is processing
    dets: [], detAt: 0, frameW: 0, frameH: 0,
    expireTimer: 0, nextTimer: 0,
    m: { sent: 0, done: 0, dropped: 0, outstanding: 0, ms: [], rtt: [], times: [], maxInflight: 0 },
  };
  const grab = document.createElement('canvas');
  const grabCtx = grab.getContext('2d', { willReadFrequently: true });

  const show = (node, on) => { node.hidden = !on; };
  const setStatus = (t) => { el.status.textContent = t; };
  function setError(t) { el.error.textContent = t || ''; show(el.error, !!t); }
  const MB = (n) => (n / 1e6).toFixed(1);

  /** Model status text while the camera is off. Byte counts come from the worker's real download. */
  function loadText() {
    const l = st.load;
    if (st.modelReady) return `모델 준비 완료 (${MB(l.loaded)} MB · ${(l.ms / 1000).toFixed(1)}초) — 카메라를 켜면 바로 탐지해요.`;
    if (l.phase === 'download') {
      return l.total ? `모델 다운로드 중… ${MB(l.loaded)} / ${MB(l.total)} MB (${Math.floor(l.loaded / l.total * 100)}%)`
        : `모델 다운로드 중… ${MB(l.loaded)} MB 받음 (약 21.6 MB)`;
    }
    if (l.phase === 'runtime') return `모델 받음 (${MB(l.loaded)} MB) · 런타임 초기화 중…`;
    if (l.phase === 'error') return '모델을 불러오지 못했어요.';
    return '모델 불러오는 중… (약 21.6 MB)';
  }
  function renderLoad() {
    const l = st.load, p = el.progress;
    show(p, !st.modelReady && l.phase !== 'error');
    if (l.phase === 'download' && l.total) { p.max = l.total; p.value = l.loaded; }
    else if (l.phase === 'runtime') { p.max = 1; p.value = 1; }
    else p.removeAttribute('value'); // indeterminate: size unknown, no invented percentage
    if (!st.running) setStatus(loadText());
    else if (!st.modelReady) setStatus(`${loadText()} 준비되면 자동으로 탐지해요.`);
  }

  // ---------- worker (single instance) ----------
  function ensureWorker() {
    if (st.worker) {
      if (!st.modelReady && !st.initPending) {
        st.initPending = true;
        st.load = { phase: 'start', loaded: 0, total: 0, t0: performance.now(), ms: 0 };
        renderLoad();
        st.worker.postMessage({ type: 'init' });
      }
      return;
    }
    const w = new Worker('worker.js');
    st.worker = w;
    w.onmessage = (e) => { if (st.worker === w) onWorkerMessage(e.data); };
    w.onerror = (e) => {
      if (st.worker !== w) return;
      e.preventDefault();
      w.terminate();
      st.worker = null; st.modelReady = false; st.initPending = false; st.inflight = null; st.m.outstanding = 0;
      st.load.phase = 'error'; renderLoad();
      stopCamera();
      setError(`워커 오류: ${e.message || '알 수 없음'} — 카메라 시작을 누르면 다시 불러와요.`);
    };
    st.initPending = true;
    st.load = { phase: 'start', loaded: 0, total: 0, t0: performance.now(), ms: 0 };
    renderLoad();
    w.postMessage({ type: 'init' });
  }

  function onWorkerMessage(m) {
    if (m.type === 'progress') {
      if (st.modelReady) return;
      st.load.phase = m.phase;
      if (m.phase === 'download') { st.load.loaded = m.loaded; st.load.total = m.total; }
      renderLoad();
    } else if (m.type === 'ready') {
      st.modelReady = true; st.initPending = false;
      st.load.phase = 'ready'; st.load.ms = performance.now() - st.load.t0;
      renderLoad();
      if (st.running) setStatus('탐지 중…');
      pump();
    } else if (m.type === 'result') {
      const f = st.inflight;
      if (f && f.id === m.id) st.m.outstanding--;
      if (!f || f.id !== m.id) return;
      st.inflight = null;
      if (f.gen !== st.gen || !st.running) { st.m.dropped++; pump(); return; } // stale: stopped/restarted meanwhile
      onResult(m.json, m.ms, f);
      schedule();
    } else if (m.type === 'error') {
      if (m.stage === 'init') {
        st.initPending = false;
        st.load.phase = 'error';
        setError(`모델을 불러오지 못했어요: ${m.message} — 카메라 시작을 다시 누르면 재시도해요.`);
        stopCamera();
        return;
      }
      const f = st.inflight;
      if (!f || f.id !== m.id) return;
      st.m.outstanding--;
      st.inflight = null;
      if (f.gen !== st.gen) { pump(); return; }
      // No automatic retry loop on inference errors: stop and let the user start again.
      stopCamera();
      setError(`추론 실패: ${m.message}`);
    }
  }

  // ---------- detection loop ----------
  function schedule() {
    clearTimeout(st.nextTimer);
    st.nextTimer = setTimeout(pump, 0);
  }

  /** Send the CURRENT video frame if nothing is in flight. Never queues frames. */
  function pump() {
    if (!st.running || !st.modelReady || st.inflight || !st.worker) return;
    const v = el.video;
    const size = D.frameSize(v.videoWidth, v.videoHeight, MAX_SIDE);
    if (!size || v.readyState < 2) { schedule(); return; }
    if (grab.width !== size.width || grab.height !== size.height) { grab.width = size.width; grab.height = size.height; }
    grabCtx.drawImage(v, 0, 0, size.width, size.height);
    const rgba = grabCtx.getImageData(0, 0, size.width, size.height).data.buffer;
    const id = ++st.seq;
    st.inflight = { id, gen: st.gen, sentAt: performance.now(), w: size.width, h: size.height };
    st.m.sent++;
    st.m.outstanding++;
    st.m.maxInflight = Math.max(st.m.maxInflight, st.m.outstanding);
    st.worker.postMessage({ type: 'detect', id, rgba, width: size.width, height: size.height }, [rgba]);
  }

  function onResult(json, ms, f) {
    let dets;
    try { dets = D.parseDetections(json); } catch (err) { dets = []; setError(`결과 해석 실패: ${err.message}`); }
    const now = performance.now();
    st.dets = dets; st.detAt = now; st.frameW = f.w; st.frameH = f.h;
    const m = st.m;
    m.done++; m.ms.push(ms); m.rtt.push(now - f.sentAt); m.times.push(now);
    if (m.ms.length > 20) { m.ms.shift(); m.rtt.shift(); }
    if (m.times.length > 11) m.times.shift();
    draw();
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const rate = m.times.length > 1 ? (m.times.length - 1) / ((m.times[m.times.length - 1] - m.times[0]) / 1000) : null;
    el.metrics.textContent = `추론 ${Math.round(ms)}ms (평균 ${Math.round(avg(m.ms))}ms) · 상자 갱신 ${rate ? `${rate.toFixed(2)}회/초` : '측정 중'} · ${f.w}×${f.h} 입력 · 완료 ${m.done}회`;
    show(el.metrics, true);
    el.dets.textContent = dets.length ? `탐지: ${dets.map(D.label).join(', ')}` : '탐지된 물체 없음';
    show(el.dets, true);
    setStatus('탐지 중… (영상은 실시간, 상자는 마지막 결과)');
  }

  // ---------- overlay ----------
  function clearOverlay() {
    const c = el.overlay;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    st.drawn = [];
  }

  function draw() {
    const c = el.overlay, v = el.video;
    const bw = el.stage.clientWidth, bh = el.stage.clientHeight, dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(bw * dpr) || c.height !== Math.round(bh * dpr)) { c.width = Math.round(bw * dpr); c.height = Math.round(bh * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    st.drawn = [];
    if (!st.running || !st.dets.length) return;
    // Model frame is a uniform downscale of the video frame, so the video's contain rect maps 0..1000 directly.
    const rect = D.containRect(v.videoWidth, v.videoHeight, bw, bh);
    if (!rect) return;
    ctx.scale(dpr, dpr);
    ctx.font = '600 13px "Pretendard", "Apple SD Gothic Neo", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const d of st.dets) {
      const b = D.mapBox(d.bbox, rect);
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#3ddc97';
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      const text = D.label(d);
      const lw = Math.min(ctx.measureText(text).width + 12, bw), lh = 20;
      const p = D.labelPos(b, lw, lh, bw, bh);
      ctx.fillStyle = 'rgb(31 77 58 / 0.9)';
      ctx.fillRect(p.x, p.y, lw, lh);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, p.x + 6, p.y + 4, lw - 12);
      st.drawn.push({ text, box: b, label: { ...p, w: lw, h: lh } });
    }
  }

  function expireCheck() {
    if (st.dets.length && performance.now() - st.detAt > EXPIRE_MS) {
      st.dets = []; clearOverlay();
      el.dets.textContent = '결과가 오래돼서 상자를 지웠어요 (추론 대기 중)';
    }
  }

  // ---------- camera ----------
  async function syntheticStream() {
    // TEST ONLY: plays the official public Mirage example photo through a canvas MediaStream.
    if (window.__mirageTest && window.__mirageTest.cameraGate) await window.__mirageTest.cameraGate;
    const img = new Image();
    img.src = 'test-fixtures/coco-231049.jpg';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    const draw = () => ctx.drawImage(img, 0, 0);
    draw();
    const timer = setInterval(draw, 50);
    return { stream: c.captureStream(20), timer };
  }

  async function startCamera() {
    setError('');
    const gen = ++st.gen;
    show(el.start, false); show(el.stop, true);
    setStatus('카메라 여는 중…');
    ensureWorker();
    let stream, timer = 0;
    try {
      if (SYNTHETIC) ({ stream, timer } = await syntheticStream());
      else {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      }
      if (gen !== st.gen) { // stopped / restarted / pagehide while permission prompt was pending
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(timer);
        if (window.__mirageTest) window.__mirageTest.staleStreams.push(stream);
        return;
      }
      st.stream = stream; st.synthetic = timer ? { timer } : null;
      if (window.__mirageTest) window.__mirageTest.lastStream = stream;
      el.video.srcObject = stream;
      await el.video.play();
      if (gen !== st.gen) return; // stopCamera already released this stream
      st.running = true;
      show(el.placeholder, false);
      st.expireTimer = setInterval(expireCheck, 500);
      setStatus(st.modelReady ? '탐지 중…' : `${loadText()} 준비되면 자동으로 탐지해요.`);
      pump();
    } catch (err) {
      if (stream && gen !== st.gen) { stream.getTracks().forEach((t) => t.stop()); return; }
      if (gen !== st.gen) return;
      stopCamera();
      const n = err && err.name;
      setError(
        n === 'NotAllowedError' ? '카메라 권한이 거부됐어요. 브라우저 설정에서 허용해 주세요.'
        : n === 'NotFoundError' ? '사용할 수 있는 카메라가 없어요.'
        : n === 'NotSupportedError' ? '이 브라우저에서는 카메라를 쓸 수 없어요 (HTTPS 또는 localhost 필요).'
        : n === 'NotReadableError' ? '카메라를 다른 앱이 사용 중이에요.'
        : `카메라를 시작하지 못했어요: ${err && err.message}`);
    }
  }

  function stopCamera() {
    st.gen++;
    st.running = false;
    clearTimeout(st.nextTimer); clearInterval(st.expireTimer);
    st.nextTimer = 0; st.expireTimer = 0;
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    if (st.synthetic) { clearInterval(st.synthetic.timer); st.synthetic = null; }
    st.stream = null;
    el.video.pause();
    el.video.srcObject = null;
    st.dets = []; clearOverlay();
    show(el.placeholder, true); show(el.start, true); show(el.stop, false);
    show(el.metrics, false); show(el.dets, false);
    setStatus(st.modelReady ? '카메라가 꺼져 있어요. 모델은 준비돼 있어요.' : loadText());
  }

  el.start.addEventListener('click', startCamera);
  el.stop.addEventListener('click', stopCamera);
  window.addEventListener('pagehide', stopCamera);
  new ResizeObserver(() => draw()).observe(el.stage);
  el.video.addEventListener('resize', () => draw());

  if (SYNTHETIC) {
    show(el.banner, true);
    // Test hook (synthetic mode only).
    window.__mirageTest = {
      cameraGate: null, lastStream: null, staleStreams: [],
      state: () => ({
        load: { ...st.load }, modelReady: st.modelReady,
        gen: st.gen, running: st.running, inflight: !!st.inflight, workers: st.worker ? 1 : 0,
        dets: st.dets.map((d) => ({ ...d })), drawn: (st.drawn || []).map((x) => ({ ...x })),
        frame: [st.frameW, st.frameH], video: [el.video.videoWidth, el.video.videoHeight],
        m: { ...st.m, ms: [...st.m.ms], rtt: [...st.m.rtt] },
      }),
    };
  }
  ensureWorker();
})();
