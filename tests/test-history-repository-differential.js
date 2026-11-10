'use strict';

// 迁移差分：冻结旧仓库（真实 Node fs + 真实 atomicWriteText）与原生仓库
// 各自在独立的真实临时根上执行同一操作，逐步比较返回值、抛出错误和整个
// 磁盘状态（相对路径、字节、权限位）。不再存在可注入端口。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const legacy = require('./helpers/legacy-chat-history-file-repository');
const native = require('../src/session/adapters/chat-history-file-repository');
const stateStore = require('../src/state/store');

const workingDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  workingDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of workingDirs) {
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

function build(implementation, { appendEnabled = true } = {}) {
  const dataDir = tempDir('multicc-history-diff-');
  const repository = implementation.createChatHistoryFileRepository({ dataDir, appendEnabled });
  return { dataDir, repository, root: repository.root, reports: [] };
}
function pair(options = {}) {
  const implementations = [build(legacy, options), build(native, options)];
  assert.equal(Object.isFrozen(implementations[1].repository), true);
  return implementations;
}

function abs(harness, relative) {
  return path.join(harness.repository.root, relative);
}
function ensureRoot(harness) {
  fs.mkdirSync(harness.repository.root, { recursive: true, mode: 0o700 });
}
function putFile(harness, relative, body, mode = 0o600) {
  const target = abs(harness, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, body, { mode });
}
function setRootMode(harness, mode) {
  fs.chmodSync(harness.repository.root, mode);
}
function chmod(harness, relative, mode) {
  fs.chmodSync(abs(harness, relative), mode);
}
function readHex(harness, relative) {
  return fs.readFileSync(abs(harness, relative)).toString('hex');
}
function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function snapshot(harness) {
  const root = harness.repository.root;
  const rows = [];
  const visit = (directory, relative) => {
    rows.push({ path: relative || '.', kind: 'dir', mode: fs.statSync(directory).mode & 0o777 });
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(target, child);
      else if (entry.isFile()) {
        rows.push({ path: child, kind: 'file', mode: fs.statSync(target).mode & 0o777,
          hex: fs.readFileSync(target).toString('hex') });
      } else rows.push({ path: child, kind: 'other' });
    }
  };
  if (!fs.existsSync(root)) return rows;
  const stat = fs.lstatSync(root);
  if (stat.isDirectory()) visit(root, '');
  else rows.push({ path: '.', kind: 'file', mode: stat.mode & 0o777,
    hex: fs.readFileSync(root).toString('hex') });
  return rows;
}

function normalize(value, root) {
  if (typeof value === 'string') {
    return value.split(root).join('<root>').replace(/\.tmp\.\d+\.\d+/g, '.tmp.<pid>.<n>');
  }
  if (Array.isArray(value)) return value.map(item => normalize(item, root));
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value)) result[key] = normalize(value[key], root);
    return result;
  }
  return value;
}

function describeError(error) {
  if (error instanceof Error) {
    const result = { name: error.name, message: error.message };
    for (const key of ['code', 'errno', 'syscall', 'path', 'dest']) {
      if (error[key] !== undefined) result[key] = error[key];
    }
    return result;
  }
  return { thrown: error === undefined ? '<undefined>' : error };
}

function normalizeError(error, root) {
  const described = describeError(error);
  for (const key of ['message', 'path', 'dest']) {
    if (typeof described[key] === 'string') described[key] = normalize(described[key], root);
  }
  return described;
}

// Each operation runs under a harness-scoped failure reporter, the same port
// `server.js` installs (metric + logger). Both implementations must report the
// same calls: count, operation, target and error fields.
function outcome(harness, operation, reporter) {
  const record = reporter || ((error, meta) => {
    harness.reports.push({
      operation: meta && meta.operation,
      target: typeof meta?.target === 'string' ? normalize(meta.target, harness.root) : meta?.target,
      error: normalizeError(error, harness.root),
    });
  });
  stateStore.setFailureReporter(record);
  try {
    return { value: normalize(operation(), harness.root) };
  } catch (error) {
    return { error: normalizeError(error, harness.root) };
  } finally {
    stateStore.setFailureReporter(null);
  }
}

function step(implementations, label, operation) {
  const results = implementations.map(harness => outcome(harness, () => operation(harness)));
  assert.deepEqual(results[1], results[0], `${label}：结果`);
  assert.deepEqual(implementations[1].reports, implementations[0].reports, `${label}：失败上报`);
  for (const harness of implementations) harness.reports = [];
  assert.deepEqual(snapshot(implementations[1]), snapshot(implementations[0]), `${label}：磁盘`);
  return results[1];
}

