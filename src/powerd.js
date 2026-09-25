'use strict';

// Client side of com.multicc.powerd (scripts/multicc-powerd.sh). MultiCC never
// talks to the daemon: it writes one word into an intent file and launchd,
// watching that file, runs the job as root. This module only knows the paths,
// reads the job's status file, and writes the intent.
//
// Installed means "the intent file exists and this user can write it" plus the
// plist being present. Whether launchd actually picked the job up is proven the
// same way the sudoers helper proves itself: by the setting changing, which is
// why setIntent callers still verify with pmset afterwards.
const fs = require('node:fs');
const path = require('node:path');

const LABEL = 'com.multicc.powerd';
const DATA_DIR = '/Library/Application Support/multicc';
const PLIST_PATH = `/Library/LaunchDaemons/${LABEL}.plist`;

function createPowerd({ platform = process.platform, dataDir = DATA_DIR, plistPath = PLIST_PATH, fsImpl = fs } = {}) {
  const intentPath = path.join(dataDir, 'power-intent');
  const statusPath = path.join(dataDir, 'powerd-status.json');

  function installed() {
    if (platform !== 'darwin') return false;
    try {
      fsImpl.accessSync(plistPath, fs.constants.R_OK);
      fsImpl.accessSync(intentPath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  function readStatus() {
    try {
      return JSON.parse(fsImpl.readFileSync(statusPath, 'utf8'));
    } catch {
      return null;
    }
  }

  function readIntent() {
    try {
      const word = fsImpl.readFileSync(intentPath, 'utf8').trim();
      return word === 'on' || word === 'off' ? word : 'none';
    } catch {
      return 'none';
    }
  }

  // Returns false when the daemon is not installed, so the caller falls back
  // to the one-shot paths; a missing daemon is the normal state, not an error.
  function setIntent(enabled) {
    if (!installed()) return false;
    fsImpl.writeFileSync(intentPath, enabled ? 'on\n' : 'off\n');
    return true;
  }

  function status() {
    return { applicable: platform === 'darwin', installed: installed(), intent: readIntent(), daemon: readStatus() };
  }

  return { installed, setIntent, status, readIntent, readStatus, intentPath, statusPath };
}

module.exports = { createPowerd, LABEL, DATA_DIR, PLIST_PATH };
