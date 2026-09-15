'use strict';

// Client-side guard for public/manage-provider-relay.js: the share-code parser
// must round-trip the server's relay-share payload (src/routes/providers.js)
// and reject anything malformed — the import dialog pastes untrusted text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'public', 'manage-provider-relay.js');
const BASE_URL_OPTIONS_PATH = path.join(ROOT, 'public', 'base-url-options.js');

function loadModule() {
  const context = vm.createContext({
    atob,
    URL,
    document: { createElement: () => ({ style: {}, querySelector: () => null }), body: { appendChild() {} } },
    location: { origin: 'http://127.0.0.1:3000' },
    navigator: {},
  });
  // The candidate-address list is shared with the session-share dialog, so
  // manage.html loads base-url-options.js first and the relay module reads it.
  // Run both here for the same reason: loading the relay module alone would
  // leave this test passing against a collector the page no longer uses.
  vm.runInContext(fs.readFileSync(BASE_URL_OPTIONS_PATH, 'utf8'), context, { filename: 'base-url-options.js' });
  vm.runInContext(fs.readFileSync(SOURCE_PATH, 'utf8'), context, { filename: 'manage-provider-relay.js' });
  return context;
}

function encode(payload) {
  return 'mcrelay1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

test('parseRelayShareCode round-trips the server relay-share payload', () => {
  const ctx = loadModule();
  const payload = {
    v: 1,
    kind: 'multicc-relay',
    name: 'GLM · 借道',
    appType: 'claude',
    baseUrl: 'https://relay.example/claude-proxy/glm/remote',
    authToken: 'relay-pxy',
  };
  const { payload: parsed, error } = ctx.parseRelayShareCode(encode(payload));
  assert.equal(error, undefined);
  // JSON-normalize: the parsed object lives in the vm realm, so its prototype
  // is not this realm's Object.prototype and deepStrictEqual would trip.
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), payload);
});

test('relayProviderInput carries the shared model catalog into provider creation', () => {
  const ctx = loadModule();
  const input = ctx.relayProviderInput({
    appType: 'codex',
    name: 'OpenAI Official · 借道',
    baseUrl: 'https://relay.example/codex-proxy/official',
    authToken: 'relay-pxy',
    model: 'gpt-5.6-sol',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-sol', ''],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(input)), {
    appType: 'codex',
    name: 'OpenAI Official · 借道',
    baseUrl: 'https://relay.example/codex-proxy/official',
    authToken: 'relay-pxy',
    model: 'gpt-5.6-sol',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
  });
});

test('v2 share codes preserve the independently-scoped relay credential', () => {
  const ctx = loadModule();
  const payload = {
    v: 2,
    kind: 'multicc-relay',
    relayShareId: 'abcdefghijklmnop',
    name: 'GLM · 借道',
    appType: 'claude',
    baseUrl: 'https://relay.example/claude-proxy/glm/remote',
    authToken: 'mcr1.abcdefghijklmnop.manual-secret',
  };
  const parsed = ctx.parseRelayShareCode(encode(payload));
  assert.equal(parsed.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.payload)), payload);
});

test('parseRelayShareCode rejects malformed or untrusted codes', () => {
  const ctx = loadModule();
  const bad = [
    ['', 'empty'],
    ['not-a-code', 'missing prefix'],
    ['mcrelay1.!!!', 'corrupt base64'],
    [encode({ kind: 'other' }), 'wrong kind'],
    [encode({ kind: 'multicc-relay', appType: 'gpt', baseUrl: 'https://x', authToken: 't' }), 'bad appType'],
    [encode({ kind: 'multicc-relay', appType: 'claude', baseUrl: 'javascript:alert(1)', authToken: 't' }), 'non-http baseUrl'],
    [encode({ kind: 'multicc-relay', appType: 'codex', baseUrl: 'https://x', authToken: '' }), 'missing token'],
  ];
  for (const [code, label] of bad) {
    const result = ctx.parseRelayShareCode(code);
    assert.ok(result.error, `must reject: ${label}`);
    assert.equal(result.payload, undefined, `must not leak payload: ${label}`);
  }
});

