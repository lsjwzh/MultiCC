'use strict';

// Rust owns the asynchronous timer; the host gate also rejects callbacks that
// were already queued when the response or connection completed.
const { getNative } = require('./runtime');

function scheduleRequestTimer(callback, milliseconds) {
  const value = Number(milliseconds);
  const delay = Number.isFinite(value) && value > 0 && value <= 2_147_483_647 ? value : 1;
  let active = true;
  const timer = new (getNative().RustRequestTimer)(delay, () => {
    if (!active) return;
    active = false;
    callback();
  });
  return {
    cancel() { active = false; timer.cancel(); },
    unref() { return this; },
  };
}

module.exports = { scheduleRequestTimer };
