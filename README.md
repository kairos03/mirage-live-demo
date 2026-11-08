# Mirage live detection demo

Live camera → continuous on-device object detection → boxes, names and scores drawn over the video.
Everything runs in your browser: the [Mirage](https://huggingface.co/Cactus-Compute/mirage) vision model
(51.3M params) on the Cactus WASM runtime 4.0.0, inside one Web Worker. No upload, no recording, no analytics.

- The model (~21.6 MB) starts downloading as soon as the page opens; the status line shows the bytes received
  (and a percentage only when the server reports the size) and then "모델 준비 완료".
- The camera only turns on when you press **카메라 시작** and grant permission. **카메라 끄기** stops it.

## Commands
```sh
npm install                          # dev/test deps only: jpeg-js, pngjs, playwright-core
npm run fetch-assets                 # pinned runtime + model (sha256-checked) + local test photo
npm start                            # http://127.0.0.1:5173/  (127.0.0.1 only; PORT to change)
npm test                             # unit + Node WASM inference + headless Chrome e2e (synthetic camera)
npm run build:pages                  # dist/ for GitHub Pages (~23 MB, includes model + license docs)
npm run serve:pages                  # serve dist/ at http://127.0.0.1:5173/mirage-live-demo/
npm run proof:pages -- <URL>         # e2e proof against a deployed URL (default: local dist/)
```
Tests need a local Google Chrome (`CHROME_PATH` to override). They never use a real camera: a still photo is
played through a canvas `MediaStream`. Detections in tests come from the real model.

## How it works
- `public/worker.js` — downloads the model with streamed byte progress, loads runtime + model, runs one frame at a time.
- `public/app.js` — starts the worker on page load. After the camera starts: when nothing is in flight, grab the
  current video frame (≤640 px longest side), send it, wait for the result, repeat. No queue; video never paused.
- `public/engine.js` — thin wrapper over the published C ABI (`cactus_load`, `cactus_describe`, …); requests
  objects with bbox + score only.
- `public/detect.js` — pure helpers: bbox validation, `object-fit: contain` mapping, label placement.
- Stop / restart / `pagehide` invalidate pending camera permission requests and late results.

## Deployment
`.github/workflows/pages.yml` downloads the pinned model/runtime from Hugging Face, verifies sha256, builds
`dist/` and deploys it with GitHub Pages. The binaries are never committed to Git.
All app URLs are relative, so the site works under `/mirage-live-demo/`. A CSP `<meta>` limits scripts,
workers and network requests to the same origin.

## Measured
- Apple Silicon, headless Chrome, single-thread WASM: ~0.9–1.0 s per inference → boxes update about once per
  second while the video keeps playing. Not measured on phones. Boxes show the last processed frame and lag
  moving objects (no tracking). Labels are the model's English names.

## Requirements
Secure context (HTTPS or localhost), WebAssembly, BigInt, Web Workers, `getUserMedia`.

## License
This repository's own code: MIT ([LICENSE](LICENSE)). The Mirage model and the Cactus runtime are third-party
components with their own licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Personal,
non-commercial demo; check upstream terms before any commercial use.
