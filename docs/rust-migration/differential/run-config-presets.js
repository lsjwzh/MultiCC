'use strict';
// Differential run that retired src/routes/run-config-presets.js (removed in
// 6896eecc). Needs an addon built before that commit: the route's napi
// exports went with it.
//
//   node docs/rust-migration/differential/run-config-presets.js \
//     <repo> <multicc-gateway> <old multicc_core.node>
const zlib = require('zlib');
const { main, loadDeleted } = require('./lib');

const REMOVED_IN = '6896eecc';

const preset = (id, savedAt, extra = {}) => ({
  id, name: id, protocol: 'anthropic', savedAt,
  candidates: [{ providerId: 'a', model: 'm' }, { providerId: 'b', model: 'm' }], ...extra,
});
const J = (v) => JSON.stringify(v);

function corpus(cookie, TOKEN) {
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const RH = { Host: 'box.example.com', 'X-Request-Id': 'diff-req-1' };
  const json = { 'Content-Type': 'application/json' };
  const many = Array.from({ length: 20 }, (_, i) => preset(`preset-${i}`, 100 + i));
  return [
    ['GET local empty', { method: 'GET', url: '/api/run-config/presets', headers: L }],
    ['GET remote no auth', { method: 'GET', url: '/api/run-config/presets', headers: RH }],
    ['GET remote html', { method: 'GET', url: '/api/run-config/presets?a=1&b=/c', headers: { ...RH, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } }],
    ['GET remote text/plain accept html', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, Accept: 'text/plain, text/html' } }],
    ['GET remote json accept with text/html', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, Accept: 'application/json, text/html;q=0' } }],
    ['GET remote token ok', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, 'X-Access-Token': TOKEN } }],
    ['GET remote token bad', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, 'X-Access-Token': 'nope' } }],
    ['GET remote cookie ok', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, Cookie: `a=1; multicc_auth=${cookie}` } }],
    ['GET remote cookie bad', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, Cookie: 'multicc_auth=x.y' } }],
    ['GET local forwarded', { method: 'GET', url: '/api/run-config/presets', headers: { ...L, 'X-Forwarded-For': '1.2.3.4' } }],
    ['GET local ts.net host', { method: 'GET', url: '/api/run-config/presets', headers: { Host: 'mac.tail1.ts.net', 'X-Request-Id': 'diff-req-1' } }],
    ['GET machine grant bogus + token', { method: 'GET', url: '/api/run-config/presets', headers: { ...RH, 'X-Access-Token': TOKEN, 'X-Multicc-Machine-Grant': 'mcg_' + 'a'.repeat(48) } }],
    ['GET no request id', { method: 'GET', url: '/api/run-config/presets', headers: { Host: 'localhost', 'X-Request-Id': 'bad id!', 'X-Correlation-Id': 'corr-1' } }],
    ['PUT text/plain', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'text/plain' }, body: '{}' }],
    ['PUT malformed', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '{"presets":' }],
    ['PUT json string', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '"text"' }],
    ['PUT empty body', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '' }],
    ['PUT {}', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '{}' }],
    ['PUT []', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '[]' }],
    ['PUT presets not array', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: '{"presets":{}}' }],
    ['PUT 101', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: J({ presets: Array.from({ length: 101 }, (_, i) => preset(`p${i}`, i)) }) }],
    ['PUT mixed validity', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: J({ presets: [preset('ok', 5), { id: 'few', name: 'Few', protocol: 'anthropic', candidates: [{ providerId: 'p' }] }, preset('weird', 1e400 === Infinity ? 3 : 3, { extra: '\ud834' })] }).replace('"extra":"\\ud834"', '"extra":"\\ud834","n":1e400') }],
    ['GET after PUT', { method: 'GET', url: '/api/run-config/presets', headers: L }],
    ['GET trailing slash mixed case', { method: 'GET', url: '/api/Run-Config/Presets/', headers: L }],
    ['HEAD', { method: 'HEAD', url: '/api/run-config/presets', headers: L }],
    ['POST merge', { method: 'POST', url: '/api/run-config/presets/merge', headers: { ...L, ...json }, body: J({ presets: [preset('two', 9), preset('ok', 1)] }) }],
    ['POST merge gzip body', { method: 'POST', url: '/api/run-config/presets/merge', headers: { ...L, ...json, 'Content-Encoding': 'gzip' }, body: zlib.gzipSync(J({ presets: [preset('three', 10)] })) }],
    ['PUT 20 for gzip', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json }, body: J({ presets: many }) }],
    ['GET gzip', { method: 'GET', url: '/api/run-config/presets', headers: { ...L, 'Accept-Encoding': 'gzip, deflate' } }],
    ['GET x-gzip word', { method: 'GET', url: '/api/run-config/presets', headers: { ...L, 'Accept-Encoding': 'x-gzip' } }],
    ['OPTIONS presets', { method: 'OPTIONS', url: '/api/run-config/presets', headers: L }],
    ['OPTIONS merge', { method: 'OPTIONS', url: '/api/run-config/presets/merge', headers: L }],
    ['PUT utf-16 charset', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'application/json; charset=utf-16' }, body: '{}' }],
    ['PUT utf-16le valid', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'application/json; charset=UTF-16LE' }, body: Buffer.from(J({ presets: [preset('u16le', 30)] }), 'utf16le') }],
    ['PUT utf-16 BOM BE valid', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'application/json; charset="utf-16"' }, body: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(J({ presets: [preset('u16be', 31)] }), 'utf16le').swap16()]) }],
    ['PUT utf-16 no BOM heuristic LE', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'application/json; charset=utf-16' }, body: Buffer.from(J({ presets: [preset('u16auto', 32)] }), 'utf16le') }],
    ['GET after utf-16', { method: 'GET', url: '/api/run-config/presets', headers: L }],
    ['PUT latin1 charset', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, 'Content-Type': 'application/json; charset=latin1' }, body: '{}' }],
    ['PUT br encoding', { method: 'PUT', url: '/api/run-config/presets', headers: { ...L, ...json, 'Content-Encoding': 'br' }, body: '{}' }],
  ];
}

main({
  name: 'run-config-presets',
  stores: ['run-config-presets.json'],
  mount(app, { repo, dataRoot }) {
    const route = loadDeleted(repo, `${REMOVED_IN}^`, 'src/routes/run-config-presets.js');
    route.mountRunConfigPresetsRoutes(app, { file: require('path').join(dataRoot, 'run-config-presets.json') });
  },
  corpus: ({ cookie, token }) => corpus(cookie, token),
});
