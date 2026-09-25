'use strict';

// Protocol/code version shared by the CLI and the daemon.
//
// A skill upgrade replaces lib/*.js under a running daemon, so the CLI and the
// daemon can disagree about the wire protocol. Deriving the version from the
// bytes of the lib directory means any code change bumps it automatically: on a
// mismatch the CLI retires the old daemon with `shutdown {keepChrome:true}` and
// a fresh one re-attaches to the same Chrome, so the user never loses the tabs
// they are logged into.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function codeVersion(dir = __dirname) {
  const hash = crypto.createHash('sha1');
  let names;
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith('.js') && name !== 'version.js').sort();
  } catch (_) {
    return '0';
  }
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(path.join(dir, name)));
    } catch (_) { /* a file that vanished mid-upgrade just does not contribute */ }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

const VERSION = codeVersion();

module.exports = { VERSION, codeVersion };
