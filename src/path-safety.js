'use strict';
// Single source of truth for on-disk *path safety* primitives.
//
// Historically `src/paths.js` and `src/directories.js` each carried their own
// `realPathOf`/`isHomeOrAbove` pair, and the two had silently diverged:
//   - paths.js resolved the nearest existing ancestor before realpath'ing, so a
//     not-yet-existing child of a symlinked ancestor (e.g. macOS
//     /var/folders/... which is really /private/var/folders/...) still compared
//     correctly against os.tmpdir()/os.homedir().
//   - directories.js used a bare `fs.realpathSync(p)` that THREW for any path
//     that doesn't exist yet and fell back to `path.resolve(p)` — which does NOT
//     collapse ancestor symlinks. So the same physical directory could be judged
//     "home-or-above" (or not) differently depending on which module asked.
//
// Both now delegate here so the danger judgement is computed identically no
// matter the caller. The robust (paths.js) behaviour is the one kept.
//
// Guarantees:
//   * realPathOf never throws — a missing path resolves its nearest existing
//     ancestor and re-appends the not-yet-existing tail.
//   * Ancestor symlinks are collapsed (macOS /var -> /private/var) even when the
//     leaf does not exist yet.
//   * isHomeOrAbove is true for $HOME itself, any ancestor of $HOME, and the
//     filesystem root — the set of directories no session/test may ever target.

const fs = require('fs');
const os = require('os');
const path = require('path');

// realpath-ify without throwing for missing paths. Resolve the nearest existing
// ancestor first so macOS' /var -> /private/var symlink cannot make a missing
// child look as if it were outside os.tmpdir()/os.homedir(). Relative inputs are
// made absolute against process.cwd() up front so callers get a stable answer.
function realPathOf(p) {
  const abs = path.resolve(p);
  let cursor = abs;
  const tail = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return abs;   // walked past the root without finding one
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  try { return path.join(fs.realpathSync(cursor), ...tail); }
  catch (_) { return abs; }
}

// True if `p` resolves to $HOME, an ancestor of $HOME, or the filesystem root —
// i.e. a directory too dangerous to hand to `git add -A` / destructive tests.
function isHomeOrAbove(p) {
  const rp = realPathOf(p);
  const rh = realPathOf(os.homedir());
  if (rp === rh) return true;                          // exactly $HOME
  if (rh === rp || rh.startsWith(rp + path.sep)) return true;  // rp is an ancestor of $HOME
  if (rp === path.parse(rp).root) return true;         // filesystem root
  return false;
}

module.exports = {
  realPathOf,
  isHomeOrAbove,
};
