'use strict';

// src/cli/cli-upstream-version.js — 「上游发布了什么版本」。
//
// 这一组的判据只有一条: **不知道就说不知道**。网络失败、404、限流页、二进制
// 乱码都必须回 null, 绝不能猜一个版本号出来 —— 因为下游拿它和本地版本做比较,
// 猜错会直接变成一个假的「有新版本」角标。

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  // 显式给一个不存在的 npmrc 路径: 真实结果不能被开发机自己的 ~/.npmrc 影响。
  const noNpmrc = { npmrcPath: path.join(__dirname, 'fixtures', 'no-such-npmrc') };
  assert.equal(upstream.resolveRegistryBase({}, noNpmrc), upstream.DEFAULT_REGISTRY);
  assert.equal(upstream.resolveRegistryBase({ npm_config_registry: 'https://registry.npmmirror.com' }),
    'https://registry.npmmirror.com/');
  assert.equal(upstream.resolveRegistryBase({ NPM_CONFIG_REGISTRY: 'https://r.example.com/' }),
    'https://r.example.com/');
  // 不是 URL 就退回官方源, 而不是拼出一个坏 URL
  assert.equal(upstream.resolveRegistryBase({ npm_config_registry: 'not-a-url' }, noNpmrc),
    upstream.DEFAULT_REGISTRY);
});