// 同 step，但把已比较过的失败上报记录交还调用方做显式断言。
function stepReports(implementations, label, operation) {
  const results = implementations.map(harness => outcome(harness, () => operation(harness)));
  assert.deepEqual(results[1], results[0], `${label}：结果`);
  assert.deepEqual(implementations[1].reports, implementations[0].reports, `${label}：失败上报`);
  assert.deepEqual(snapshot(implementations[1]), snapshot(implementations[0]), `${label}：磁盘`);
  const reports = implementations[1].reports;
  for (const harness of implementations) harness.reports = [];
  return { result: results[1], reports };
}

function expectError(result, code) {
  assert.ok(result.error, `期望抛出 ${code}`);
  assert.equal(result.error.code, code);
  return result;
}

function expectOneOf(result, codes) {
  assert.ok(result.error, `期望抛出 ${codes.join('/')}`);
  assert.ok(codes.includes(result.error.code), `实际 ${result.error.code}`);
  return result;
}

const rows = [
  { id: 'a', role: 'user', deliveryId: 'd', content: '中文🦀\ud800' },
  { id: 'b', role: 'assistant', content: 'answer' },
];

test('路径净化保留 UTF-16、假值与显式字符串转换规则', () => {
  const sentinel = { root: '/__not/a/real/root__' };
  for (const value of [undefined, null, false, 0, NaN, '', '../s:a', '字😀\ud800', -1, 23n, Symbol('s')]) {
    assert.deepEqual(outcome(sentinel, () => native.safeSessionName(value)),
      outcome(sentinel, () => legacy.safeSessionName(value)));
  }
  for (const implementation of [legacy, native]) {
    let calls = 0;
    assert.equal(implementation.safeSessionName({ toString() { calls += 1; return '../name'; } }), '___name');
    assert.equal(calls, 1);
  }
});

test('旧数组、JSONL、BOM、空文件、尾行损坏与非法 UTF-8 读取差分', () => {
  const bodies = ['', ' \n\t', '﻿', '[]', '﻿ [null,3,{"id":"a"}]', '[bad',
    '{}', '{}\n', '﻿{}\n', ' \r\n{}\r\n', '{"deliveryId":"d"}\n{"x":',
    '{"clientMsgId":"d"}\nnull', '{}\n[]', '{}\n3', '{}\nnull\n',
    '{}\nbad\n{}', '{}\n{bad\n', 'null', 'null\n', 'true', '{}\n \n', '\n{bad',
    '{"__proto__":{"x":1}}\n', '{"id":"a","content":"中文😀"}\n',
    '{"id":"a","content":"🦀"}\n{"id":"b","content":"中文"}\n',
    Buffer.from([0xff, 0xfe, 0x41]), Buffer.from([0xef, 0xbb, 0xbf, 0x5b, 0x5d]),
    Buffer.from([0xed, 0xa0, 0x80, 0x0a]), Buffer.from([0xc3, 0x28]),
    Buffer.from([0xe2, 0x82]), Buffer.from([0xf0, 0x9f, 0xa6, 0x80])];
  for (const body of bodies) {
    const implementations = pair();
    for (const harness of implementations) putFile(harness, 's.json', body);
    for (const allowEmpty of [false, true]) {
      step(implementations, `${JSON.stringify(body.toString('hex'))} allowEmpty=${allowEmpty}`,
        harness => harness.repository.readStrict('s', { allowEmpty }));
    }
    step(implementations, '普通读', harness => harness.repository.read('s'));
    step(implementations, '投递证明', harness => harness.repository.hasPersistedDelivery('s', 'd'));
  }
});

test('增量追加、尾部替换、清空、外部写入与关闭追加差分', () => {
  for (const options of [{}, { appendEnabled: false }]) {
    const implementations = pair(options);
    step(implementations, '首写', harness => harness.repository.write('s', [rows[0]]));
    step(implementations, '共享前缀追加', harness => harness.repository.write('s', rows));
    step(implementations, '相同记录不写', harness => harness.repository.write('s', rows));
    step(implementations, '替换尾部', harness => harness.repository.write('s', [rows[0], { ...rows[1], content: '新尾🦀' }]));
    step(implementations, '完全替换', harness => harness.repository.write('s', structuredClone(rows)));
    step(implementations, '缩短', harness => harness.repository.write('s', [rows[0]]));
    step(implementations, '外部尺寸变化', harness => {
      fs.appendFileSync(abs(harness, 's.json'), '{"external":true}\n');
      return harness.repository.write('s', rows);
    });
    step(implementations, '清空', harness => harness.repository.write('s', []));
    step(implementations, '重复清空', harness => harness.repository.write('s', []));
    step(implementations, '清空后的严格证明', harness => harness.repository.hasPersistedDelivery('s', 'd'));
  }
});

