# highlight.js 11.9.0

This directory vendors the browser build of
[highlight.js 11.9.0](https://www.npmjs.com/package/highlight.js/v/11.9.0) so
the chat page highlights code blocks without a third-party CDN at runtime.

The browser bundle is **not** part of the npm package — its npm path is a 404,
which is why the previous CDN URL never loaded and `window.hljs` was always
undefined. The bundle lives in the official
[cdn-release](https://github.com/highlightjs/cdn-release) repository:

- `highlight.min.js`
  - Source: `https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js`
  - SHA-256: `837a6fa5b0c736b52bbde2b2b6190f305da3fc9ed41681db5321507057b5c846`
  - Verified byte-identical from two independent jsDelivr mirrors
    (`cdn.jsdmirror.com`, `jsd.onmicrosoft.cn`).
  - Self-check: the banner reads `Highlight.js v11.9.0 (git: f47103d4f1)` and the
    UMD wrapper declares a top-level `hljs`, so a classic `<script>` gives the
    page `window.hljs`.

The stylesheet, by contrast, does ship in the npm package:

- `github-dark.min.css`
  - Source: `https://registry.npmjs.org/highlight.js/-/highlight.js-11.9.0.tgz`
    (`styles/github-dark.min.css`)
  - npm integrity: `sha512-fJ7cW7fQGCYAkgv4CPfwFHrfd/cLS4Hau96JuJ+ZTOWhjnhoeN1ub1tFmALm/+lW5z4WCAuAV9bm05AP0mS6Gw==`
  - npm SHA-1: `04ab9ee43b52a41a047432c8103e2158a1b8b5b0`
  - SHA-256: `9f208d022102b1d0c7aebfecd8e42ca7997d5de636649d2b31ea63093d809019`
- `LICENSE` SHA-256: `6c081431591d9df696c82dc598fe1423765b8a299b200ed00b281afd0f64c490`
- License: `BSD-3-Clause`; see [LICENSE](./LICENSE).

No local changes were made to either file. To update: keep the two sources on the
same version, re-verify the banner version and hashes above, then re-run the
frontend tests.
