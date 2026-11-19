'use strict';
// Generates the comparison corpus for multicc_core::chat_replay_buffer from the
// frozen Node implementation tests/helpers/legacy-chat-replay-buffer.js and
// cross-checks it against the REAL capture in chat-replay-buffer-golden.json.
//
//   node docs/rust-migration/differential/chat-replay-buffer-oracle.js
//
// A case is a small program run against the frozen implementation:
//
//   push S N      N frames, seq numbers from one running counter (turn-engine push)
//   gpush S N     the same through the watchdog's guarded push
//   clear S       cs.streamReplay = []
//   join S ID     cs.clients.add(ws)        leave S ID   cs.clients.delete(ws)
//   clearc S      cs.clients.clear()
//   detach ID     the ws close cleanup: delete the socket from every session
//   drop S        session destroy: terminate clients in order, delete the state
//   fan S OPEN [tIDS]  broadcastTo over S; OPEN lists the ids whose readyState
//                 is OPEN ('-' = none); an optional tIDS makes send() throw for
//                 those ids. Records the ids send() was attempted for.
//
// Frames are `{"seq":N}`; buffers are recorded as inclusive seq runs so the
// 500-frame cases stay small.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const oracle = require('../../../tests/helpers/legacy-chat-replay-buffer');

const ORACLE_FILE = path.join(__dirname, '../../../tests/helpers/legacy-chat-replay-buffer.js');
const GOLDEN = path.join(__dirname, 'chat-replay-buffer-golden.json');

function runs(seqs) {
  const out = [];
  for (const seq of seqs) {
    const last = out[out.length - 1];
    if (last && last[1] + 1 === seq) last[1] = seq;
    else out.push([seq, seq]);
  }
  return out;
}

function execute(program) {
  const sessions = oracle.createChatSessions();
  const touched = new Set();
  const observed = [];
  let seq = 0;
  for (const line of program) {
    const [op, a, b, c] = line.split(' ');
    if (op === 'push' || op === 'gpush') {
      touched.add(a);
      const cs = oracle.chatState(sessions, a);
      for (let i = 0; i < Number(b); i += 1) {
        const frame = { seq };
        seq += 1;
        (op === 'push' ? oracle.pushReplay : oracle.pushReplayGuarded)(cs, frame);
      }
    } else if (op === 'clear') {
      touched.add(a);
      oracle.clearReplay(oracle.chatState(sessions, a));
    } else if (op === 'join') {
      touched.add(a);
      oracle.joinClient(oracle.chatState(sessions, a), Number(b));
    } else if (op === 'leave') {
      touched.add(a);
      oracle.leaveClient(oracle.chatState(sessions, a), Number(b));
    } else if (op === 'clearc') {
      touched.add(a);
      oracle.clearClients(oracle.chatState(sessions, a));
    } else if (op === 'detach') {
      oracle.detachClient(sessions, Number(a));
    } else if (op === 'drop') {
      touched.add(a);
      const terminated = [];
      oracle.destroySession(sessions, a, client => terminated.push(client));
      observed.push({ op: 'drop', terminated });
    } else if (op === 'fan') {
      touched.add(a);
      const open = new Set(b === '-' ? [] : b.split('').map(Number));
      const throws = new Set(c ? c.slice(1).split('').map(Number) : []);
      const attempted = oracle.fanOut(
        oracle.chatState(sessions, a),
        { type: 'stream_event' },
        client => open.has(client),
        client => { if (throws.has(client)) throw new Error('send failed'); },
      );
      observed.push({ op: 'fan', attempted });
    } else {
      throw new Error(`unknown op ${line}`);
    }
  }
  const final = {};
  for (const name of [...touched].sort()) {
    const cs = sessions.get(name);
    final[name] = {
      frames: runs((cs ? cs.streamReplay : []).map(frame => frame.seq)),
      clients: cs ? [...cs.clients] : [],
    };
  }
  return { program, observed, final };
}

const cases = [];
const add = program => { cases.push(execute(program)); };

// A. The 500 cap and the clear interleavings, one session.
const BOUNDARY = [0, 1, 2, 3, 10, 499, 500, 501, 502, 620, 1000, 1001];
for (const n of BOUNDARY) add([`push a ${n}`]);
for (const n of BOUNDARY) add([`gpush a ${n}`]);
const EDGE = [0, 1, 499, 500, 501];
for (const x of EDGE) for (const y of EDGE) add([`push a ${x}`, `push a ${y}`]);
for (const x of EDGE) for (const y of EDGE) add([`push a ${x}`, `gpush a ${y}`]);
for (const x of [0, 1, 499, 500, 501, 620]) {
  for (const y of [0, 1, 3, 500, 501]) {
    add([`push a ${x}`, 'clear a', `push a ${y}`]);
    add([`push a ${x}`, 'clear a', 'clear a', `push a ${y}`]);
  }
}
add(['clear a']);
add(['push a 3', 'clear a', 'clear a']);