test('文件路径与可见性路径按会话净化规则生成', () => {
  const implementations = pair();
  for (const session of ['../unsafe', '字😀\ud800', '', { toString() { return 'obj:name'; } }]) {
    step(implementations, `fileFor ${JSON.stringify(String(session))}`, harness => harness.repository.fileFor(session));
    step(implementations, `visibilityFileFor ${JSON.stringify(String(session))}`, harness => harness.repository.visibilityFileFor(session));
  }
});

test('同尺寸外部覆盖是既有已知限制：双方都信任尺寸并追加', () => {
  const implementations = pair();
  step(implementations, '首写', harness => harness.repository.write('s', [rows[0]]));
  for (const harness of implementations) {
    const file = abs(harness, 's.json');
    const before = fs.readFileSync(file);
    const body = before.toString('utf8').replace('"content":"中文🦀\\ud800"', '"content":"外部覆盖🦀"');
    const after = Buffer.from(body);
    assert.equal(after.length, before.length, '外部覆盖必须保持同尺寸');
    fs.writeFileSync(file, after, { mode: 0o600 });
  }
  step(implementations, '同尺寸后追加', harness => harness.repository.write('s', rows));
  // 这是兼容旧协议的已知限制，不是本批新增语义：外部同尺寸覆盖不会被发现。
  assert.ok(readHex(implementations[1], 's.json')
    .includes(Buffer.from('外部覆盖🦀').toString('hex')));
});

test('写入失败后偏移账本被清除，下一次写入不信任旧偏移', { skip: isRoot() }, () => {
  const implementations = pair();
  step(implementations, '建立偏移', harness => harness.repository.write('s', [rows[0]]));
  step(implementations, '只读文件令追加失败', harness => {
    chmod(harness, 's.json', 0o400);
    try { return harness.repository.write('s', rows); }
    finally { chmod(harness, 's.json', 0o600); }
  });
  step(implementations, '同尺寸外部覆盖（旧账本若被信任会保留外部内容）', harness => {
    const file = abs(harness, 's.json');
    const body = fs.readFileSync(file);
    const replaced = Buffer.from(body.toString('utf8').replace('中文🦀\\ud800', '外部篡改🦀'));
    assert.equal(replaced.length, body.length);
    fs.writeFileSync(file, replaced, { mode: 0o600 });
  });
  step(implementations, '恢复写入', harness => harness.repository.write('s', rows));
  assert.equal(fs.readFileSync(abs(implementations[1], 's.json'), 'utf8').includes('外部篡改'), false);
  assert.deepEqual(implementations[1].repository.read('s'), rows);

  const tail = pair();
  step(tail, '建立偏移', harness => harness.repository.write('s', [rows[0]]));
  step(tail, '只读文件令尾部替换失败', harness => {
    chmod(harness, 's.json', 0o400);
    try { return harness.repository.write('s', [rows[0], { ...rows[1], content: '替换尾' }]); }
    finally { chmod(harness, 's.json', 0o600); }
  });
  step(tail, '恢复写入', harness => harness.repository.write('s', rows));
});

test('历史主文件是目录时读取与写入都报 EISDIR', () => {
  const implementations = pair();
  for (const harness of implementations) {
    ensureRoot(harness);
    fs.mkdirSync(abs(harness, 's.json'));
  }
  expectError(step(implementations, 'strict 读', harness => harness.repository.readStrict('s')), 'EISDIR');
  assert.deepEqual(step(implementations, '宽松读', harness => harness.repository.read('s')), { value: [] });
  expectError(step(implementations, '投递证明', harness => harness.repository.hasPersistedDelivery('s', 'd')), 'EISDIR');
  expectError(step(implementations, '写入', harness => harness.repository.write('s', [rows[0]])), 'EISDIR');
  assert.deepEqual(step(implementations, '列举', harness => harness.repository.listSessionIds()), { value: ['s'] });
  // macOS unlink(dir) 是 EPERM，Linux 是 EISDIR。
  expectOneOf(step(implementations, '删除', harness => harness.repository.deleteSession('s')), ['EPERM', 'EISDIR']);
});

