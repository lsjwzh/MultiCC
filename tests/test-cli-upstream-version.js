'use strict';

// src/cli/cli-upstream-version.js — 「上游发布了什么版本」。
//
// 这一组的判据只有一条: **不知道就说不知道**。网络失败、404、限流页、二进制
// 乱码都必须回 null, 绝不能猜一个版本号出来 —— 因为下游拿它和本地版本做比较,
// 猜错会直接变成一个假的「有新版本」角标。

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const upstream = require('../src/cli/cli-upstream-version');

function fakeResponse(statusCode, body, headers = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  res.setEncoding = () => {};
  res.resume = () => {};
  res.destroy = () => {};
  // setImmediate 而不是 nextTick: 正文必须等到 'response' 的同步处理器挂好
  // data/end 监听之后再发, 否则事件打在空气里, 被读方会永远等下去。
  setImmediate(() => {
    if (body != null) res.emit('data', body);
    res.emit('end');
  });
  return res;
}

// https 的最小替身: reply 可以是 response 对象, 也可以是 (req, url) => void 用来
// 模拟 error / timeout / 多跳重定向。
function fakeHttps(reply) {
  const requests = [];
  return {
    requests,
    get(url, options) {
      const req = new EventEmitter();
      req.destroy = () => {};
      requests.push({ url, options });
      process.nextTick(() => {
        const response = typeof reply === 'function' ? reply(req, url) : reply;
        if (response) req.emit('response', response);
      });
      return req;
    },
  };
}

test('semver parsing rejects anything that is not x.y.z', () => {
  assert.deepEqual(upstream.parseSemver('2.1.251').parts, [2, 1, 251]);
  assert.deepEqual(upstream.parseSemver('v1.2.3').parts, [1, 2, 3]);
  assert.equal(upstream.parseSemver('1.2.3-beta.1').prerelease, true);
  assert.equal(upstream.parseSemver('1.2'), null);
  assert.equal(upstream.parseSemver('latest'), null);
  assert.equal(upstream.parseSemver(''), null);
  assert.equal(upstream.parseSemver(null), null);
});

test('semver comparison only ever moves forward into an update', () => {
  assert.equal(upstream.compareSemver('2.1.251', '2.1.251'), 0);
  assert.equal(upstream.compareSemver('2.1.250', '2.1.251'), -1);
  assert.equal(upstream.compareSemver('1.10.0', '1.9.9'), 1, '按数字比, 不按字典序');
  // 本地预发布 -> 上游正式版是升级
  assert.equal(upstream.compareSemver('1.2.3-beta', '1.2.3'), -1);
  // 上游发了 beta 不算「可升级」, 否则稳定版用户会被催着降级到 beta
  assert.equal(upstream.compareSemver('1.2.3', '1.2.3-beta'), 1);
  assert.equal(upstream.compareSemver('not-a-version', '1.0.0'), 0);
});

test('the registry base follows npm_config_registry so mirror users compare like with like', () => {
  assert.equal(upstream.resolveRegistryBase({}), upstream.DEFAULT_REGISTRY);
  assert.equal(upstream.resolveRegistryBase({ npm_config_registry: 'https://registry.npmmirror.com' }),
    'https://registry.npmmirror.com/');
  assert.equal(upstream.resolveRegistryBase({ NPM_CONFIG_REGISTRY: 'https://r.example.com/' }),
    'https://r.example.com/');
  // 不是 URL 就退回官方源, 而不是拼出一个坏 URL
  assert.equal(upstream.resolveRegistryBase({ npm_config_registry: 'not-a-url' }), upstream.DEFAULT_REGISTRY);
});

test('scoped package names keep their @ and escape only the slash', () => {
  assert.equal(
    upstream.latestUrl('@anthropic-ai/claude-code', 'https://registry.npmjs.org/'),
    'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest',
  );
  assert.equal(upstream.latestUrl('opencode-ai', 'https://registry.npmjs.org/'),
    'https://registry.npmjs.org/opencode-ai/latest');
});

