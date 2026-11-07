'use strict';
// Differential run that retired the download link from Node:
// POST /api/auth/download-ticket and the gate's ticket branch
// (src/routes/auth.js, src/auth-security.js), GET|HEAD /api/download and the
// upload temp-file stats/cleanup (src/routes/file-transfer.js).
//
//   node docs/rust-migration/differential/download-link.js \
//     <repo> <multicc-gateway> <multicc_core.node>
//
// DIFF_BASELINE_REV names a commit that still has the Node code (default:
// the last commit before the removal).
const fs = require('fs');
const path = require('path');
const { main, loadDeleted } = require('./lib');

const BASELINE = process.env.DIFF_BASELINE_REV || '6896eecc';
const FIXED_TIME = new Date('2026-03-04T05:06:07.891Z');

function writeFiles(dir) {
  fs.mkdirSync(path.join(dir, '.dir'), { recursive: true });
  const files = {
    'file.txt': 'data',
    '中文 名.png': 'png',
    'café.txt': 'latin1 name',
    'a"b.json': '{"quoted":true}',
    'empty.json': '',
    '.hidden': 'secret',
    '.dir/inside.txt': 'inside',
    '社媒触达 照片墙.png': 'cjk',
    'a%20b.png': 'literal',
    'a b.png': 'decoded',
    'big.bin': 'abcdefghijklmnopqrstuvwxyz0123456789\n'.repeat(30000),
  };
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.writeFileSync(full, content);
    fs.utimesSync(full, FIXED_TIME, FIXED_TIME);
  }
}

function writeUploads(dir) {
  fs.mkdirSync(path.join(dir, 'multicc_dir'), { recursive: true });
  for (const [name, content] of [['multicc_two', '12345'], ['multicc_one', '123'], ['foreign', 'x'], ['multicc_ä', 'u']]) {
    fs.writeFileSync(path.join(dir, name), content);
    fs.utimesSync(path.join(dir, name), FIXED_TIME, FIXED_TIME);
  }
}

// Both sides read the same temp dir; cleanup re-seeds it before each side.
const uploadsDir = work => path.join(work, 'tmp');