test('可见性文件是目录时读取与写入都报 EISDIR', () => {
  const implementations = pair();
  for (const harness of implementations) {
    ensureRoot(harness);
    fs.mkdirSync(abs(harness, '.views'));
    fs.mkdirSync(abs(harness, '.views/s.json'));
  }
  expectError(step(implementations, '可见性读', harness => harness.repository.readVisibility('s')), 'EISDIR');
  expectError(step(implementations, '可见性写', harness => harness.repository
    .writeVisibility('s', { version: 1, hiddenIds: [] })), 'EISDIR');
});

test('数据根是普通文件时 mkdir/scandir/open/unlink 的错误形状', () => {
  const implementations = pair();
  for (const harness of implementations) fs.writeFileSync(harness.repository.root, 'root', { mode: 0o600 });
  // 写入先走 ensureRoot/ensurePrivateDir：递归 mkdir 对已存在的普通文件报 EEXIST。
  expectError(step(implementations, '写入', harness => harness.repository.write('s', [rows[0]])), 'EEXIST');
  expectError(step(implementations, '列举', harness => harness.repository.listSessionIds()), 'ENOTDIR');
  expectError(step(implementations, 'strict 读', harness => harness.repository.readStrict('s')), 'ENOTDIR');
  expectError(step(implementations, '投递证明', harness => harness.repository.hasPersistedDelivery('s', 'd')), 'ENOTDIR');
  expectError(step(implementations, '可见性读', harness => harness.repository.readVisibility('s')), 'ENOTDIR');
  expectError(step(implementations, '可见性写', harness => harness.repository
    .writeVisibility('s', { version: 1, hiddenIds: [] })), 'ENOTDIR');
  expectError(step(implementations, '删除', harness => harness.repository.deleteSession('s')), 'ENOTDIR');
  assert.equal(step(implementations, '重命名', harness => harness.repository.renameSession('a', 'b')).value, false);
});

test('只读目录/文件的真实权限故障', { skip: isRoot() }, () => {
  const implementations = pair();
  step(implementations, '建立历史', harness => harness.repository.write('s', [rows[0]]));
  expectError(step(implementations, '只读文件读取报 EACCES', harness => {
    chmod(harness, 's.json', 0o000);
    try { return harness.repository.readStrict('s'); }
    finally { chmod(harness, 's.json', 0o600); }
  }), 'EACCES');
  assert.deepEqual(step(implementations, '只读文件宽松读仍返回空', harness => {
    chmod(harness, 's.json', 0o000);
    try { return harness.repository.read('s'); }
    finally { chmod(harness, 's.json', 0o600); }
  }).value, []);
  expectError(step(implementations, '只读文件投递证明抛错', harness => {
    chmod(harness, 's.json', 0o000);
    try { return harness.repository.hasPersistedDelivery('s', 'd'); }
    finally { chmod(harness, 's.json', 0o600); }
  }), 'EACCES');
  expectError(step(implementations, '只读目录删除报 EACCES', harness => {
    setRootMode(harness, 0o500);
    try { return harness.repository.deleteSession('s'); }
    finally { setRootMode(harness, 0o700); }
  }), 'EACCES');
  // rename 的 EACCES 不可在自有目录上产生：重命名前 ensureRoot 会把 0700 恢复。
});

// 历史写入失败必须仍走 Node 的持久化上报端口（server.js 装的 metric+logger），
// 而且只在旧 writeTextAtomic 会上报的位置上报。这里直接比对上报记录内容。
test('原子重写失败的持久化上报与旧实现逐次一致', { skip: isRoot() }, () => {
  // EISDIR：临时文件重命名覆盖一个目录。
  const renameFault = pair();
  for (const harness of renameFault) {
    ensureRoot(harness);
    fs.mkdirSync(abs(harness, 's.json'));
  }
  const eisdir = stepReports(renameFault, '目标为目录', harness => harness.repository.write('s', [rows[0]]));
  expectError(eisdir.result, 'EISDIR');
  assert.equal(eisdir.reports.length, 1);
  assert.equal(eisdir.reports[0].operation, 'atomic_write');
  assert.equal(eisdir.reports[0].target, '<root>/s.json');
  assert.equal(eisdir.reports[0].error.code, 'EISDIR');
  assert.equal(eisdir.reports[0].error.errno, -21);
  assert.equal(eisdir.reports[0].error.syscall, 'rename');
  assert.equal(eisdir.reports[0].error.path, '<root>/s.json.tmp.<pid>.<n>');
  assert.equal(eisdir.reports[0].error.dest, '<root>/s.json');

  // EACCES：只读主文件使追加失败。旧实现的追加不开 compose 上报，双方都必须是零次。
  const appendFault = pair();
  step(appendFault, '建立偏移', harness => harness.repository.write('s', [rows[0]]));
  const eacces = stepReports(appendFault, '只读文件追加', harness => {
    chmod(harness, 's.json', 0o400);
    try { return harness.repository.write('s', rows); }
    finally { chmod(harness, 's.json', 0o600); }
  });
  expectError(eacces.result, 'EACCES');
  assert.equal(eacces.reports.length, 0);
});