test('a 200 with a real version is the only happy path', async () => {
  const https = fakeHttps(fakeResponse(200, JSON.stringify({ name: 'x', version: '2.1.278' })));
  const version = await upstream.fetchLatestVersion('@anthropic-ai/claude-code', {
    httpsImpl: https, registryBase: 'https://registry.npmjs.org/',
  });
  assert.equal(version, '2.1.278');
  assert.equal(https.requests[0].url, 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest');
});

test('every failure shape resolves to null instead of a guessed version', async () => {
  const cases = [
    ['404', fakeResponse(404, '{"error":"Not found"}')],
    ['500', fakeResponse(500, 'boom')],
    ['not json', fakeResponse(200, '<html>rate limited</html>')],
    ['no version field', fakeResponse(200, JSON.stringify({ name: 'x' }))],
    ['version is not semver', fakeResponse(200, JSON.stringify({ version: 'next' }))],
    ['empty body', fakeResponse(200, '')],
  ];
  for (const [label, response] of cases) {
    const version = await upstream.fetchLatestVersion('opencode-ai', {
      httpsImpl: fakeHttps(response), registryBase: 'https://registry.npmjs.org/',
    });
    assert.equal(version, null, label);
  }
  // 传输层错误(ENOTFOUND / 超时 / DNS)同样只是 null
  const failing = fakeHttps(req => { process.nextTick(() => req.emit('error', new Error('ENOTFOUND'))); });
  assert.equal(await upstream.fetchLatestVersion('opencode-ai', {
    httpsImpl: failing, registryBase: 'https://registry.npmjs.org/',
  }), null);
  // 连 https.get 自己抛(非法 URL)也不能穿出去
  const throwing = { get() { throw new Error('Invalid URL'); } };
  assert.equal(await upstream.fetchLatestVersion('opencode-ai', {
    httpsImpl: throwing, registryBase: 'https://registry.npmjs.org/',
  }), null);
});

test('an oversized body is abandoned rather than buffered', async () => {
  const https = fakeHttps(fakeResponse(200, 'x'.repeat(300 * 1024)));
  const version = await upstream.fetchLatestVersion('opencode-ai', {
    httpsImpl: https, registryBase: 'https://registry.npmjs.org/',
  });
  assert.equal(version, null);
});

test('a redirecting registry is followed, but not forever', async () => {
  const hops = [];
  const https = {
    requests: hops,
    get(url) {
      const req = new EventEmitter();
      req.destroy = () => {};
      hops.push(url);
      process.nextTick(() => {
        if (hops.length === 1) {
          req.emit('response', fakeResponse(302, null, { location: 'https://cdn.example.com/x.json' }));
        } else {
          req.emit('response', fakeResponse(200, JSON.stringify({ version: '3.0.0' })));
        }
      });
      return req;
    },
  };
  assert.equal(await upstream.fetchLatestVersion('opencode-ai', {
    httpsImpl: https, registryBase: 'https://registry.npmjs.org/',
  }), '3.0.0');
  assert.equal(hops[1], 'https://cdn.example.com/x.json');

  // 环状重定向: 到达上限就放弃, 不能转圈转到进程被拖死
  const looping = { get() {
    const req = new EventEmitter();
    req.destroy = () => {};
    process.nextTick(() => req.emit('response', fakeResponse(302, null, { location: 'https://loop.example.com/' })));
    return req;
  } };
  assert.equal(await upstream.fetchLatestVersion('opencode-ai', {
    httpsImpl: looping, registryBase: 'https://registry.npmjs.org/',
  }), null);
});

test('only CLIs that ship as an npm package have a comparable source', () => {
  assert.equal(upstream.npmPackageFor('claude'), '@anthropic-ai/claude-code');
  assert.equal(upstream.npmPackageFor('claude-exp'), '@anthropic-ai/claude-agent-sdk');
  assert.equal(upstream.npmPackageFor('codex'), '@openai/codex');
  assert.equal(upstream.npmPackageFor('codex-exp'), '@openai/codex');
  assert.equal(upstream.npmPackageFor('codebuddy'), '@tencent-ai/codebuddy-code');
  // qoder 是 curl 脚本安装、zcode 是手动装桌面版: 没有可查的发布源
  assert.equal(upstream.npmPackageFor('qoder'), null);
  assert.equal(upstream.npmPackageFor('zcode'), null);
  assert.equal(upstream.npmPackageFor(''), null);
  assert.equal(upstream.npmPackageFor('CLAUDE'), '@anthropic-ai/claude-code', '大小写不敏感');
});

test('classifyUpdate keeps "unknown" apart from "up to date"', () => {
  assert.deepEqual(upstream.classifyUpdate('2.1.251', '2.1.260'),
    { latest: '2.1.260', updateAvailable: true });
  assert.deepEqual(upstream.classifyUpdate('2.1.251', '2.1.251'),
    { latest: '2.1.251', updateAvailable: false });
  // 本地有版本、上游查不到 -> 不能报成「已是最新」也不能报成「有更新」
  assert.deepEqual(upstream.classifyUpdate('2.1.251', null),
    { latest: null, updateAvailable: false });
  // 本地没解析出版本 -> 无论上游是什么都不下结论
  assert.deepEqual(upstream.classifyUpdate(null, '2.1.260'),
    { latest: '2.1.260', updateAvailable: false });
  assert.deepEqual(upstream.classifyUpdate('2.1.251', 'garbage'),
    { latest: null, updateAvailable: false });
});