// 服务进程的 env 里通常没有 npm_config_registry(那个变量只在 npm 拉起的子进程里),
// 用 .npmrc 配镜像的用户只能靠读文件才认得出来。
test('a mirror configured in the user .npmrc is honoured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-npmrc-'));
  try {
    const npmrc = path.join(dir, '.npmrc');
    fs.writeFileSync(npmrc, '; comment\nfund=false\nregistry=https://registry.npmmirror.com\n');
    assert.equal(upstream.readNpmrcRegistry({}, { npmrcPath: npmrc }), 'https://registry.npmmirror.com/');
    assert.equal(upstream.resolveRegistryBase({}, { npmrcPath: npmrc }), 'https://registry.npmmirror.com/');
    // env 里的显式配置优先于文件
    assert.equal(upstream.resolveRegistryBase({ npm_config_registry: 'https://r.example.com' }, { npmrcPath: npmrc }),
      'https://r.example.com/');
    // 没有 registry 行的 npmrc 不算配置
    fs.writeFileSync(npmrc, 'fund=false\n');
    assert.equal(upstream.resolveRegistryBase({}, { npmrcPath: npmrc }), upstream.DEFAULT_REGISTRY);
    // 文件读不到 -> 官方源, 不抛
    assert.equal(upstream.resolveRegistryBase({}, { npmrcPath: path.join(dir, 'missing') }), upstream.DEFAULT_REGISTRY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 官方源在部分网络环境整段不可达(实测 5s 无响应), 没有兜底源时最新版恒为 null,
// 整个「有没有新版」的功能都是死的。
test('an unreachable primary registry falls back to a mirror, and says which one answered', async () => {
  assert.deepEqual(upstream.resolveRegistryCandidates({}, { npmrcPath: '/nonexistent/npmrc' }),
    [upstream.DEFAULT_REGISTRY, 'https://registry.npmmirror.com/']);
  // 主源已经是镜像时不重复
  assert.deepEqual(upstream.resolveRegistryCandidates(
    { npm_config_registry: 'https://registry.npmmirror.com/' }, { npmrcPath: '/nonexistent/npmrc' }),
  ['https://registry.npmmirror.com/']);
  // 可以关掉, 也可以换成自建镜像
  assert.deepEqual(upstream.resolveRegistryCandidates(
    { MULTICC_CLI_REGISTRY_FALLBACKS: '' }, { npmrcPath: '/nonexistent/npmrc' }),
  [upstream.DEFAULT_REGISTRY]);
  assert.deepEqual(upstream.resolveRegistryCandidates(
    { MULTICC_CLI_REGISTRY_FALLBACKS: 'https://mirror.example.com' }, { npmrcPath: '/nonexistent/npmrc' }),
  [upstream.DEFAULT_REGISTRY, 'https://mirror.example.com/']);

  // 主源超时(官方源在本机就是这样) -> 用镜像的答案, 并如实回报是哪个源答的
  const https = fakeHttps((req, url) => {
    if (url.startsWith('https://registry.npmjs.org/')) {
      process.nextTick(() => req.emit('error', new Error('ETIMEDOUT')));
      return null;
    }
    return fakeResponse(200, JSON.stringify({ version: '2.1.280' }));
  });
  const result = await upstream.fetchLatestVersionWithSource('@anthropic-ai/claude-code', {
    httpsImpl: https, env: { MULTICC_CLI_REGISTRY_FALLBACKS: 'https://registry.npmmirror.com' },
    npmrcPath: '/nonexistent/npmrc',
  });
  assert.equal(result.version, '2.1.280');
  assert.equal(result.registry, 'https://registry.npmmirror.com/');
  assert.equal(https.requests.length, 2, '先问主源, 再问兜底源');
  // 显式给了 registryBase 就只问那一个源(调用方已经指定了源)
  const solo = fakeHttps(fakeResponse(200, JSON.stringify({ version: '1.0.0' })));
  const pinned = await upstream.fetchLatestVersionWithSource('opencode-ai', {
    httpsImpl: solo, registryBase: 'https://registry.npmjs.org/',
  });
  assert.equal(pinned.registry, 'https://registry.npmjs.org/');
  assert.equal(solo.requests.length, 1);
  // 所有源都答不上来 -> version 与 registry 都是 null(不能把「没人答」伪装成「这个源说没有新版」)
  const dead = await upstream.fetchLatestVersionWithSource('opencode-ai', {
    httpsImpl: fakeHttps(req => { process.nextTick(() => req.emit('error', new Error('ENOTFOUND'))); }),
    npmrcPath: '/nonexistent/npmrc',
  });
  assert.deepEqual(dead, { version: null, registry: null });
  // fetchLatestVersion 保持只回版本号的老契约
  assert.equal(await upstream.fetchLatestVersion('opencode-ai', {
    httpsImpl: fakeHttps(fakeResponse(200, JSON.stringify({ version: '3.1.4' }))),
    registryBase: 'https://registry.npmjs.org/',
  }), '3.1.4');
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
  assert.equal(upstream.npmPackageFor('codex'), '@openai/codex');
  assert.equal(upstream.npmPackageFor('codebuddy'), '@tencent-ai/codebuddy-code');
  assert.equal(upstream.npmPackageFor('gemini'), '@google/gemini-cli');
  assert.equal(upstream.npmPackageFor('grok'), '@xai-official/grok');
  // 键是**家族**(= 升级目标): 升级的单位是 CLI 制品, 而车道只是它的使用场景。
  // 所以车道 id 一个包名都不该有 —— 尤其是 claude-exp: Agent SDK 是 multicc 自己的
  // 依赖, 既不是「用户装的那个东西」, 升它也不是这条链路能做的事。
  for (const lane of ['claude-exp', 'codex-exp']) {
    assert.equal(upstream.npmPackageFor(lane), null, `${lane} 不该有自己的 npm 源`);
  }
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

test('native pure rules match the frozen upstream oracle across coercion and unicode edges', () => {
  const oracle = require('./helpers/legacy-cli-upstream-version');
  const versions = [undefined, null, false, 0, '', '1.2.3', 'v1.2.3', '\ufeffv1.2.3\ufeff',
    '1.2.3+build', '1.2.3-beta.2', '  v1.2.3  ', '١.2.3', '1.2.3\n',
    '9'.repeat(400) + '.2.3', [], ['1.2.3'], { version: '1.2.3' }];
  for (const value of versions) assert.deepEqual(upstream.parseSemver(value), oracle.parseSemver(value));
  for (const left of versions) for (const right of versions) {
    assert.deepEqual(upstream.compareSemver(left, right), oracle.compareSemver(left, right));
    assert.deepEqual(upstream.classifyUpdate(left, right), oracle.classifyUpdate(left, right));
  }
  for (const value of [null, undefined, '', 'HTTPS://mirror.example', '\ufeffhttp://x\ufeff',
    'https://x/\ud800', 'http://', 'file://x', ['https://mirror.example']]) {
    assert.deepEqual(upstream.normalizeRegistry(value), oracle.normalizeRegistry(value));
  }
  for (const pkg of ['@a/b/c', undefined, '\ud800/pkg', ['@x/y']]) {
    assert.equal(upstream.latestUrl(pkg, 'https://x/'), oracle.latestUrl(pkg, 'https://x/'));
  }
});

test('injected transport retains UTF-16 budget and relative redirect state', async () => {
  const requests = [];
  const transport = fakeHttps((req, url) => {
    requests.push(url);
    if (requests.length === 1) return fakeResponse(302, null, { location: '/different/latest' });
    return fakeResponse(200, JSON.stringify({ version: 'v1.2.3', padding: '中'.repeat(100_000) }));
  });
  assert.deepEqual(await upstream.fetchLatestVersionWithSource('x', {
    registryBase: 'https://mirror.example/', httpsImpl: transport,
  }), { version: '1.2.3', registry: 'https://mirror.example/' });
  assert.equal(requests[1], 'https://mirror.example/different/latest');
  assert.equal(transport.requests[0].options.timeout, upstream.FETCH_TIMEOUT_MS);
  assert.equal(transport.requests[0].options.headers['User-Agent'], 'multicc-cli-version-check/1.0');
});

test('an invalid redirect is an unknown version and late errors do not consume the next source', async () => {
  const invalid = fakeHttps(() => fakeResponse(302, null, { location: 'https://[' }));
  assert.deepEqual(await upstream.fetchLatestVersionWithSource('x', {
    registryBase: 'https://mirror.example/', httpsImpl: invalid,
  }), { version: null, registry: null });
  const transport = fakeHttps((req, url) => {
    if (url.startsWith('https://primary.example/')) {
      process.nextTick(() => { req.emit('timeout'); req.emit('error', new Error('late')); });
      return null;
    }
    return fakeResponse(200, '{"version":"2.0.0"}');
  });
  assert.deepEqual(await upstream.fetchLatestVersionWithSource('x', {
    env: { npm_config_registry: 'https://primary.example/', MULTICC_CLI_REGISTRY_FALLBACKS: 'https://mirror.example/' },
    httpsImpl: transport,
  }), { version: '2.0.0', registry: 'https://mirror.example/' });
  assert.equal(transport.requests.length, 2);
});

test('explicit registry and missing package do not consult host home-directory facts', async () => {
  const original = os.homedir;
  os.homedir = () => { throw new Error('must remain lazy'); };
  try {
    assert.equal(upstream.resolveRegistryBase({ npm_config_registry: 'https://mirror.example/' }), 'https://mirror.example/');
    assert.deepEqual(await upstream.fetchLatestVersionWithSource('', { httpsImpl: fakeHttps(() => { throw new Error('no request'); }) }), { version: null, registry: null });
    assert.equal(await upstream.fetchLatestVersion('x', {
      registryBase: 'https://mirror.example/', httpsImpl: fakeHttps(fakeResponse(200, '{"version":"1.0.0"}')),
    }), '1.0.0');
  } finally { os.homedir = original; }
});

test('production Rust transport uses Node trust roots, ignores proxy env and rejects compressed or non-HTTPS replies', { timeout: 20_000 }, async () => {
  const { execFile, spawnSync } = require('node:child_process');
  const { promisify } = require('node:util');
  const https = require('node:https');
  const zlib = require('node:zlib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-upstream-tls-'));
  let server;
  try {
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    const caKey = path.join(dir, 'ca-key.pem');
    const ca = path.join(dir, 'ca.pem');
    const csr = path.join(dir, 'server.csr');
    const extensions = path.join(dir, 'server.ext');
    const generate = args => {
      const generated = spawnSync('openssl', args, { encoding: 'utf8', timeout: 5_000 });
      assert.equal(generated.status, 0, 'local TLS fixture must be generated');
    };
    // A CA is a trust anchor, not a server leaf: WebPKI correctly rejects the
    // CA:TRUE certificate produced by a bare `openssl req -x509` as a server.
    generate(['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', caKey, '-out', ca, '-days', '1', '-subj', '/CN=Local test root',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    generate(['req', '-new', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', csr, '-subj', '/CN=localhost']);
    fs.writeFileSync(extensions, 'basicConstraints=critical,CA:FALSE\n'
      + 'keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n'
      + 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
    generate(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial',
      '-out', cert, '-days', '1', '-extfile', extensions]);
    assert.equal(new (require('node:crypto').X509Certificate)(fs.readFileSync(cert)).ca, false);
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      if (req.url.startsWith('/redirect/')) { res.writeHead(302, { location: '/good/latest' }); res.end(); return; }
      if (req.url.startsWith('/http/')) { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); return; }
      if (req.url.startsWith('/gzip/')) {
        res.writeHead(200, { 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync('{"version":"9.9.9"}')); return;
      }
      if (req.url.startsWith('/loop/')) { res.writeHead(302, { location: req.url }); res.end(); return; }
      const bytes = Buffer.from('{"version":"3.2.1","note":"中文😀"}');
      res.writeHead(200, { 'content-type': 'application/json' });
      const split = bytes.indexOf(Buffer.from('中')) + 1;
      res.write(bytes.subarray(0, split));
      setImmediate(() => res.end(bytes.subarray(split)));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `https://127.0.0.1:${server.address().port}`;
    const script = `const u=require(process.argv[1]);(async()=>{const out=[];for(const route of ['redirect','gzip','http','loop'])out.push(await u.fetchLatestVersionWithSource('x',{registryBase:process.argv[2]+'/'+route+'/',timeoutMs:1500}));process.stdout.write(JSON.stringify(out));})().catch(()=>process.exit(1));`;
    const transportEnv = { ...process.env, NODE_EXTRA_CA_CERTS: ca,
      HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
      http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1', all_proxy: 'http://127.0.0.1:1', NO_PROXY: '', no_proxy: '' };
    const childArgs = ['-e', script, require.resolve('../src/cli/cli-upstream-version'), base];
    const { stdout } = await promisify(execFile)(process.execPath, childArgs, {
      env: transportEnv,
      timeout: 15_000,
    });
    assert.deepEqual(JSON.parse(stdout), [
      { version: '3.2.1', registry: `${base}/redirect/` },
      { version: null, registry: null }, { version: null, registry: null }, { version: null, registry: null },
    ]);
    const { stdout: untrusted } = await promisify(execFile)(process.execPath, childArgs, {
      env: { ...transportEnv, NODE_EXTRA_CA_CERTS: '' }, timeout: 15_000,
    });
    assert.deepEqual(JSON.parse(untrusted), Array.from({ length: 4 }, () => ({ version: null, registry: null })),
      'a server signed by an untrusted CA must still be rejected');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