test('_relayBaseOptions collects, filters and dedupes candidate addresses', async () => {
  const ctx = loadModule();
  ctx.providerApi = {
    json: async (url) => {
      if (url === '/api/server-info') return {
        ip: '192.168.1.10', port: 3000,
        lanUrls: ['http://192.168.1.10:3000', 'http://10.0.0.10:3000'],
      };
      if (url === '/api/settings/tunnel') return {
        config: {
          tailscale: { url: '' },
          phddns: { url: 'https://abc.vicp.fun/manage' },
          natapp: { url: 'ftp://bad-scheme' },
        },
        providers: { tailscale: { publicUrl: 'https://x.tailnet.ts.net/' }, phddns: {} },
      };
      throw new Error(`unexpected url: ${url}`);
    },
  };
  const opts = JSON.parse(JSON.stringify(await ctx._relayBaseOptions()));
  assert.deepEqual(opts.map(o => o.url), [
    'http://127.0.0.1:3000',
    'http://192.168.1.10:3000',
    'http://10.0.0.10:3000',
    'https://x.tailnet.ts.net',
    'https://abc.vicp.fun/manage',
  ]);
  // scope 是「外面的人打不打得开」，分享对话框据此挑默认根域：没有它就只能
  // 按列表位置猜，而第 0 项永远是本机地址。
  assert.deepEqual(opts.map(o => o.scope), ['local', 'lan', 'lan', 'public', 'public']);
  // origin 是剥掉路径的根域。分享链接以根为基准拼 /share/<token>，照搬带路径的
  // url 会拼出一条指错地方的链接，所以两个字段都要有。
  assert.equal(opts[4].url, 'https://abc.vicp.fun/manage');
  assert.equal(opts[4].origin, 'https://abc.vicp.fun');
});

