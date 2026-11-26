'use strict';

const { getNative } = require('../native/binding');

const DEFAULT_SLICE_MS = 8;
const DEFAULT_DUTY = 0.1;
const MAX_PAUSE_MS = 500;

function createSliceRunner({
  now = Date.now,
  defer = (fn, delayMs) => {
    if (delayMs > 0) {
      const timer = setTimeout(fn, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
    } else {
      setImmediate(fn);
    }
  },
  sliceMs = DEFAULT_SLICE_MS,
  duty = DEFAULT_DUTY,
} = {}) {
  // V8 owns the generator and clock calls, including their receivers, thrown
  // values, and arithmetic on clocks supplied by the caller (including BigInt).
  const state = getNative().searchSliceRunner({
    now: () => now(),
    defer: (tick, delay) => defer(tick, delay),
    next: job => job.gen.next(),
    done: step => step.done,
    failed: (job, error) => job.onError(error),
    complete: (job, step) => job.onDone(step.value),
    expired: (began, budget) => now() - began >= budget,
    elapsed: began => now() - began,
    numericWork: worked => worked * 1,
  }, Number(sliceMs), Number(duty));
  function enqueue(gen, { front = false, onDone = () => {}, onError = () => {} } = {}) {
    return state.enqueue({ gen, onDone, onError }, front);
  }
  return Object.freeze({ ...state, enqueue });
}

module.exports = { createSliceRunner, DEFAULT_SLICE_MS, DEFAULT_DUTY, MAX_PAUSE_MS };
