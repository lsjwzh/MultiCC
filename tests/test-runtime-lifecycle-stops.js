'use strict';

// Deterministic lifecycle tests for process-owned schedulers. No callback is
// allowed to advance automatically: the fake clock exposes active handles so
// stop()/restart behavior can be asserted without network, AI, or wall time.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;

function ok(condition, name) {
  if (condition) {
    pass++;
    console.log('  ✅', name);
  } else {
    fail++;
    console.log('  ❌', name);
  }
}

function fakeTimers() {
  const original = {
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
  };
  const intervals = new Map();
  const timeouts = new Map();
  let nextId = 1;

  function handle(kind, fn, delay) {
    return {
      id: nextId++, kind, fn, delay, unrefCalled: false,
      unref() { this.unrefCalled = true; return this; },
    };
  }

  global.setInterval = (fn, delay) => {
    const h = handle('interval', fn, delay);
    intervals.set(h, h);
    return h;
  };
  global.clearInterval = h => { intervals.delete(h); };
  global.setTimeout = (fn, delay) => {
    const h = handle('timeout', fn, delay);
    timeouts.set(h, h);
    return h;
  };
  global.clearTimeout = h => { timeouts.delete(h); };

  return {
    intervals,
    timeouts,
    restore() {
      global.setInterval = original.setInterval;
      global.clearInterval = original.clearInterval;
      global.setTimeout = original.setTimeout;
      global.clearTimeout = original.clearTimeout;
    },
  };
}

function freshRequire(relativePath) {
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  return require(relativePath);
}

function withTempDataDir(run) {
  const previous = process.env.MULTICC_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-lifecycle-'));
  process.env.MULTICC_DATA_DIR = dir;
  try {
    return run(dir);
  } finally {
    if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testTunnel() {
  console.log('tunnel lifecycle');
  withTempDataDir(() => {
    const clock = fakeTimers();
    try {
      const tunnel = freshRequire('../src/tunnel');
      tunnel.init();
      ok(tunnel.getStatus().monitorRunning === false,
        'disabled tunnel config starts without an interval');

      tunnel.applyConfig({ phddns: { enabled: true, url: 'https://example.invalid/' } });
      ok(tunnel.getStatus().monitorRunning === true && clock.intervals.size === 1,
        'enabled tunnel owns exactly one monitor interval');
      ok([...clock.intervals.values()][0].unrefCalled,
        'tunnel monitor interval is unrefed');

      tunnel.stop();
      tunnel.stop();
      ok(tunnel.getStatus().monitorRunning === false && clock.intervals.size === 0,
        'tunnel stop is idempotent and reports monitorRunning=false');

      tunnel.init();
      ok(tunnel.getStatus().monitorRunning === true && clock.intervals.size === 1,
        'tunnel init restarts one monitor after stop');
      tunnel.stop();
    } finally {
      clock.restore();
    }
  });
}

function testWaitInjector() {
  console.log('wait-injector lifecycle');
  const clock = fakeTimers();
  try {
    const wait = freshRequire('../src/wait-injector');
    wait.init({
      inject: async () => {},
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      isBusy: () => true,
      log: () => {},
    });
    wait.init();
    ok(clock.intervals.size === 1 && wait.stats().tickerRunning === true,
      'wait init is idempotent and owns one ticker');

    wait.injectSystemMsg('session-a', 'later', 5000);
    wait.safeInject('session-b', 'busy payload');
    ok(clock.timeouts.size === 2 && wait.stats().pendingTimers === 2,
      'delayed nudge and busy retry are both lifecycle-tracked');
    ok([...clock.timeouts.values()].every(h => h.unrefCalled),
      'wait one-shot timers are unrefed');

    const pending = wait.register({ session: 'session-c', mode: 'callback' });
    wait.stop();
    wait.stop();
    ok(clock.intervals.size === 0 && clock.timeouts.size === 0,
      'wait stop idempotently clears ticker and every pending timeout');
    ok(wait.stats().tickerRunning === false && wait.stats().pendingTimers === 0,
      'wait stats expose fully stopped scheduling state');
    ok(wait.hasWait('session-c'),
      'wait stop retains durable in-memory wait state for restart');

    wait.init();
    ok(clock.intervals.size === 1 && wait.stats().tickerRunning === true,
      'wait init restarts one ticker after stop');
    wait.cancel(pending.id);
    wait.stop();
  } finally {
    clock.restore();
  }
}

function testCron() {
  console.log('cron lifecycle');
  withTempDataDir(() => {
    const clock = fakeTimers();
    try {
      const cron = freshRequire('../plugins/cron/cron-tasks');
      const deps = {
        directories: new Map(),
        createSessionRecord: async () => ({ ok: false }),
        runChatTurn: () => false,
        sessionExists: () => false,
      };
      cron.init(deps);
      cron.init(deps);
      ok(clock.intervals.size === 1,
        'cron re-init replaces the old scheduler instead of duplicating it');
      ok([...clock.intervals.values()][0].unrefCalled,
        'cron scheduler interval is unrefed');

      cron.stop();
      cron.stop();
      ok(clock.intervals.size === 0,
        'cron stop is idempotent and clears the scheduler');

      cron.init(deps);
      ok(clock.intervals.size === 1,
        'cron init restarts one scheduler after stop');
      cron.stop();
    } finally {
      clock.restore();
    }
  });
}

try {
  testTunnel();
  testWaitInjector();
  testCron();
  console.log(`\n== runtime lifecycle stops: ${pass} passed, ${fail} failed ==`);
  process.exitCode = fail ? 1 : 0;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
