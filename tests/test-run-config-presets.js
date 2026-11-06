'use strict';

// 运行配置预设路由（src/routes/run-config-presets.js）：Rust 归一化/合并由
// 原生单测覆盖，这里只钉接线 —— 文件读写、请求体校验、状态码与响应形状。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mountRunConfigPresetsRoutes,
  MAX_BODY_ENTRIES,
} = require('../src/routes/run-config-presets');

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
}

async function invoke(app, method, route, body) {
  const handler = app.routes.get(`${method} ${route}`);
  assert.equal(typeof handler, 'function', `missing ${method} ${route}`);
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler({ body }, response);
  return response;
}

function memoryFs(initial) {
  let content = initial;
  return {
    get content() { return content; },
    readFileSync() {
      if (content == null) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return content;
    },
  };
}

function fakeNative() {
  const calls = { normalize: [], merge: [] };
  return {
    calls,
    normalizeRunConfigPresets(input) {
      calls.normalize.push(JSON.parse(input));
      const list = JSON.parse(input).presets || [];
      return JSON.stringify({ presets: list });
    },
    mergeRunConfigPresets(input) {
      calls.merge.push(JSON.parse(input));
      const { stored = [], incoming = [] } = JSON.parse(input);
      return JSON.stringify({ presets: [...incoming, ...stored] });
    },
  };
}

function fixture({ file = null, native = fakeNative(), getNative, writeError = null } = {}) {
  const app = fakeApp();
  const fs = memoryFs(file);
  const writes = [];
  mountRunConfigPresetsRoutes(app, {
    file: '/runtime/run-config-presets.json',
    fs,
    getNative: getNative || (() => native),
    write(target, value) {
      if (writeError) throw writeError;
      writes.push({ target, value });
    },
  });
  return { app, fs, writes, native };
}

const preset = {
  id: 'p1',
  name: '主力池',
  protocol: 'anthropic',
  candidates: [
    { providerId: 'zhipu', cli: 'claude', model: 'glm-4.6', priority: 1 },
    { providerId: 'anyrouter', cli: 'claude', model: null, priority: 2 },
  ],
};

test('GET 在文件缺失时返回空表，并把空数组交给归一化', async () => {
  const { app, native } = fixture();
  const res = await invoke(app, 'GET', '/api/run-config/presets');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, presets: [] });
  assert.deepEqual(native.calls.normalize, [{ presets: [] }]);
});

test('GET 读回已有文件里的 presets 再归一化', async () => {
  const { app, native } = fixture({ file: JSON.stringify({ version: 1, presets: [preset] }) });
  const res = await invoke(app, 'GET', '/api/run-config/presets');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.presets, [preset]);
  assert.deepEqual(native.calls.normalize, [{ presets: [preset] }]);
});

test('PUT 整表替换：写 version+presets 并返回归一化结果', async () => {
  const { app, writes } = fixture();
  const res = await invoke(app, 'PUT', '/api/run-config/presets', { presets: [preset] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, presets: [preset] });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    target: '/runtime/run-config-presets.json',
    value: { version: 1, presets: [preset] },
  });
});

test('POST /merge 把已存条目与本机条目一起交给 Rust', async () => {
  const stored = { ...preset, id: 'p0', name: '服务端已有' };
  const { app, native, writes } = fixture({ file: JSON.stringify({ version: 1, presets: [stored] }) });
  const res = await invoke(app, 'POST', '/api/run-config/presets/merge', { presets: [preset] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(native.calls.merge, [{ stored: [stored], incoming: [preset] }]);
  assert.deepEqual(res.body.presets, [preset, stored]);
  assert.deepEqual(writes[0].value.presets, [preset, stored]);
});

test('请求体不是数组或超过上限 → 400，且不落盘', async () => {
  const { app, writes } = fixture();
  const missing = await invoke(app, 'PUT', '/api/run-config/presets', {});
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.code, 'invalid_presets');

  const tooMany = await invoke(app, 'PUT', '/api/run-config/presets', {
    presets: Array.from({ length: MAX_BODY_ENTRIES + 1 }, () => preset),
  });
  assert.equal(tooMany.statusCode, 400);
  assert.equal(tooMany.body.code, 'invalid_presets');
  assert.equal(writes.length, 0);
});

test('原生模块缺失 → 503，客户端可退回本机缓存', async () => {
  const { app } = fixture({ getNative: () => { throw new Error('rust_backend_unavailable'); } });
  for (const [method, route] of [
    ['GET', '/api/run-config/presets'],
    ['PUT', '/api/run-config/presets'],
    ['POST', '/api/run-config/presets/merge'],
  ]) {
    const res = await invoke(app, method, route, { presets: [] });
    assert.equal(res.statusCode, 503, `${method} ${route}`);
    assert.equal(res.body.code, 'rust_backend_unavailable');
  }
});

test('写入失败 → 500，不谎报成功', async () => {
  const { app } = fixture({ writeError: new Error('disk full') });
  const res = await invoke(app, 'PUT', '/api/run-config/presets', { presets: [preset] });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'preset_store_write_failed');
});
