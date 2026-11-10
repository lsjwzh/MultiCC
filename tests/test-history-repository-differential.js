'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const legacy = require('./helpers/legacy-chat-history-file-repository');
const native = require('../src/session/adapters/chat-history-file-repository');

function harness(implementation, options = {}) {
  const files = new Map();
  const calls = [];
  const handles = new Map();
  const failures = new Map();
  const hooks = new Map();
  let nextFd = 10;
  const error = code => Object.assign(new Error(code), { code });
  function touch(op, args) {
    calls.push([op, ...args]);
    if (hooks.has(op)) { const hook = hooks.get(op); hooks.delete(op); hook(); }
    if (failures.has(op)) { const value = failures.get(op); failures.delete(op); throw value; }
  }
  function read(file) {
    if (!files.has(file)) throw error('ENOENT');
    return files.get(file);
  }
  const fsImpl = {
    readFileSync(file, encoding) { assert.equal(this, fsImpl); touch('read', [file, encoding]); return read(file).toString(encoding); },
    mkdirSync(dir, options) { assert.equal(this, fsImpl); touch('mkdir', [dir, options]); },
    statSync(file) { assert.equal(this, fsImpl); touch('stat', [file]); return { size: read(file).length }; },
    openSync(file, flag, mode) {
      assert.equal(this, fsImpl); touch('open', [file, flag, mode]);
      if (!files.has(file)) files.set(file, Buffer.alloc(0));
      const fd = nextFd++; handles.set(fd, file); return fd;
    },
    writeSync(fd, text) {
      assert.equal(this, fsImpl); touch('append', [fd, text]);
      const file = handles.get(fd);
      const bytes = Buffer.from(text);
      files.set(file, Buffer.concat([read(file), bytes]));
      return bytes.length;
    },
    closeSync(fd) { assert.equal(this, fsImpl); touch('close', [fd]); handles.delete(fd); },
    fsyncSync(fd) { assert.equal(this, fsImpl); touch('fsync', [fd]); },
    truncateSync(file, length) {
      assert.equal(this, fsImpl); touch('truncate', [file, length]);
      const prior = read(file); const bytes = Buffer.alloc(length); prior.copy(bytes); files.set(file, bytes);
    },
    unlinkSync(file) { assert.equal(this, fsImpl); touch('unlink', [file]); read(file); files.delete(file); },
    existsSync(file) { assert.equal(this, fsImpl); touch('exists', [file]); return files.has(file); },
    renameSync(from, to) {
      assert.equal(this, fsImpl); touch('rename', [from, to]); files.set(to, read(from)); files.delete(from);
    },
    chmodSync(file, mode) { assert.equal(this, fsImpl); touch('chmod', [file, mode]); read(file); },
    readdirSync(root) {
      assert.equal(this, fsImpl); touch('list', [root]);
      return [...new Set([...files.keys()].filter(file => file.startsWith(root + path.sep))
        .map(file => file.slice(root.length + 1).split(path.sep)[0]))];
    },
  };
  if (options.missingPort) delete fsImpl[options.missingPort];
  const repository = implementation.createChatHistoryFileRepository({ dataDir: path.resolve('/tmp/multicc-history-differential'),
    fsImpl, appendEnabled: options.appendEnabled ?? true,
    writeText(file, text) { assert.equal(this, undefined); touch('rewrite', [file, text]); files.set(file, Buffer.from(text)); },
  });
  assert.equal(Object.isFrozen(repository), true);
  const rows = [{ id: 'a', role: 'user', deliveryId: 'd', content: '中文🦀\ud800' },
    { id: 'b', role: 'assistant', content: 'answer' }];
  return { repository, files, calls, failures, hooks, rows, fsImpl, error,
    raw(session, text) { files.set(repository.fileFor(session), Buffer.from(text)); },
  };
}
function outcome(operation) {
  try { return { value: operation() }; }
  catch (error) {
    return { error: error instanceof Error ? { name: error.name, message: error.message, code: error.code } : error };
  }
}
function snapshot(h) { return [...h.files].map(([file, body]) => [file, body.toString('hex')]).sort(); }
function pair(options) { return [harness(legacy, options), harness(native, options)]; }
function step(pair, label, operation) {
  const results = pair.map(h => outcome(() => operation(h)));
  assert.deepEqual(results[1], results[0], `${label}：结果`);
  assert.deepEqual(pair[1].calls, pair[0].calls, `${label}：文件调用顺序`);
  assert.deepEqual(snapshot(pair[1]), snapshot(pair[0]), `${label}：文件字节`);
  for (const h of pair) h.calls.length = 0;
  return results[1];
}

