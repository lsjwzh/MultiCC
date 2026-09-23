# xterm 5.3.0

This directory vendors the browser distribution of
[xterm 5.3.0](https://www.npmjs.com/package/xterm/v/5.3.0) so the terminal page
opens without a third-party CDN at runtime.

- Source tarball: `https://registry.npmjs.org/xterm/-/xterm-5.3.0.tgz`
- npm integrity: `sha512-8QqjlekLUFTrU6x7xck1MsPzPA571K5zNqWm0M0oroYEWVOptZ0+ubQSkQ3uxIEhcIHRujJy6emDWX4A7qyFzg==`
- npm SHA-1: `867daf9cc826f3d45b5377320aabd996cb0fce46`
- `xterm.js` SHA-256: `f0aea0f75f48559013ae6643c2479dd737d26da42d5524e6d2b70915ae6523c7`
- `xterm.js.map` SHA-256: `045aad6642874cbb9784b9c354e6258b788d23b3fef4a3f68e9f754428a78edc`
- `xterm.css` SHA-256: `832f3f2c603b43ad4351ff04970150cc7a873014276db126a6065c6dd81e4872`
- `LICENSE` SHA-256: `b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd`
- License: `MIT`; see [LICENSE](./LICENSE).

`xterm.js` is the unminified UMD build from the npm tarball (there is no
minified file upstream). It is registered as a reviewed third-party asset in
`scripts/check-source-line-budget.js` because it exceeds the default 240 KB
byte budget for first-party source.

The files were extracted directly from the official npm tarball. No local
changes were made to them.
