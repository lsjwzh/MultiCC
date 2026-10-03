# noVNC 1.7.0

This directory vendors the browser distribution of
[@novnc/novnc 1.7.0](https://github.com/novnc/noVNC) so the chat page's
「🖥 屏幕」 live-stream mode (RFB over `/ws/remote-screen`) can `import()`
the stock client with no third-party CDN at runtime.

- Source tarball: `https://registry.npmjs.org/@novnc/novnc/-/novnc-1.7.0.tgz`
- Only `core/`, `vendor/` (pako, for Zlib/ZRLE decoders), `LICENSE.txt` and
  `package.json` are kept; the upstream `docs/` folder was dropped.
- Entry point: `core/rfb.js` (ESM; loaded via dynamic `import()` from
  `public/chat-remote-screen.js`).
- `core/rfb.js` SHA-256: `c46dfefbf869eda0c6d06c5dd86c42e96fc8a77c125e91599a2cdf3841261564`
- `LICENSE.txt` (MPL-2.0) SHA-256: `3ccd2242d7f5b6c5ae831a486f63cce1f18d8cd11c511f6a7a7251673763b2d1`
- License: MPL-2.0 (file-level copyleft — these files are unmodified, so the
  obligation is just keeping this notice and the license text with them).

The files were extracted directly from the official npm tarball. No local
changes were made to them. `core/rfb.js` is registered as a reviewed
third-party asset in `scripts/check-source-line-budget.js` because it exceeds
the default 3000-line budget for first-party source.
