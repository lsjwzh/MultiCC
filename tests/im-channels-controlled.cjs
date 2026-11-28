'use strict';

// IO-only controls for native channel tests. No transport, timer or service runs.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clock() {
  let now = 0;
  const timeouts = [], sleeps = [];
  return {
    timeouts, sleeps, now: () => now,
    AbortSignal: {
      timeout(ms) {
        const controller = new AbortController();
        timeouts.push({ at: now + ms, ms, controller });
        return controller.signal;
      },
      any: signals => AbortSignal.any(signals),
    },
    sleep(ms) {
      const wait = deferred(); sleeps.push({ at: now + ms, ms, wait, done: false }); return wait.promise;
    },
    advance(ms) {
      now += ms;
      for (const timer of timeouts) if (timer.at <= now && !timer.controller.signal.aborted) {
        timer.controller.abort(Object.assign(new Error('synthetic request timeout'), { name: 'TimeoutError' }));
      }
      for (const timer of sleeps) if (timer.at <= now && !timer.done) { timer.done = true; timer.wait.resolve(); }
    },
  };
}

function transport({ deferSend = false } = {}) {
  const requests = [];
  return {
    requests,
    fetch(url, options) {
      const wait = deferred();
      const row = { url, options, ...wait, jsonReads: 0, textReads: 0 };
      requests.push(row);
      row.reply = value => row.resolve({ ok: true, json() { row.jsonReads++; return Promise.resolve(value); } });
      // Deliberately ignore abort: guards and the native abort race must also
      // survive a late result from an uncooperative injected IO implementation.
      if (!url.endsWith('/getupdates') && !(deferSend && url.endsWith('/sendmessage'))) row.reply({});
      return wait.promise;
    },
    polls: () => requests.filter(row => row.url.endsWith('/getupdates')),
    sends: () => requests.filter(row => row.url.endsWith('/sendmessage')),
  };
}

module.exports = { deferred, clock, transport };
