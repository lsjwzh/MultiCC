'use strict';

// Stopping a writer that will not stop on its own.
//
// A workspace lease is released only after its writer is provably stopped, and
// a live background task is exactly the case `drain()` must not release: the
// task may still be writing the checkout. That default is correct until the
// background task can never finish — a test runner that leaks a listening
// handle, a build wedged on a network read, a wrapper whose sentinel only an
// exit can write. Then the turn is long classified complete, the user's queued
// message is vetoed on every tick, and the only thing between them is a process
// tree whose owner stopped listening.
//
// Escalation is the bounded answer: signal the descendants first (they are the
// ones holding the checkout and the hung handle), then the writer itself, TERM
// before KILL, and report honestly when even that failed. Nothing here decides
// *whether* to escalate; that judgement stays with the lease owner.
const { processTable, sameProcess, descendants, protectedAncestors } = require('../server-processes');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TERM_GRACE_MS = 1500, KILL_GRACE_MS = 1500;

// Module scope on purpose: a parameter default cannot see a function declared
// in the factory body, so `signal = processSignal` there was a ReferenceError
// on every production call (the tests inject a signal; the host does not).
function processSignal(record, name, log) {
  try { process.kill(record.pid, name); return true; }
  catch (error) {
    // ESRCH is the race this path wants (it exited between enumeration and
    // signal). EPERM is not ours to retry: report the refusal instead of
    // reporting a stop that never happened.
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') {
      log('writer_signal_denied', { pid: record.pid, signal: name, code: error.code });
      return false;
    }
    throw error;
  }
}

function createWriterEscalation({
  table = processTable,
  log = () => {},
  termGraceMs = TERM_GRACE_MS,
  killGraceMs = KILL_GRACE_MS,
  signal = null,
} = {}) {
  const send = signal || ((record, name) => processSignal(record, name, log));
  const live = (records, snapshot) => records.filter(record => sameProcess(record, snapshot.find(p => p.pid === record.pid)));
  async function waitGone(records, deadline) {
    let snapshot = table(), alive = live(records, snapshot);
    while (alive.length && Date.now() < deadline) {
      await sleep(100);
      snapshot = table(); alive = live(records, snapshot);
    }
    return alive;
  }
  // Descendants first, deepest first: they hold the checkout, the leaked handle
  // and the child that never exits, while the writer above them is only what
  // keeps spawning them. Never touch our own chain — killing the process that
  // called us (or the server above it) is not a recovery.
  function plan(pid) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
    const snapshot = table(), root = snapshot.find(p => p.pid === pid);
    if (!root) return { root: null, owned: [] };
    const excluded = protectedAncestors(snapshot, [root]);
    excluded.add(process.pid);
    const owned = [...descendants(snapshot, [root], excluded).values()].filter(record => record.pid !== pid);
    return { root, owned: owned.reverse() };
  }
  function result(code, killed, survivors, extra = {}) {
    return { ok: survivors.length === 0, code: survivors.length ? `${code}_survived` : code,
      killed, survivors: survivors.map(record => record.pid), ...extra };
  }
  async function stopDescendants(pid, { reason = 'escalated' } = {}) {
    const target = plan(pid);
    if (!target) return result('writer_pid_unusable', 0, []);
    if (!target.root) return result('writer_already_gone', 0, []);
    if (!target.owned.length) return result('writer_has_no_descendants', 0, []);
    for (const record of target.owned) send(record, 'SIGTERM');
    let survivors = await waitGone(target.owned, Date.now() + termGraceMs);
    if (survivors.length) {
      log('writer_descendants_sigkill', { pid, count: survivors.length, reason });
      for (const record of survivors) send(record, 'SIGKILL');
      survivors = await waitGone(survivors, Date.now() + killGraceMs);
    }
    return result(survivors.length ? 'writer_descendants' : 'writer_descendants_stopped', target.owned.length, survivors);
  }
  async function stopWriter(pid, { reason = 'escalated' } = {}) {
    const target = plan(pid);
    if (!target) return result('writer_pid_unusable', 0, []);
    if (!target.root) return result('writer_already_gone', 0, []);
    const all = [...target.owned, target.root];
    for (const record of target.owned) send(record, 'SIGTERM');
    send(target.root, 'SIGTERM');
    let survivors = await waitGone(all, Date.now() + termGraceMs);
    if (survivors.length) {
      log('writer_sigkill', { pid, count: survivors.length, reason });
      for (const record of survivors) send(record, 'SIGKILL');
      survivors = await waitGone(survivors, Date.now() + killGraceMs);
    }
    return result('writer_stopped', all.length, survivors);
  }
  return { stopDescendants, stopWriter };
}
module.exports = { createWriterEscalation };