// B. The client registry: Set semantics over three ids.
function sequences(ops, depth) {
  let layer = [[]];
  const all = [[]];
  for (let d = 0; d < depth; d += 1) {
    layer = layer.flatMap(prefix => ops.map(op => [...prefix, op]));
    all.push(...layer);
  }
  return all;
}
const REGISTRY3 = ['join a 1', 'join a 2', 'join a 3', 'leave a 1', 'leave a 2', 'leave a 3', 'clearc a'];
for (const program of sequences(REGISTRY3, 3)) add(program);
const REGISTRY2 = ['join a 1', 'join a 2', 'leave a 1', 'leave a 2', 'clearc a'];
for (const program of sequences(REGISTRY2, 4).filter(p => p.length === 4)) add(program);

// B2. Fan-out over every distinct ordered client list, every readyState
// combination and every throwing-send combination.
const IDS = [1, 2, 3];
const lists = [[]];
for (const x of IDS) {
  lists.push([x]);
  for (const y of IDS) if (y !== x) {
    lists.push([x, y]);
    for (const z of IDS) if (z !== x && z !== y) lists.push([x, y, z]);
  }
}
const subsets = ['-', '1', '2', '3', '12', '13', '23', '123'];
for (const list of lists) {
  const program = list.map(id => `join a ${id}`);
  for (const open of subsets) {
    program.push(`fan a ${open}`);
    for (const id of IDS) program.push(`fan a ${open} t${id}`);
    program.push(`fan a ${open} t123`);
  }
  // A duplicate join must neither duplicate nor move the entry.
  program.push('join a 2', 'join a 1', 'fan a 123');
  add(program);
}

// C. Two sessions: isolation, detach across sessions, destroy.
const MULTI = ['push a 2', 'push b 1', 'clear a', 'join a 1', 'join b 1', 'join a 2', 'detach 1', 'drop a', 'drop b'];
for (const program of sequences(MULTI, 3)) add(program);
add(['push a 600', 'push b 3', 'join a 1', 'join a 2', 'drop a', 'push a 2', 'join a 3', 'fan a 123']);
add(['join a 1', 'join b 1', 'join a 2', 'join b 3', 'detach 1', 'fan a 12', 'fan b 13']);

// D. The captured real scenarios, as op scripts, cross-checked against what a
// real client actually received.
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const byName = Object.fromEntries(golden.scenarios.map(s => [s.name, s]));
const derived = {
  replay: ['push a 3'],
  eviction: ['push a 620'],
  // the finished turn's frames are cleared at the next turn's admission
  'turn-boundary': ['push a 3', 'clear a', 'push a 3'],
  // A confirmed cancel terminates the runner and clears the live replay.
  cancel: ['push a 1', 'clear a'],
  retry: ['push a 1'],
  background: ['clear a'],
  // a relaunched process starts with an empty table
  'crash-recovery': ['join a 1'],
};
const captured = [];
for (const [name, program] of Object.entries(derived)) {
  const result = execute(program);
  const frames = result.final.a.frames.reduce((n, [from, to]) => n + (to - from + 1), 0);
  const expected = byName[name].replayed.length;
  if (frames !== expected) {
    throw new Error(`oracle disagrees with the real capture for ${name}: ${frames} != ${expected}`);
  }
  if (name === 'eviction') {
    const [[from, to]] = result.final.a.frames;
    if (byName[name].replayed[0] !== `burst:${from}` || byName[name].replayed.at(-1) !== `burst:${to}`) {
      throw new Error('eviction window disagrees with the real capture');
    }
  }
  captured.push({ name, replayedFrames: expected, ...result });
}

const meta = {
  generatedFrom: 'tests/helpers/legacy-chat-replay-buffer.js',
  oracleSha256: crypto.createHash('sha256').update(fs.readFileSync(ORACLE_FILE)).digest('hex'),
  captureSha256: crypto.createHash('sha256').update(fs.readFileSync(GOLDEN)).digest('hex'),
  cap: oracle.REPLAY_BUFFER_CAP,
  capturedAt: golden.capturedAt,
  cases: cases.length,
};
const body = [
  '{',
  `"meta": ${JSON.stringify(meta)},`,
  `"captured": ${JSON.stringify(captured)},`,
  '"cases": [',
  cases.map(c => JSON.stringify(c)).join(',\n'),
  ']',
  '}',
  '',
].join('\n');
const out = path.join(__dirname, 'chat-replay-buffer-corpus.json');
fs.writeFileSync(out, body);
console.log(`wrote ${cases.length} cases + ${captured.length} captured to ${path.relative(process.cwd(), out)} (${body.length} bytes)`);
console.log(`oracle sha256 ${meta.oracleSha256}`);