test('路径净化保留 UTF-16、假值与显式字符串转换规则', () => {
  for (const value of [undefined, null, false, 0, NaN, '', '../s:a', '字😀\ud800', -1, 23n, Symbol('s')]) {
    assert.deepEqual(outcome(() => native.safeSessionName(value)), outcome(() => legacy.safeSessionName(value)));
  }
  for (const implementation of [legacy, native]) {
    let n = 0;
    assert.equal(implementation.safeSessionName({ toString() { n += 1; return '../name'; } }), '___name');
    assert.equal(n, 1);
  }
});

test('旧数组、JSONL、BOM、空文件与尾行损坏读取差分', () => {
  const bodies = ['', ' \n\t', '\ufeff', '[]', '\ufeff [null,3,{"id":"a"}]', '[bad',
    '{}', '{}\n', '\ufeff{}\n', ' \r\n{}\r\n', '{"deliveryId":"d"}\n{"x":',
    '{"clientMsgId":"d"}\nnull', '{}\n[]', '{}\n3', '{}\nnull\n',
    '{}\nbad\n{}', '{}\n{bad\n', 'null', 'null\n', 'true', '{}\n \n', '\n{bad',
    '{"__proto__":{"x":1}}\n', '{"id":"a","content":"中文😀"}\n'];
  for (const body of bodies) {
    const p = pair();
    p.forEach(h => h.raw('s', body));
    for (const allowEmpty of [false, true]) step(p, JSON.stringify([body, allowEmpty]), h => h.repository.readStrict('s', { allowEmpty }));
    step(p, '普通读', h => h.repository.read('s'));
    step(p, '投递证明', h => h.repository.hasPersistedDelivery('s', 'd'));
  }
});

test('增量追加、尾部替换、清空、外部写入与关闭追加的端口差分', () => {
  for (const options of [{}, { appendEnabled: false }, { missingPort: 'truncateSync' }, { missingPort: 'fsyncSync' }]) {
    const p = pair(options);
    step(p, '首写', h => h.repository.write('s', [h.rows[0]]));
    step(p, '共享前缀追加', h => h.repository.write('s', h.rows));
    step(p, '相同记录不写', h => h.repository.write('s', h.rows));
    step(p, '替换尾部', h => h.repository.write('s', [h.rows[0], { ...h.rows[1], content: '新尾🦀' }]));
    step(p, '完全替换', h => h.repository.write('s', structuredClone(h.rows)));
    step(p, '缩短', h => h.repository.write('s', [h.rows[0]]));
    p.forEach(h => h.raw('s', '{}\n'));
    step(p, '外部尺寸变化', h => h.repository.write('s', h.rows));
    step(p, '清空', h => h.repository.write('s', []));
    step(p, '重复清空', h => h.repository.write('s', []));
    step(p, '清空后的严格证明', h => h.repository.hasPersistedDelivery('s', 'd'));
  }
});

