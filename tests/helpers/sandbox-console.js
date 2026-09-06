'use strict';

// Page scripts loaded into a vm sandbox log while they boot. console.log,
// .info and .debug write to stdout — the same stream node:test uses to frame
// this child process's messages — so one stray line desyncs the parser and
// fails the whole file with "Unable to deserialize cloned data due to invalid
// or unsupported version". warn/error/trace go to stderr and stay visible.
function createSandboxConsole() {
  return { ...console, log() {}, info() {}, debug() {} };
}

module.exports = { createSandboxConsole };
