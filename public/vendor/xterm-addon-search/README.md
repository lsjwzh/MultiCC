# xterm-addon-search 0.13.0

This directory vendors the browser distribution of
[xterm-addon-search 0.13.0](https://www.npmjs.com/package/xterm-addon-search/v/0.13.0)
so the terminal page opens without a third-party CDN at runtime. It pairs with
the vendored [xterm 5.3.0](../xterm/).

- Source tarball: `https://registry.npmjs.org/xterm-addon-search/-/xterm-addon-search-0.13.0.tgz`
- npm integrity: `sha512-sDUwG4CnqxUjSEFh676DlS3gsh3XYCzAvBPSvJ5OPgF3MRL3iHLPfsb06doRicLC2xXNpeG2cWk8x1qpESWJMA==`
- npm SHA-1: `21286f4db48aa949fbefce34bb8bc0c9d3cec627`
- `xterm-addon-search.js` SHA-256: `6a6db33f16b764552377a2c5ba4327c6dab6beaf25484533afd7dbecd0b03793`
- `xterm-addon-search.js.map` SHA-256: `be018c599006ccf38c4f7bd4562fb1eb3fb839e65e5ca0748b4264325b03065f`

The terminal page uses it for in-buffer search (⌘F / Ctrl+F)。It is loaded only
on `index.html` (the terminal page); the chat and Air shells do not need it.
