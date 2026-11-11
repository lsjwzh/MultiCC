'use strict';

// Regenerates native/core/tests/fixtures/outbound-proxy-cases.json.
//
//   node scripts/generate-outbound-proxy-corpus.js          # verify
//   node scripts/generate-outbound-proxy-corpus.js --write  # rewrite
//
// Every expectation comes from the real src/network/proxy-policy.js, still the
// Node policy for every other outbound request. The Rust port
// (native/core/src/outbound_proxy.rs) replays the same file, so a semantic
// drift on either side fails a unit test instead of a live request.
//
// Four layers, because proxyForUrl composes four decisions:
//   parse   scutil texts -> parseMacSystemProxy
//   cidr    entry -> cidrToRange
//   bypass  URL + entries -> bypassProxy
//   resolve env + system -> resolveProxyConfig (throw or configuration)
//   proxy   env + system + URL -> proxyForUrl (throw or proxy string)
//   cache   a policy clock and scripted scutil reads -> calls + results

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'native', 'core', 'tests', 'fixtures', 'outbound-proxy-cases.json');
const policy = require(path.join(root, 'src', 'network', 'proxy-policy.js'));

const SYSTEM_TEXTS = [
  ['empty', ''],
  ['http-and-https', [
    '<dictionary> {',
    '  ExceptionsList : <array> {',
    '    0 : *.local',
    '    1 : 10.0.0.0/8',
    '    2 : example.com',
    '  }',
    '  HTTPEnable : 1',
    '  HTTPPort : 7890',
    '  HTTPProxy : 127.0.0.1',
    '  HTTPSEnable : 1',
    '  HTTPSPort : 7891',
    '  HTTPSProxy : proxy.example.net',
    '  SOCKSEnable : 0',
    '  SOCKSProxy : 127.0.0.1',
    '  SOCKSPort : 7892',
    '}',
    '',
  ].join('\n')],
  ['socks-only', [
    'HTTPEnable : 0',
    'HTTPSEnable : 0',
    'SOCKSEnable : 1',
    'SOCKSProxy : 127.0.0.1',
    'SOCKSPort : 7897',
  ].join('\n')],
  ['pac-only', 'ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://wpad/wpad.dat'],
  ['pac-discovery', 'ProxyAutoDiscoveryEnable : 1'],
  ['https-inherits-nothing', [
    'HTTPEnable : 1',
    'HTTPProxy : 10.0.0.2',
    'HTTPPort : 3128',
    'HTTPSEnable : 1',
    'HTTPSProxy : 10.0.0.3',
    'HTTPSPort : 3129',
  ].join('\n')],
  ['exclude-simple', [
    'HTTPEnable : 1',
    'HTTPProxy : proxy.local',
    'HTTPPort : 8080',
    'HTTPSEnable : 1',
    'HTTPSProxy : proxy.local',
    'HTTPSPort : 8443',
    'ExcludeSimpleHostnames : 1',
  ].join('\n')],
  ['ipv6-host', [
    'HTTPEnable : 1',
    'HTTPProxy : fe80::1',
    'HTTPPort : 8080',
    'HTTPSEnable : 1',
    'HTTPSProxy : fe80::1',
    'HTTPSPort : 8443',
  ].join('\n')],
  ['invalid-ports', [
    'HTTPEnable : 1',
    'HTTPProxy : 127.0.0.1',
    'HTTPPort : 0',
    'HTTPSEnable : 1',
    'HTTPSProxy : 127.0.0.1',
    'HTTPSPort : 70000',
    'SOCKSEnable : 1',
    'SOCKSProxy : 127.0.0.1',
    'SOCKSPort : 65535',
  ].join('\n')],
  ['numeric-port-forms', [
    'HTTPEnable : 1',
    'HTTPProxy : 127.0.0.1',
    'HTTPPort : 0x1F90',
    'HTTPSEnable : 1',
    'HTTPSProxy : 127.0.0.1',
    'HTTPSPort : 8.0e3',
  ].join('\n')],
  ['missing-host', [
    'HTTPEnable : 1',
    'HTTPPort : 8080',
    'HTTPSEnable : 1',
    'HTTPSProxy : ',
    'HTTPSPort : 8080',
  ].join('\n')],
  ['array-without-close', 'ExceptionsList : <array> {\n  0 : one\n  1 : two\n'],
  ['crlf', 'HTTPEnable : 1\r\nHTTPProxy : 127.0.0.1\r\nHTTPPort : 7890\r\n'],
  ['indented', '  HTTPEnable : 1\n  HTTPProxy :   127.0.0.1  \n  HTTPPort : 7890\n'],
];

const URLS = [
  'https://api.anthropic.com/api/oauth/profile',
  'https://chatgpt.com/backend-api/wham/usage',
  'http://example.com/',
  'wss://socket.example.com/ws',
  'ws://socket.example.com/ws',
  'https://sub.example.com:8443/path',
  'https://localhost/x',
  'http://127.0.0.1:3000/x',
  'http://[::1]:3000/x',
  'https://10.1.2.3/x',
  'https://intranet/x',
  'https://example.com:443/x',
  'http://example.com:80/x',
];