test('每个写入故障出口保留异常身份，之后重写不信任旧偏移', () => {
  for (const op of ['stat', 'truncate', 'open', 'append', 'fsync', 'close', 'mkdir', 'rewrite']) {
    const p = pair();
    step(p, '建立偏移', h => h.repository.write('s', h.rows));
    step(p, `注入 ${op}`, h => {
      const denied = h.error('EIO'); h.failures.set(op, denied);
      const rows = ['mkdir', 'rewrite'].includes(op) ? [{ id: 'other' }] : [h.rows[0], { id: 'c' }];
      try { return h.repository.write('s', rows); }
      catch (error) { assert.equal(error, denied); throw error; }
    });
    step(p, '失败后恢复', h => h.repository.write('s', h.rows));
    step(p, '恢复后的证明', h => h.repository.hasPersistedDelivery('s', 'd'));
  }
  const p = pair();
  step(p, '首写', h => h.repository.write('s', [h.rows[0]]));
  step(p, 'close 错误覆盖 write 错误', h => {
    h.failures.set('append', h.error('EWRITE'));
    const close = h.error('ECLOSE'); h.failures.set('close', close);
    assert.throws(() => h.repository.write('s', h.rows), error => error === close);
  });
  step(p, '覆盖错误后恢复', h => h.repository.write('s', h.rows));
});

test('读盘错误不能变成持久投递证明；宽松 read 仍返回空', () => {
  for (const thrown of ['EACCES', 'ENOENT', null, undefined, 'failure']) {
    for (const action of ['read', 'readStrict', 'hasPersistedDelivery']) {
      const p = pair();
      step(p, `${action} ${thrown}`, h => {
        const error = typeof thrown === 'string' && thrown.startsWith('E') ? h.error(thrown) : thrown;
        h.failures.set('read', error);
        try { return h.repository[action]('s', action === 'hasPersistedDelivery' ? 'd' : undefined); }
        catch (caught) { assert.equal(caught, error); throw caught; }
      });
    }
  }
});

test('可见性校验、重命名与删除的部分失败顺序保持', () => {
  for (const body of ['null', '{}', '{"version":2,"hiddenIds":[]}', '{"version":1,"hiddenIds":[1]}',
    '{"version":1,"hiddenIds":["a"],"extra":true}', 'broken']) {
    const p = pair();
    p.forEach(h => h.files.set(h.repository.visibilityFileFor('s'), Buffer.from(body)));
    step(p, '可见性读', h => h.repository.readVisibility('s'));
  }
  for (const fail of [null, 'mkdir', 'read', 'rewrite', 'rename', 'unlink', 'chmod']) {
    const p = pair();
    step(p, '建历史', h => h.repository.write('s', h.rows));
    step(p, '建视图', h => h.repository.writeVisibility('s', { version: 1, hiddenIds: ['a'] }));
    step(p, `重命名 ${fail}`, h => {
      if (fail) h.failures.set(fail, h.error('EIO'));
      return h.repository.renameSession('s', 't');
    });
    step(p, '列举', h => h.repository.listSessionIds());
    step(p, '旧名重新写', h => h.repository.write('s', h.rows));
    step(p, '删除旧名', h => h.repository.deleteSession('s'));
    step(p, '再删一次', h => h.repository.deleteSession('s'));
  }
  const p = pair();
  step(p, '只有视图', h => h.repository.writeVisibility('s', { version: 1, hiddenIds: [] }));
  step(p, '保留旧版缺历史时不删除视图行为', h => h.repository.deleteSession('s'));
});

test('序列化异常、稀疏数组及 UTF-16 字节偏移与旧版相同', () => {
  for (const factory of [() => [undefined], () => [1n], () => Array(2), () => [{ content: '\ud800中文😀' }],
    () => [{ toJSON() { return { id: 'a', content: '替换' }; } }],
    () => { const x = {}; x.self = x; return [x]; }]) {
    const p = pair();
    step(p, '特殊输入', h => h.repository.write('s', factory()));
    step(p, '异常后写', h => h.repository.write('s', h.rows));
    step(p, '异常后追加', h => h.repository.write('s', [...h.rows, { id: 'c' }]));
  }
});

