#!/usr/bin/env node
'use strict';

// Differential for the `deletedAmong` task-board rule used by the task-first
// migration.
//
// OLD: per-id `deletedTaskIds.includes(id)` on the board mirror — what
//      src/task-shell/host.js isDeletedTask answered for every chat record and
//      every task row, ~2N times per migrate() pass (O(N·m) behind the Proxy).
// NEW: one `deletedAmong` command; Rust indexes the table once
//      (native/core/src/task_domain/deleted.rs) and returns the deleted ids in
//      input order, duplicates kept, so the caller builds one Set.
//
// Both run against the SAME boards: plain boards through the stateless entry
// (`taskDomain`/`taskDomainAsync` on a temporary board) and resident
// `openBoardStore` mirrors through the worker-thread read path (`apply_read`).
// Every case must return the identical array on all three paths. A coverage
// assertion requires the corpus to actually produce hits, order changes and
// duplicates, so a corpus that stops exercising a branch fails instead of
// passing vacuously.
//
// Usage: node deleted-among.js [repoRoot]
// Needs MULTICC_RUST_ADDON to point at an addon built from the current source.

const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const { taskDomain, taskDomainAsync } = require(path.join(root, 'src/native/task-domain'));
const { openBoardStore } = require(path.join(root, 'src/task-board/board-store'));

const quiet = { warn() {}, log() {} };
const boardOf = deletedTaskIds => ({ schemaVersion: 2, revision: 0, modules: {}, tasks: {}, taskGroups: {}, deletedTaskIds });
// The exact question host.js asked per id.
const legacy = (deletedTaskIds, ids) => ids.filter(id => deletedTaskIds.includes(id));

// name -> { deletedTaskIds, ids }. `deletedTaskIds` absent means a board without the field.
const corpus = [];
const add = (name, deletedTaskIds, ids) => corpus.push({ name, deletedTaskIds, ids });

add('no ids at all', ['a', 'b'], []);
add('ids is not an array', ['a'], null);
add('board without deletedTaskIds', undefined, ['a', 'b']);
add('nothing deleted', ['x', 'y'], ['a', 'b']);
add('everything deleted', ['a', 'b'], ['a', 'b']);
add('partial hit', ['a', 'c'], ['a', 'b', 'c']);
add('order follows the input, not the table', ['c', 'a'], ['a', 'b', 'c']);
add('duplicates in the input stay duplicated', ['a', 'c'], ['a', 'b', 'c', 'a', 'c', 'a']);
add('duplicate entries in the table', ['a', 'a'], ['a', 'b']);
add('empty-string id', ['', 'a'], ['', 'a', 'b']);
add('unicode ids', ['任务-🖥', 'tsk_plain'], ['tsk_plain', '任务-🖥', '其他']);
add('a string entry never substring-matches', ['abcdef'], ['abc', 'abcdef']);
add('null entry in the deleted table', ['a', null], ['a', 'b']);
add('numeric entry in the deleted table', ['a', 7], ['a', 'b']);
add('non-string ids', ['a', '7'], [null, 7, true, ['a'], { id: 'a' }, 'a']);

// 3000 ids against a 20000-entry table: the shape the migration actually asks
// for on a large board. Half the asked ids are deleted, in shuffled order.
const BIG = 20000, ASK = 3000;
const bigDeleted = Array.from({ length: BIG }, (_, i) => `task_deleted_${String(i).padStart(6, '0')}`);
const bigIds = [];
for (let i = 0; i < ASK; i += 1) {
  bigIds.push(i % 2 === 0
    ? bigDeleted[(i * 7919) % BIG]
    : `task_live_${String(i).padStart(6, '0')}`);
}
add('large board', bigDeleted, bigIds);

async function main() {
  let same = 0;
  const failures = [];
  const reached = new Map();
  const hit = branch => reached.set(branch, (reached.get(branch) || 0) + 1);

  for (const { name, deletedTaskIds, ids } of corpus) {
    const board = deletedTaskIds === undefined
      ? { schemaVersion: 2, revision: 0, modules: {}, tasks: {}, taskGroups: {} }
      : boardOf(deletedTaskIds);
    const expected = legacy(deletedTaskIds ?? [], Array.isArray(ids) ? ids : []);
    const store = openBoardStore({ raw: board, logger: quiet, verify: false });
    try {
      const plain = taskDomain({ op: 'deletedAmong', board, ids });
      const plainAsync = await taskDomainAsync({ op: 'deletedAmong', board, ids });
      const before = store.snapshot();
      const resident = await taskDomainAsync({ op: 'deletedAmong', board: store.board, ids });
      const after = store.snapshot();
      assert.deepEqual(plain, expected, `${name}: stateless`);
      assert.deepEqual(plainAsync, expected, `${name}: stateless async`);
      assert.deepEqual(resident, expected, `${name}: resident`);
      // A read must not touch the board: the snapshot plus the store's own check.
      assert.equal(JSON.stringify(after), JSON.stringify(before), `${name}: resident board changed (${before} vs ${after})`);
      store.verify('deletedAmong');
      same += 1;
      if (expected.length) hit('hit');
      else hit('miss');
      if (expected.length > 1) hit('multiple');
    } catch (error) {
      failures.push(`${name}: ${error.message.split('\n')[0]}`);
    } finally {
      store.close();
    }
  }

  // Order and duplicates are what the caller's Set construction relies on.
  const order = taskDomain({ op: 'deletedAmong', board: boardOf(['c', 'a']), ids: ['a', 'b', 'c', 'a'] });
  const duplicates = taskDomain({ op: 'deletedAmong', board: boardOf(['a']), ids: ['a', 'a', 'a'] });
  const big = await taskDomainAsync({ op: 'deletedAmong', board: boardOf(bigDeleted), ids: bigIds });
  const semantic = [
    ['input order is preserved', JSON.stringify(order) === JSON.stringify(['a', 'c', 'a'])],
    ['duplicates are preserved', JSON.stringify(duplicates) === JSON.stringify(['a', 'a', 'a'])],
    ['the large board answer halves out', big.length === bigIds.filter(id => bigDeleted.includes(id)).length],
    ['the large board answer is a subset of the input', big.every(id => bigIds.includes(id))],
    ['non-string ids are never deleted', taskDomain({ op: 'deletedAmong', board: boardOf(['a', 7]), ids: [7, null, ['a']] }).length === 0],
  ];
  for (const [label, ok] of semantic) if (!ok) failures.push(`semantic: ${label}`);

  // Documented tolerance: a board the OLD per-id path could not answer at all
  // (`deletedTaskIds?.includes` throws on a non-array; a string field would
  // substring-match). The rule treats anything that is not an array as empty.
  const tolerance = ['abc', 7, { a: true }, null];
  for (const value of tolerance) {
    const out = taskDomain({ op: 'deletedAmong', board: boardOf(value), ids: ['a', 'abc'] });
    if (out.length !== 0) failures.push(`tolerance: ${JSON.stringify(value)} marked ${JSON.stringify(out)} deleted`);
  }

  const required = ['hit', 'miss', 'multiple'];
  const missing = required.filter(branch => !reached.has(branch));
  if (missing.length) failures.push(`branches never reached: ${missing.join(', ')}`);

  console.log(`[deleted-among] same ${same}/${corpus.length}; semantic ${semantic.filter(([, ok]) => ok).length}/${semantic.length}; tolerance ${tolerance.length}; branches ${required.length - missing.length}/${required.length}`);
  if (failures.length) {
    console.error(failures.map(line => `  FAIL ${line}`).join('\n'));
    process.exit(1);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