const ENTRIES = [
  [],
  ['*'],
  ['<local>'],
  ['localhost'],
  ['127.0.0.1'],
  ['::1'],
  ['[::1]'],
  ['example.com'],
  ['.example.com'],
  ['*.example.com'],
  ['example.com:443'],
  ['example.com:80'],
  ['[::1]:3000'],
  ['10.0.0.0/8'],
  ['10.1.2.3/32'],
  ['192.168.0.0/16'],
  ['0.0.0.0/0'],
  ['10.0.0.0/33'],
  ['10.0.0.0/'],
  ['10.0.0.0'],
  ['255.255.255.255/32'],
  ['10.1.2.3-10.1.2.9'],
  ['.localhost'],
  ['*.local'],
  ['EXAMPLE.COM'],
  ['  example.com  '],
  ['example.com', 'other.net'],
];

const CIDRS = [
  '10.0.0.0/8',
  '10.1.2.3/32',
  '192.168.0.0/16',
  '0.0.0.0/0',
  '10.0.0.0/33',
  '10.0.0.0/-1',
  '10.0.0.0/',
  '10.0.0.0/8/8',
  '10.0.0/8',
  '10.0.0.0',
  '255.255.255.255/32',
  '256.0.0.0/8',
  '010.000.000.000/8',
  '1.2.3.4.5/8',
  'localhost/8',
];