test('文件回调同步重入不持有 Rust 可变借用，外层成功记录顺序不变', () => {
  const p = pair();
  step(p, '重入 rewrite', h => {
    h.hooks.set('rewrite', () => h.repository.write('nested', h.rows));
    return h.repository.write('s', [h.rows[0]]);
  });
  step(p, '重入 stat', h => {
    h.hooks.set('stat', () => h.repository.write('s', [{ id: 'nested-write' }]));
    return h.repository.write('s', h.rows);
  });
  step(p, '重入后恢复', h => h.repository.write('s', [h.rows[0], { id: 'last' }]));
});

test('400 步固定种子多会话混合操作逐步比较文件与调用轨迹', () => {
  const p = pair();
  p.forEach(h => { h.histories = new Map(); });
  let seed = 0x9d131a;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let index = 0; index < 400; index += 1) {
    const id = `s${random() % 5}`;
    const operation = random() % 10;
    step(p, `${index} ${operation} ${id}`, h => {
      let rows = h.histories.get(id) || [];
      if (operation < 5) {
        if (operation < 2) rows = [...rows, { id: `${index}`, content: `内容🦀${index}`, deliveryId: `d${index}` }];
        else if (operation === 2) rows = rows.slice(1);
        else if (operation === 3) rows = [...rows.slice(0, -1), { id: `tail${index}` }];
        else rows = structuredClone(rows);
        h.histories.set(id, rows);
        return h.repository.write(id, rows);
      }
      if (operation === 5) return h.repository.readStrict(id);
      if (operation === 6) return h.repository.hasPersistedDelivery(id, `d${index - 1}`);
      if (operation === 7) return h.repository.deleteSession(id);
      if (operation === 8) return h.repository.renameSession(id, `${id}-moved`);
      return h.repository.listSessionIds();
    });
  }
});

test('已写前缀不重新序列化，失败后仅恢复路径重写全部内容', () => {
  const p = pair();
  p.forEach(h => {
    h.serializations = [];
    h.rows = [0, 1, 2].map(id => ({ id, toJSON() { h.serializations.push(id); return { id, content: '大正文'.repeat(4096) }; } }));
  });
  step(p, '首写', h => h.repository.write('s', [h.rows[0]]));
  step(p, '追加', h => h.repository.write('s', h.rows.slice(0, 2)));
  step(p, '相同引用不写', h => h.repository.write('s', h.rows.slice(0, 2)));
  step(p, '替换尾部', h => h.repository.write('s', [h.rows[0], h.rows[2]]));
  for (const h of p) assert.deepEqual(h.serializations, [0, 1, 2]);
});

test('删除视图时路径转换的 ENOENT 与 unlink 的 ENOENT 同属内层 catch', () => {
  const p = pair();
  step(p, '首写', h => h.repository.write('s', h.rows));
  step(p, '第二次路径转换失败', h => {
    let calls = 0;
    const id = { toString() { if (++calls === 2) throw h.error('ENOENT'); return 's'; } };
    return h.repository.deleteSession(id);
  });
});

test('短写、同尺寸外部覆盖和异常迭代器保持既有行为，不冒充增强的持久化保证', () => {
  const p = pair();
  step(p, '自定义迭代器', h => {
    const rows = h.rows.slice();
    rows[Symbol.iterator] = function* () { yield this[0]; };
    return h.repository.write('s', rows);
  });
  step(p, '迭代器后缩短尾部', h => h.repository.write('s', [h.rows[0], h.rows[1], { id: 'new' }]));
  const q = pair();
  step(q, '首写', h => h.repository.write('s', [h.rows[0]]));
  q.forEach(h => {
    const file = h.repository.fileFor('s');
    const original = h.files.get(file).toString();
    h.files.set(file, Buffer.from(original.replace('"id":"a"', '"id":"z"')));
  });
  step(q, '同尺寸覆盖保留尺寸判据', h => h.repository.write('s', h.rows));
  step(q, '短写保留返回契约', h => {
    h.fsImpl.writeSync = function (fd, text) { return 0; };
    return h.repository.write('s', [...h.rows, { id: 'short' }]);
  });
  step(q, '短写后按尺寸回退重写', h => h.repository.write('s', h.rows));
});
