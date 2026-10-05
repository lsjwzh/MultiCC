"use strict";

// Shared host power services. Desktop work belongs to the resident Agent;
// HTTP reads report state and never start or stop a display watchdog.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createUnlockPassword } = require('./macos-unlock-password');
const { createUnlockProbe } = require('./macos-unlock-probe');

function createPowerPreferences({ dir = process.env.MULTICC_AGENT_DIR || path.join(os.homedir(), '.multicc', 'agent') } = {}) {
  const file = path.join(dir, 'power-settings.json');
  return {
    read(legacyEnabled = false) {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof value.autoUnlock !== 'boolean') throw new Error('invalid power preferences');
        return value.autoUnlock;
      } catch (error) {
        if (error.code === 'ENOENT') return legacyEnabled;
        throw error;
      }
    },
    write(autoUnlock) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ autoUnlock }) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
      } finally { fs.rmSync(tmp, { force: true }); }
    },
  };
}
let unlockPassword, unlockProbe, powerPreferences;
const getUnlockPassword = () => unlockPassword || (unlockPassword = createUnlockPassword());
const getUnlockProbe = () => unlockProbe || (unlockProbe = createUnlockProbe());
const getPowerPreferences = () => powerPreferences || (powerPreferences = createPowerPreferences());

async function readPowerSettings(deps, req) {
  if (!deps.macosPower.isAvailable()) return { available: false, enabled: false };
  const status = await deps.macosPower.getLidModeSettings();
  if (deps.batteryGuard) status.batteryGuard = deps.batteryGuard.getStatus();
  const password = deps.unlockPassword || getUnlockPassword();
  const preferences = deps.powerPreferences || getPowerPreferences();
  const canEdit = !!deps.isLocalRequest(req);
  try {
    const set = password.isAvailable() && await password.hasPassword();
    const requested = preferences.read(set); // Preserve existing users' consent.
    status.unlockPassword = { available: password.isAvailable(), set, canEdit,
      requested, enabled: set && (requested || status.enabled), requiredByLid: status.enabled };
    if (status.unlockPassword.enabled) {
      const authorization = await (deps.unlockProbe || getUnlockProbe()).desktopPermissions();
      if (authorization.state !== 'authorized') {
        status.unlockPassword.enabled = false;
        status.unlockPassword.authorization = authorization;
      }
    }
  } catch {
    status.unlockPassword = { available: password.isAvailable(), set: false, canEdit, error: 'read-failed' };
  }
  return status;
}
module.exports = { createPowerPreferences, getPowerPreferences, getUnlockPassword, getUnlockProbe, readPowerSettings };