test('base-url-options drops credentialed addresses and labels reachability', async () => {
  const ctx = loadModule();
  const opts = JSON.parse(JSON.stringify(await ctx.multiccBaseUrlOptions({
    json: async (url) => {
      if (url === '/api/server-info') {
        return { lanUrls: ['http://192.168.1.10:3000', 'http://user:pw@192.168.1.10:3000', 'http://127.0.0.1:3000'] };
      }
      if (url === '/api/settings/tunnel') {
        return {
          config: { tailscale: { url: 'https://mac.tail94695a.ts.net/' }, natapp: { url: 'ftp://bad-scheme' } },
          providers: { cpolar: { publicUrl: 'https://abc.cpolar.cn' } },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    },
  })));
  assert.deepEqual(opts.map(o => o.origin), [
    'http://127.0.0.1:3000',
    'http://192.168.1.10:3000',
    'https://mac.tail94695a.ts.net',
    'https://abc.cpolar.cn',
  ]);
  assert.deepEqual(opts.map(o => o.scope), ['local', 'lan', 'public', 'public']);
  // 带凭据的地址一旦拼进分享链接就是把凭据递给了接收方。
  assert.equal(opts.some(o => o.url.includes('user:pw')), false);
});

test('base-url-options still offers the page address when every probe is dead', async () => {
  const ctx = loadModule();
  // 上下文里没有 fetch：探活接口全挂时也必须给出可选项，否则选根域的对话框
  // 会是一个空下拉，用户连生成按钮都点不下去。
  const opts = JSON.parse(JSON.stringify(await ctx.multiccBaseUrlOptions()));
  assert.deepEqual(opts.map(o => o.origin), ['http://127.0.0.1:3000']);
  assert.equal(opts[0].scope, 'local');
});

test('base-url choices dedupe by root and default to the reachable one', async () => {
  const ctx = loadModule();
  // 把同一个根域写成三种样子：带路径、带尾斜杠、裸根。选根域的下拉里出现三条
  // 一模一样的地址只会让人犹豫，所以按 origin 收敛成一条。
  const choices = JSON.parse(JSON.stringify(await ctx.multiccBaseUrlChoices({
    json: async (url) => {
      if (url === '/api/server-info') return { lanUrls: ['http://192.168.1.10:3000'] };
      if (url === '/api/settings/tunnel') return { config: { tailscale: { url: 'https://abc.vicp.fun/manage/' } } };
      throw new Error(`unexpected url: ${url}`);
    },
  })));
  assert.deepEqual(choices.map(o => o.origin), [
    'http://127.0.0.1:3000',
    'http://192.168.1.10:3000',
    'https://abc.vicp.fun',
  ]);
  // 列表第一项永远是「当前页面地址」，多半是 127.0.0.1 —— 默认值必须另算。
  assert.equal(ctx.multiccPreferredBaseUrl(choices).origin, 'https://abc.vicp.fun');
  assert.equal(ctx.multiccPreferredBaseUrl([]), null);
  // 没有公网时，局域网次之，本机垫底。
  const lanOnly = choices.filter(o => o.scope === 'lan');
  assert.equal(ctx.multiccPreferredBaseUrl(lanOnly).origin, 'http://192.168.1.10:3000');
  assert.equal(ctx.multiccPreferredBaseUrl(choices.filter(o => o.scope === 'local')).origin, 'http://127.0.0.1:3000');
});

test('the share dialog and the relay dialog pick roots from one collector', () => {
  const chat = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
  const chatJs = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
  const manage = fs.readFileSync(path.join(ROOT, 'public', 'manage.html'), 'utf8');
  const relay = fs.readFileSync(SOURCE_PATH, 'utf8');

  // 两个对话框问的是同一个问题。分成两份实现就会各自漂移 —— 一边加了新的穿透
  // 方式，另一边不知道。
  const tag = '<script src="base-url-options.js"></script>';
  assert.ok(chat.includes(tag), 'chat.html must load the shared collector for the share dialog');
  assert.ok(manage.indexOf(tag) >= 0 && manage.indexOf(tag) < manage.indexOf('<script src="manage-provider-relay.js"></script>'),
    'manage.html must load the shared collector before the relay module');
  assert.match(relay, /multiccBaseUrlOptions\(\{ json: \(url\) => providerApi\.json\(url\) \}\)/);
  // 两个分享对话框（整个会话 / 选中的消息）都用同一个下拉、都要把选中的根域发上去。
  assert.equal(chatJs.split('multiccMountBaseUrlSelect(baseSel);').length - 1, 2,
    '两个分享对话框都要用同一个下拉填充');
  assert.equal(chatJs.split('if (baseSel.value) body.publicBaseUrl = baseSel.value;').length - 1, 2,
    '两个分享对话框都要把选中的根域发上去');
  // 探活只能有一份。这两个文件里再出现这些路径，就说明有人又抄了一遍。
  assert.doesNotMatch(chatJs, /\/api\/settings\/tunnel/);
  assert.doesNotMatch(relay, /\/api\/settings\/tunnel/);
  assert.doesNotMatch(chatJs, /\/api\/server-info/);
});

test('manage.html loads the relay module before the manage facade', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'manage.html'), 'utf8');
  const relay = html.indexOf('<script src="manage-provider-relay.js"></script>');
  const manage = html.indexOf('<script src="manage.js"></script>');
  assert.ok(relay >= 0 && manage > relay, 'relay module must be loaded before manage.js');
  assert.match(html, /id="prov-relay-records-btn"[^>]+manageRelayShares/);
});

test('new relay creation requires a per-link token and exposes inventory/revocation controls', () => {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  assert.match(source, /data-k="token" type="password"/);
  assert.match(source, /json: \{ publicBaseUrl:[^}]+token: tokenInput\.value/);
  assert.match(source, /\/api\/provider-relay-shares\?/);
  assert.match(source, /method: 'DELETE'/);
  assert.doesNotMatch(source, /\/api\/settings\/proxy-token/);
  assert.doesNotMatch(source, /RELAY_TOKEN_UNSET/);
});