test('失败上报器自身抛错不会改变对调用方抛出的错误', () => {
  const implementations = pair();
  for (const harness of implementations) {
    ensureRoot(harness);
    fs.mkdirSync(abs(harness, 's.json'));
  }
  let calls = 0;
  const throwing = () => { calls += 1; throw new Error('reporter boom'); };
  const results = implementations.map(harness =>
    outcome(harness, () => harness.repository.write('s', [rows[0]]), throwing));
  assert.deepEqual(results[1], results[0]);
  expectError(results[1], 'EISDIR');
  assert.equal(calls, 2);
});

test('可见性读写、校验、重命名侧文件、删除与列举', () => {
  const bodies = ['null', '{}', 'true', '3', '"x"', '[]', '﻿{}',
    '{"version":2,"hiddenIds":[]}', '{"version":1,"hiddenIds":[1]}',
    '{"version":1,"hiddenIds":["a"],"extra":true}', 'broken'];
  for (const body of bodies) {
    const implementations = pair();
    for (const harness of implementations) putFile(harness, '.views/s.json', body);
    step(implementations, `可见性读 ${body}`, harness => harness.repository.readVisibility('s'));
  }

  const invalid = pair();
  step(invalid, '禁止序列化的状态', harness => harness.repository
    .writeVisibility('s', { version: 1, hiddenIds: [1n] }));
  step(invalid, 'toJSON 抛错', harness => harness.repository.writeVisibility('s', { toJSON() { throw new Error('toJSON'); } }));

  // 旧实现先 String(JSON.stringify(state))，所以 undefined 状态会写成
  // "undefined"（随后读取是 JSON 语法错误），而不是抛参数类型错误。
  const undefinedState = pair();
  step(undefinedState, '写入 undefined 状态', harness => harness.repository.writeVisibility('s', undefined));
  assert.equal(readHex(undefinedState[1], '.views/s.json'), Buffer.from('undefined').toString('hex'));
  step(undefinedState, '读取 undefined 状态', harness => harness.repository.readVisibility('s'));

  // 只写视图时，历史根由递归 mkdir 隐式创建；Node 会把 0700 应用到每一级新建目录。
  const implicit = pair();
  step(implicit, '隐式创建历史根与视图目录', harness => harness.repository
    .writeVisibility('s', { version: 1, hiddenIds: [] }));
  assert.equal(fs.statSync(implicit[1].repository.root).mode & 0o777, 0o700);

  const implementations = pair();
  step(implementations, '可见性缺失', harness => harness.repository.readVisibility('s'));
  step(implementations, '写历史', harness => harness.repository.write('s', rows));
  step(implementations, '写可见性', harness => harness.repository.writeVisibility('s', { version: 1, hiddenIds: ['a'] }));
  step(implementations, '读可见性', harness => harness.repository.readVisibility('s'));
  step(implementations, '可见性重命名', harness => harness.repository.renameSession('s', 't'));
  step(implementations, '重命名后读新可见性', harness => harness.repository.readVisibility('t'));
  step(implementations, '重命名后读旧可见性', harness => harness.repository.readVisibility('s'));
  step(implementations, '目标已存在不能重命名', harness => {
    harness.repository.write('t', rows);
    return harness.repository.renameSession('s', 't');
  });
  step(implementations, '源缺失不能重命名', harness => harness.repository.renameSession('ghost', 'nobody'));
  step(implementations, '删除带视图的会话', harness => harness.repository.deleteSession('t'));
  step(implementations, '再次删除', harness => harness.repository.deleteSession('t'));

  const orphan = pair();
  step(orphan, '只有视图', harness => harness.repository.writeVisibility('s', { version: 1, hiddenIds: [] }));
  step(orphan, '主文件缺失时删除返回 false 且保留视图', harness => harness.repository.deleteSession('s'));

  const listing = pair();
  for (const harness of listing) {
    ensureRoot(harness);
    fs.writeFileSync(abs(harness, 'zzz.json'), '[]', { mode: 0o600 });
    fs.writeFileSync(abs(harness, 'aaa.json'), '[]', { mode: 0o600 });
    fs.writeFileSync(abs(harness, 'note.txt'), 'x', { mode: 0o600 });
    fs.mkdirSync(abs(harness, '.views'));
  }
  step(listing, '列举排序', harness => harness.repository.listSessionIds());
  const empty = pair();
  step(empty, '根缺失时列举为空', harness => harness.repository.listSessionIds());
});