const ENVS = [
  ['none', {}],
  ['http-only', { http_proxy: 'http://127.0.0.1:7890' }],
  ['https-only', { https_proxy: 'http://127.0.0.1:7891' }],
  ['all-only', { all_proxy: 'http://127.0.0.1:7892' }],
  ['http-and-https', { http_proxy: 'http://127.0.0.1:7890', https_proxy: 'http://127.0.0.1:7891' }],
  ['upper-case', { HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7891' }],
  ['lower-wins', { http_proxy: 'http://lower:1', HTTP_PROXY: 'http://upper:2' }],
  ['empty-lower', { http_proxy: '', HTTP_PROXY: 'http://upper:2' }],
  ['empty-https-all', { https_proxy: '', all_proxy: 'http://all:3' }],
  ['socks', { http_proxy: 'socks5://127.0.0.1:1080' }],
  ['malformed', { http_proxy: 'not a url' }],
  ['no-scheme', { http_proxy: '127.0.0.1:7890' }],
  ['https-proxy-scheme', { https_proxy: 'https://secure.example:443' }],
  ['no-proxy', { https_proxy: 'http://127.0.0.1:7891', no_proxy: 'example.com, .local' }],
  ['upper-no-proxy', { https_proxy: 'http://127.0.0.1:7891', NO_PROXY: 'a.example,b.example' }],
  ['blank-no-proxy', { https_proxy: 'http://127.0.0.1:7891', no_proxy: '  , ,\t' }],
  ['cidr-no-proxy', { https_proxy: 'http://127.0.0.1:7891', no_proxy: '10.0.0.0/8 127.0.0.1' }],
];

const errors = [];
function attempt(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    errors.push(String(error && error.message));
    return { error: true };
  }
}
async function attemptAsync(fn) {
  try {
    return { value: await fn() };
  } catch (error) {
    errors.push(String(error && error.message));
    return { error: true };
  }
}

function systemFor(text) {
  return policy.parseMacSystemProxy(text);
}

function build() {
  const out = { source: 'src/network/proxy-policy.js' };

  out.parse = SYSTEM_TEXTS.map(([name, text]) => ({
    name,
    text,
    expected: systemFor(text),
  }));

  out.cidr = CIDRS.map(entry => ({
    name: entry,
    entry,
    expected: policy.cidrToRange(entry),
  }));

  out.bypass = [];
  for (const url of URLS) {
    for (const entries of ENTRIES) {
      out.bypass.push({
        name: `${url} | ${entries.length ? entries.join(',') : '(none)'}`,
        url,
        entries,
        expected: policy.bypassProxy(new URL(url), entries),
      });
    }
  }

  out.resolve = [];
  for (const [envName, env] of ENVS) {
    for (const [systemName, text] of SYSTEM_TEXTS) {
      if (envName === 'none' && systemName === 'empty') continue;
      const system = systemFor(text);
      const result = attempt(() => policy.resolveProxyConfig(env, system));
      out.resolve.push({
        name: `${envName} + ${systemName}`,
        env,
        system,
        ...(result.error
          ? { error: true }
          : {
              expected: {
                httpProxy: result.value.httpProxy,
                httpsProxy: result.value.httpsProxy,
                noProxy: result.value.noProxy,
                mode: result.value.mode,
              },
            }),
      });
    }
  }

  out.proxy = [];
  for (const [envName, env] of ENVS) {
    for (const [systemName, text] of SYSTEM_TEXTS) {
      for (const url of URLS) {
        const system = systemFor(text);
        const result = attempt(() => {
          // The synchronous composition of proxyForUrl: loopback is answered
          // before discovery, exactly like the JavaScript.
          const parsed = new URL(url);
          if (policy.isLoopback(parsed.hostname)) return '';
          const config = policy.resolveProxyConfig(env, system);
          return policy.bypassProxy(parsed, config.noProxy) ? ''
            : ['https:', 'wss:'].includes(parsed.protocol) ? config.httpsProxy : config.httpProxy;
        });
        out.proxy.push({
          name: `${envName} + ${systemName} + ${url}`,
          env,
          system,
          url,
          ...(result.error ? { error: true } : { expected: result.value }),
        });
      }
    }
  }

  // Cache/TTL behavior: the policy reads scutil only when no proxy env is set,
  // the stamp is past refreshMs, and preserves the last value on read errors.
  const cacheCases = [
    { name: 'reuse-within-ttl', env: {}, refreshMs: 30000, systems: [systemFor(SYSTEM_TEXTS[1][1])],
      steps: [{ now: 0, url: URLS[0] }, { now: 29999, url: URLS[1] }] },
    { name: 'refresh-after-ttl', env: {}, refreshMs: 30000,
      systems: [systemFor(SYSTEM_TEXTS[1][1]), systemFor(SYSTEM_TEXTS[4][1])],
      steps: [{ now: 0, url: URLS[0] }, { now: 30000, url: URLS[0] }] },
    { name: 'env-skips-discovery', env: { https_proxy: 'http://127.0.0.1:1' }, refreshMs: 30000,
      systems: [systemFor(SYSTEM_TEXTS[1][1])],
      steps: [{ now: 0, url: URLS[0] }, { now: 100000, url: URLS[0] }] },
    { name: 'error-then-retry', env: {}, refreshMs: 30000, systems: [{ error: true }, systemFor(SYSTEM_TEXTS[1][1])],
      steps: [{ now: 0, url: URLS[0] }, { now: 1, url: URLS[0] }] },
    { name: 'error-preserves-last', env: {}, refreshMs: 30000,
      systems: [systemFor(SYSTEM_TEXTS[1][1]), { error: true }],
      steps: [{ now: 0, url: URLS[0] }, { now: 40000, url: URLS[0] }] },
    { name: 'error-preserves-and-waits-ttl', env: {}, refreshMs: 30000,
      systems: [systemFor(SYSTEM_TEXTS[1][1]), { error: true }, systemFor(SYSTEM_TEXTS[4][1])],
      steps: [{ now: 0, url: URLS[0] }, { now: 40000, url: URLS[0] }, { now: 40001, url: URLS[0] }, { now: 80000, url: URLS[0] }] },
    { name: 'loopback-before-discovery', env: {}, refreshMs: 30000, systems: [{ error: true }],
      steps: [{ now: 0, url: URLS[7] }, { now: 1, url: URLS[0] }] },
  ];
  out.cache = cacheCases.map(spec => {
    let reads = 0;
    let clock = 0;
    const policyInstance = policy.createProxyPolicy({
      env: spec.env,
      platform: 'darwin',
      refreshMs: spec.refreshMs,
      now: () => clock,
      readSystemProxy: async () => {
        const scripted = spec.systems[reads++];
        if (scripted && scripted.error) throw new Error('scutil failed');
        return scripted || systemFor('');
      },
    });
    const proxies = [];
    const failed = [];
    // The generator is synchronous; resolve the steps in order through the
    // tiny promise chain and verify the file in --write mode only (the
    // expected values are computed at generation time).
    let chain = Promise.resolve();
    for (const step of spec.steps) {
      chain = chain.then(async () => {
        clock = step.now;
        const result = await attemptAsync(() => policyInstance.proxyForUrl(step.url));
        failed.push(!!result.error);
        proxies.push(result.error ? null : result.value);
      });
    }
    return { spec, chain, result: () => ({ reads, proxies, failed }) };
  });
  // Finish the async chains before assembling the JSON.
  return Promise.all(out.cache.map(entry => entry.chain)).then(() => {
    out.cache = out.cache.map(({ spec, result }) => ({
      name: spec.name,
      env: spec.env,
      refreshMs: spec.refreshMs,
      systems: spec.systems,
      steps: spec.steps,
      expected: result(),
    }));
    out.errorMessages = [...new Set(errors)].sort();
    return out;
  });
}

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

build().then((corpus) => {
  assert.strictEqual(corpus.parse.length, SYSTEM_TEXTS.length);
  assert.ok(corpus.bypass.length >= 300, 'bypass corpus too small');
  assert.ok(corpus.proxy.length >= 1000, 'proxy corpus too small');
  const text = stable(corpus);
  const write = process.argv.includes('--write');
  if (write) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    console.log(`wrote ${path.relative(root, target)} (${text.length} bytes)`);
    return;
  }
  const current = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  if (current !== text) {
    console.error(`${path.relative(root, target)} is stale; run with --write`);
    process.exit(1);
  }
  console.log(`verified ${path.relative(root, target)} (${text.length} bytes)`);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
