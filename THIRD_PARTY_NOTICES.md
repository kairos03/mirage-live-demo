# Third-party notices

The MIT license in [`LICENSE`](LICENSE) covers **only this repository's own code** (`public/*.js`, `public/*.html`,
`public/*.css`, `scripts/`, `test/`). It does **not** cover the model or runtime below. Those are not stored in
this Git repository; the build downloads them from their official upstream locations at pinned revisions,
checks their SHA-256, and places them in the deployed site under `vendor/`. Each keeps its own license.

This is a personal, non-commercial demo. Nothing here grants you rights to the third-party components beyond
what their own licenses grant.

## Mirage model — `vendor/mirage.cact`

- Source: <https://huggingface.co/Cactus-Compute/mirage> at revision `3d03cee88c0acbe4e71b94b567ab14e6e55f40c9`
- SHA-256: `4249a0f7515272ff76b9414bec17d7e7daf84b15b66c7fb4f17fce1e66f9f237`
- License stated on the model card: Apache License 2.0 — full text in [`licenses/APACHE-2.0.txt`](licenses/APACHE-2.0.txt)
- Copyright: Cactus Compute. Unmodified.

## Cactus WASM runtime 4.0.0 — `vendor/cactus.js`, `vendor/cactus.wasm`

- Source: <https://huggingface.co/Cactus-Compute/cactus/tree/1a028f5a3972b67dd8d8752f882113d475e7ec4c/releases/4.0.0/wasm>
- SHA-256: `cactus.js` `bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc`,
  `cactus.wasm` `4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6`
- Engine source project: <https://github.com/cactus-compute/cactus>
- Upstream license file, copied byte-for-byte: [`licenses/CACTUS-LICENSE.txt`](licenses/CACTUS-LICENSE.txt)
  (from <https://raw.githubusercontent.com/cactus-compute/cactus/main/LICENSE>, retrieved 2026-11-08,
  SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`).
- Copyright: Cactus Compute. Unmodified.

### Note on runtime licensing

The model card and the runtime's Hugging Face metadata say Apache-2.0, and the copied upstream license file
above is the Apache-2.0 text as of the retrieval date. However, the engine's license **has changed over time**
(the GitHub history shows an earlier MIT license), and terms for the engine source may differ from the model
card and may change again. This repository makes no claim about the terms that apply to the runtime beyond the
copied file. **For any commercial or organizational use, check the current license in the upstream engine
repository and contact Cactus Compute if in doubt.**