test('删除时视图路径转换的 ENOENT 与 unlink 的 ENOENT 同属内层 catch', () => {
  const implementations = pair();
  step(implementations, '首写', harness => harness.repository.write('s', rows));
  step(implementations, '第二次路径转换失败', harness => {
    let calls = 0;
    const id = { toString() { if (++calls === 2) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return 's'; } };
    return harness.repository.deleteSession(id);
  });
});

test('序列化异常、稀疏数组、自定义迭代器与 UTF-16 内容差分', () => {
  const factories = [() => [undefined], () => [1n], () => Array(2), () => [{ content: '\ud800中文😀' }],
    () => [{ toJSON() { return { id: 'a', content: '替换' }; } }],
    () => { const value = {}; value.self = value; return [value]; }];
  for (const factory of factories) {
    const implementations = pair();
    step(implementations, '特殊输入', harness => harness.repository.write('s', factory()));
    step(implementations, '异常后写', harness => harness.repository.write('s', rows));
    step(implementations, '异常后追加', harness => harness.repository.write('s', [...rows, { id: 'c' }]));
  }

  const iterator = pair();
  step(iterator, '自定义迭代器', harness => {
    const value = rows.slice();
    value[Symbol.iterator] = function* () { yield this[0]; };
    return harness.repository.write('s', value);
  });
  step(iterator, '迭代器后缩短尾部', harness => iterator.repository.write('s', [rows[0], rows[1], { id: 'new' }]));
  step(iterator, '迭代器后相同内容', harness => iterator.repository.write('s', [rows[0], rows[1], { id: 'new' }]));
});

test('已写前缀不重新序列化', () => {
  const implementations = pair();
  for (const harness of implementations) {
    harness.serializations = [];
    harness.heavyRows = [0, 1, 2].map(id => ({ id,
      toJSON() { harness.serializations.push(id); return { id, content: '大正文'.repeat(4096) }; } }));
  }
  step(implementations, '首写', harness => harness.repository.write('s', [harness.heavyRows[0]]));
  step(implementations, '追加', harness => harness.repository.write('s', harness.heavyRows.slice(0, 2)));
  step(implementations, '相同引用不写', harness => harness.repository.write('s', harness.heavyRows.slice(0, 2)));
  step(implementations, '替换尾部', harness => harness.repository.write('s', [harness.heavyRows[0], harness.heavyRows[2]]));
  for (const harness of implementations) assert.deepEqual(harness.serializations, [0, 1, 2]);
});

test('400 步固定种子多会话混合操作逐步比较文件与结果', () => {
  const implementations = pair();
  for (const harness of implementations) harness.histories = new Map();
  let seed = 0x9d131a;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let index = 0; index < 400; index += 1) {
    const id = `s${random() % 5}`;
    const operation = random() % 10;
    step(implementations, `${index} ${operation} ${id}`, harness => {
      let messages = harness.histories.get(id) || [];
      if (operation < 5) {
        if (operation < 2) messages = [...messages, { id: `${index}`, content: `内容🦀${index}`, deliveryId: `d${index}` }];
        else if (operation === 2) messages = messages.slice(1);
        else if (operation === 3) messages = [...messages.slice(0, -1), { id: `tail${index}` }];
        else messages = structuredClone(messages);
        harness.histories.set(id, messages);
        return harness.repository.write(id, messages);
      }
      if (operation === 5) return harness.repository.readStrict(id, { allowEmpty: true });
      if (operation === 6) return harness.repository.hasPersistedDelivery(id, `d${index - 1}`);
      if (operation === 7) return harness.repository.deleteSession(id);
      if (operation === 8) return harness.repository.renameSession(id, `${id}-moved`);
      return harness.repository.listSessionIds();
    });
  }
});