function corpus({ work, cookie, token }) {
  const F = path.join(work, 'files');
  const f = name => path.join(F, name);
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const RH = { Host: 'box.example.com', 'X-Request-Id': 'diff-req-1' };
  const J = { 'Content-Type': 'application/json' };
  const q = (p, extra = '') => `/api/download?path=${encodeURIComponent(p)}${extra}`;
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const post = (body, headers) => ({ method: 'POST', url: '/api/auth/download-ticket', headers, body });
  const authed = { ...RH, ...J, 'X-Access-Token': token };
  const remember = (res, side) => { side.state.etag = res.headers.etag; side.state.lm = res.headers['last-modified']; };
  const ticketOf = key => (res, side) => {
    try { side.state[key] = JSON.parse(res.body.toString('utf8')); } catch (_) { side.state[key] = {}; }
  };
  const blankTicket = (v) => {
    v.body = v.body.replace(/"ticket":"[A-Za-z0-9_-]{32}","expiresAt":\d+/, '"ticket":"<t>","expiresAt":0');
    if (v.headers.etag) v.headers.etag = '<etag of a random ticket>';
    return v;
  };
  const withTicket = key => side => `${side.state[key].target}&download_ticket=${side.state[key].ticket}`;
  const ranged = (range, extra = {}) => get(q(f('file.txt')), { ...L, Range: range, ...extra });
  return [
    // the route
    ['missing path', get('/api/download')],
    ['empty path', get('/api/download?path=')],
    ['blank path', get(q('  \t'))],
    ['directory', get(q(F))],
    ['missing file', get(q(f('missing.txt')))],
    ['relative missing', get(q('nope/missing.txt'))],
    ['dotdot path', get(q(`${F}/sub/../file.txt`, '&inline=1'))],
    ['nul in path', get(q(`${f('file.txt')}\u0000x`))],
    ['inline', get(q(f('file.txt'), '&inline=1')), { capture: remember }],
    ['attachment', get(q(f('file.txt')))],
    ['inline=true is not inline', get(q(f('file.txt'), '&inline=true'))],
    ['repeated path', get(`${q(f('file.txt'))}&path=x`)],
    ['path[] array', get(`/api/download?path[]=${encodeURIComponent(f('file.txt'))}`)],
    ['cjk attachment', get(q(f('中文 名.png')))],
    ['latin1 name', get(q(f('café.txt')))],
    ['quote in name, json type', get(q(f('a"b.json')))],
    ['empty json file', get(q(f('empty.json')))],
    ['empty json file gzip', get(q(f('empty.json')), { ...L, 'Accept-Encoding': 'gzip' })],
    ['dotfile', get(q(f('.hidden')))],
    ['file in dot dir', get(q(f('.dir/inside.txt')))],
    ['percent-encoded retry', get(q(path.join(F, encodeURIComponent('社媒触达 照片墙.png')), '&inline=1'))],
    ['literal percent wins', get(q(f('a%20b.png'), '&inline=1'))],
    ['stray percent', get(q(f('100%.png')))],
    ['bad utf8 escape', get(q(f('%E7%A4%BE.png')))],
    ['big file', get(q(f('big.bin')))],
    ['trailing slash route', get(`/api/download/?path=${encodeURIComponent(f('file.txt'))}`)],
    ['mixed case route', get(`/api/Download?path=${encodeURIComponent(f('file.txt'))}`)],
    // send: ranges and conditionals
    ['range 1-2', ranged('bytes=1-2')],
    ['range suffix', ranged('bytes=-1')],
    ['range unsatisfiable', ranged('bytes=9-')],
    ['range multi', ranged('bytes=0-0,2-3')],
    ['range other unit', ranged('items=0-1')],
    ['if-range stale', ranged('bytes=1-2', { 'If-Range': '"other"' })],
    ['if-none-match', side => get(q(f('file.txt')), { ...L, 'If-None-Match': side.state.etag })],
    ['if-modified-since', side => get(q(f('file.txt')), { ...L, 'If-Modified-Since': side.state.lm })],
    ['if-none-match no-cache', side => get(q(f('file.txt')), { ...L, 'If-None-Match': side.state.etag, 'Cache-Control': 'no-cache' })],
    ['if-match mismatch', get(q(f('file.txt')), { ...L, 'If-Match': '"nope"' })],
    ['if-unmodified-since old', get(q(f('file.txt')), { ...L, 'If-Unmodified-Since': 'Mon, 01 Jan 2001 00:00:00 GMT' })],
    ['HEAD', head(q(f('file.txt')))],
    ['HEAD missing', head(q(f('missing.txt')))],
    // the gate
    ['remote no auth', get(q(f('file.txt')), RH)],
    ['remote html no auth', get(q(f('file.txt')), { ...RH, Accept: 'text/html' })],
    ['remote token', get(q(f('file.txt')), { ...RH, 'X-Access-Token': token })],
    ['remote cookie', get(q(f('file.txt')), { ...RH, Cookie: `multicc_auth=${cookie}` })],
    // tickets
    ['issue without auth', post(JSON.stringify({ path: f('file.txt'), inline: true }), { ...RH, ...J })],
    ['issue inline', post(JSON.stringify({ path: f('file.txt'), inline: true }), authed), { capture: ticketOf('inline'), normalize: blankTicket }],
    ['ticket opens its target', side => get(withTicket('inline')(side), RH)],
    ['ticket is reusable', side => get(withTicket('inline')(side), RH)],
    ['ticket on another path', side => get(`${q(f('café.txt'), '&inline=1')}&download_ticket=${side.state.inline.ticket}`, RH)],
    ['ticket with extra key', side => get(`${withTicket('inline')(side)}&x=1`, RH)],
    ['ticket on HEAD', side => head(withTicket('inline')(side), RH)],
    ['bogus ticket', get(`${q(f('file.txt'), '&inline=1')}&download_ticket=bogus`, RH)],
    ['issue attachment', post(JSON.stringify({ path: f('中文 名.png') }), authed), { capture: ticketOf('attach'), normalize: blankTicket }],
    ['attachment ticket', side => get(withTicket('attach')(side), RH)],
    ['issue inline as string', post(JSON.stringify({ path: f('file.txt'), inline: 'true' }), authed), { normalize: blankTicket }],
    ['issue empty object', post('{}', authed)],
    ['issue without json type', post(JSON.stringify({ path: '/x' }), { ...RH, 'X-Access-Token': token })],
    ['issue array', post('[1]', authed)],
    ['issue number path', post('{"path":1}', authed)],
    ['issue nul path', post('{"path":"a\\u0000b"}', authed)],
    ['issue malformed', post('{"path":', authed)],
    ['issue over 4kb', post(JSON.stringify({ path: 'x'.repeat(5000) }), authed)],
    // Express's automatic OPTIONS
    ['OPTIONS download', { method: 'OPTIONS', url: '/api/download', headers: L }],
    ['OPTIONS ticket', { method: 'OPTIONS', url: '/api/auth/download-ticket', headers: L }],
    ['OPTIONS stats', { method: 'OPTIONS', url: '/api/uploads/stats', headers: L }],
    ['OPTIONS cleanup', { method: 'OPTIONS', url: '/api/uploads/cleanup', headers: L }],
    // upload temp files
    ['stats', get('/api/uploads/stats')],
    ['HEAD stats', head('/api/uploads/stats')],
    ['cleanup malformed body', { method: 'DELETE', url: '/api/uploads/cleanup', headers: { ...L, ...J }, body: '{' }, { before: () => writeUploads(uploadsDir(work)) }],
    ['cleanup', { method: 'DELETE', url: '/api/uploads/cleanup', headers: L }, { before: () => writeUploads(uploadsDir(work)) }],
    ['stats after cleanup', get('/api/uploads/stats')],
  ];
}

main({
  name: 'download-link',
  auth: repo => ({
    createAuthRuntime: loadDeleted(repo, BASELINE, 'src/routes/auth.js').createAuthRuntime,
    createAuthSecurity: loadDeleted(repo, BASELINE, 'src/auth-security.js').createAuthSecurity,
  }),
  mount(app, { repo, work }) {
    writeFiles(path.join(work, 'files'));
    writeUploads(uploadsDir(work));
    const route = loadDeleted(repo, BASELINE, 'src/routes/file-transfer.js');
    route.mountFileTransferRoutes(app, {
      fs,
      path,
      os: { homedir: () => work, tmpdir: () => uploadsDir(work) },
      upload: { chat: (req, res, next) => next() },
      persistChatUpload: () => { throw new Error('not exercised'); },
      sendUploadError: (res) => res.status(500).json({ error: 'not exercised' }),
      getActiveSession: () => null,
      getPersistedSession: () => null,
      log: () => {},
    });
  },
  // os.tmpdir() drops the trailing slash.
  gatewayEnv: work => ({ TMPDIR: `${uploadsDir(work)}/` }),
  corpus,
});
