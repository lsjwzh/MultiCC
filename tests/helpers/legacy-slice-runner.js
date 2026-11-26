'use strict';

// Runs generator "jobs" on the event loop without ever holding it for long.
//
// A job is a generator that yields at every point where it is safe to stop (the
// search indexer yields after each block of a transcript and after each session).
// The runner resumes jobs for at most `sliceMs` of wall time, then goes to sleep
// long enough that the work averages out to `duty` of one core:
//
//     pause = worked * (1 - duty) / duty        (duty 0.1: 8ms of work → 72ms off)
//
// So background indexing can neither starve requests (no slice is longer than one
// yield interval plus `sliceMs`) nor eat a core (the pause scales with the work
// actually done). A single un-yielding step is still uninterruptible; the job is
// responsible for keeping those small.
//
// Jobs run one at a time, in order; `front: true` jumps the queue (a session that
// just spoke should not wait behind a whole-corpus sweep). A job is only ever
// switched away from at a yield, so a front job runs at the sweep's next yield point
// and the sweep carries on afterwards, exactly where it was.

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
  const budget = Math.max(1, Number(sliceMs) || DEFAULT_SLICE_MS);
  const share = Math.min(1, Math.max(0.01, Number(duty) || DEFAULT_DUTY));
  const queue = [];
  let scheduled = false;
  let stopped = false;
  let slices = 0;

  function pauseFor(worked) {
    if (share >= 1) return 0;
    return Math.min(MAX_PAUSE_MS, Math.max(1, Math.ceil(worked * (1 - share) / share)));
  }

  function tick() {
    scheduled = false;
    if (stopped) return;
    slices += 1;
    const began = now();
    while (queue.length) {
      const job = queue[0];
      let step;
      try {
        step = job.gen.next();
      } catch (error) {
        queue.shift();
        try { job.onError(error); } catch (_) { /* a failing callback must not stop the queue */ }
        continue;
      }
      if (step.done) {
        queue.shift();
        try { job.onDone(step.value); } catch (_) { /* same */ }
      }
      if (now() - began >= budget) break;
    }
    if (queue.length && !stopped) {
      scheduled = true;
      defer(tick, pauseFor(now() - began));
    }
  }

  function schedule() {
    if (scheduled || stopped || !queue.length) return;
    scheduled = true;
    defer(tick, 0);
  }

  // `onDone(value)` gets the generator's return value; `onError(error)` any throw.
  function enqueue(gen, { front = false, onDone = () => {}, onError = () => {} } = {}) {
    const job = { gen, onDone, onError };
    if (front) queue.unshift(job);
    else queue.push(job);
    schedule();
    return job;
  }

  function clear() {
    queue.length = 0;
  }

  function stop() {
    stopped = true;
    clear();
  }

  return Object.freeze({
    enqueue,
    clear,
    stop,
    pending: () => queue.length,
    stats: () => ({ slices, queued: queue.length, scheduled }),
  });
}

module.exports = { createSliceRunner, DEFAULT_SLICE_MS, DEFAULT_DUTY, MAX_PAUSE_MS };
