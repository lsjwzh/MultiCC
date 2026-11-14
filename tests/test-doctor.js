'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runToolLoop } = require('../src/doctor/llm-loop');
const { createDoctorTools, checkCommand, redact } = require('../src/doctor/tools');
const { createDoctorService } = require('../src/doctor/service');
const { mountDoctorRoutes } = require('../src/routes/doctor');

function fixture(autofix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')));
  const worktree = path.join(root, 'wt'); fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'hello\nworld\n');
  fs.writeFileSync(path.join(worktree, '.env'), 'KEY=sk-abcdefghijklmnopqrstuv');
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'logs', 'err.log'), 'ok\nboom ERROR here\nfine\n');
  const session = { id: 's1', cli: 'claude', worktreePath: worktree, apiKey: 'sekret-value-123456' };
  const deps = { sessionId: 's1', getSession: id => (id === 's1' ? session : null), loadHistory: () => [{ role: 'assistant', content: 'x', error: true }],
    cwdOf: () => worktree, repoRoot: root, dataDir: root, logDirs: [path.join(root, 'logs')], autofix,
    exec: async argv => ({ code: 0, stdout: `ran ${argv.join(' ')}`, stderr: '' }) };
  return { root, worktree, ...createDoctorTools(deps) };
}
const get = (tools, n) => tools.find(t => t.name === n);

test('reads are jailed and credentials never leak', async () => {
  const { tools, worktree, root } = fixture(false);
  assert.match(get(tools, 'read_file').run({ path: path.join(worktree, 'a.txt') }), /1\thello/);
  assert.throws(() => get(tools, 'read_file').run({ path: path.join(worktree, '.env') }), /拒绝/);
  assert.throws(() => get(tools, 'read_file').run({ path: '/etc/hosts' }), /不在可读范围/);
  assert.throws(() => get(tools, 'read_file').run({ path: path.join(root, '..', '..', 'etc', 'hosts') }), /不在可读范围/);
  assert.equal(get(tools, 'session_info').run({}).apiKey, '***');
  assert.match(get(tools, 'tail_file').run({ path: path.join(root, 'logs', 'err.log'), filter: 'error' }), /boom/);
  assert.doesNotMatch(get(tools, 'search_text').run({ pattern: 'sk-abc', path: worktree }), /sk-abc/);
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop1234'), 'Authorization: Bearer ***'.replace('Bearer ***', '***'));
});

test('read-only mode has no write tools; commands are allowlisted', async () => {
  const { tools } = fixture(false);
  assert.equal(get(tools, 'edit_file'), undefined);
  assert.equal(checkCommand(['git', 'status'], false), null);
  assert.match(checkCommand(['git', 'push'], true), /白名单/);
  assert.match(checkCommand(['git', '-c', 'core.pager=x', 'log'], true), /禁止/);
  assert.match(checkCommand(['git', 'rebase', '--abort'], false), /autofix/);
  assert.match(checkCommand(['rm', '-rf', '/'], true), /不在白名单/);
  await assert.rejects(get(tools, 'run_command').run({ argv: ['curl', 'x'] }), /白名单/);
});

test('autofix edits only in main or the session worktree and records actions', async () => {
  const { tools, actions, worktree, root } = fixture(true);
  get(tools, 'edit_file').run({ path: path.join(worktree, 'a.txt'), old: 'world', new: 'doctor' });
  assert.equal(fs.readFileSync(path.join(worktree, 'a.txt'), 'utf8'), 'hello\ndoctor\n');
  // The main checkout is writable too: relative paths are based on it.
  fs.writeFileSync(path.join(root, 'main.js'), 'const a = 1;\n');
  get(tools, 'edit_file').run({ path: 'main.js', old: 'a = 1', new: 'a = 2' });
  assert.equal(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), 'const a = 2;\n');
  // ...but runtime data, sibling worktrees and the .git dir are not.
  fs.mkdirSync(path.join(root, 'chat_history'), { recursive: true });
  fs.writeFileSync(path.join(root, 'chat_history', 's1.json'), '[]');
  assert.throws(() => get(tools, 'edit_file').run({ path: 'chat_history/s1.json', old: '[]', new: 'x' }), /禁止/);
  fs.mkdirSync(path.join(root, '.multicc-worktrees', 'other'), { recursive: true });
  fs.writeFileSync(path.join(root, '.multicc-worktrees', 'other', 'f.js'), 'x');
  assert.throws(() => get(tools, 'edit_file').run({ path: '.multicc-worktrees/other/f.js', old: 'x', new: 'y' }), /禁止/);
  assert.throws(() => get(tools, 'edit_file').run({ path: '../outside.txt', old: 'a', new: 'b' }), /worktree|禁止|只允许/);
  assert.throws(() => get(tools, 'edit_file').run({ path: '.git/config', old: 'a', new: 'b' }), /禁止|不存在|ENOENT/);
  assert.throws(() => get(tools, 'edit_file').run({ path: path.join(worktree, 'a.txt'), old: 'zzz', new: 'b' }), /恰好出现/);
  await get(tools, 'run_command').run({ argv: ['git', 'rebase', '--abort'] });
  assert.deepEqual(actions.map(a => a.kind), ['edit_file', 'edit_file', 'command']);
  await assert.rejects(get(tools, 'kill_process').run({ pid: process.pid }), /拒绝/);
});

const toolDef = [{ name: 'echo', description: 'e', parameters: { type: 'object', properties: {} }, run: a => `got ${a.v}` },
  { name: 'finish', description: 'f', parameters: { type: 'object', properties: {} }, run: () => 'ok' }];

test('doctor reads Responses SSE even when a relay omits or mislabels Content-Type', async t => {
  const http = require('node:http');
  const reply = { output: [{ type: 'function_call', call_id: 'done', name: 'finish', arguments: '{"summary":"ok"}' }] };
  const server = http.createServer((req, res) => {
    req.resume();
    const mode = req.url.slice(1);
    if (mode !== 'missing') res.setHeader('Content-Type', mode === 'sse' ? 'text/event-stream' : 'application/json');
    if (mode === 'json') return res.end(JSON.stringify(reply));
    res.end(`event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n`
      + `event: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: reply })}\r\n\r\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const mode of ['missing', 'mislabeled', 'sse', 'json']) {
    const result = await runToolLoop({
      target: { wireApi: 'responses', url: `http://127.0.0.1:${server.address().port}/${mode}`, apiKey: 'test-only' },
      model: 'm', system: 's', user: 'u', tools: toolDef,
    });
    assert.equal(result.finished, true, mode);
    assert.equal(result.report.summary, 'ok', mode);
  }
});

for (const [wire, first, second, expectResultShape] of [
  ['messages',
    { content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 't1', name: 'echo', input: { v: 1 } }] },
    { content: [{ type: 'tool_use', id: 't2', name: 'finish', input: { summary: 'done', rootCause: 'x' } }] },
    msgs => msgs.at(-1).content[0].type === 'tool_result'],
  ['chat_completions',
    { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'echo', arguments: '{"v":1}' } }] } }] },
    { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'finish', arguments: '{"summary":"done","rootCause":"x"}' } }] } }] },
    msgs => msgs.some(m => m.role === 'tool' && m.content === 'got 1')],
  ['responses',
    { output: [{ type: 'function_call', call_id: 'r1', name: 'echo', arguments: '{"v":1}' }] },
    { output: [{ type: 'function_call', call_id: 'r2', name: 'finish', arguments: '{"summary":"done","rootCause":"x"}' }] },
    items => items.some(i => i.type === 'function_call_output' && i.output === 'got 1')],
]) {
  test(`tool loop speaks ${wire}`, async () => {
    const replies = [first, second]; const bodies = [];
    const result = await runToolLoop({ target: { wireApi: wire, url: 'http://x', apiKey: 'k' }, model: 'm', system: 's', user: 'u', tools: toolDef,
      post: async (_t, body) => { bodies.push(JSON.parse(JSON.stringify(body))); return replies.shift(); } });
    assert.equal(result.finished, true);
    assert.equal(result.report.summary, 'done');
    const history = bodies[1].messages || bodies[1].input;
    assert.ok(expectResultShape(history), JSON.stringify(history));
  });
}

test('tool loop has no turn cap by default and trims old tool output', async () => {
  let n = 0; const bodies = [];
  const result = await runToolLoop({ target: { wireApi: 'chat_completions', url: 'http://x', apiKey: 'k' }, model: 'm', system: 's', user: 'u',
    tools: [{ name: 'big', description: 'b', parameters: { type: 'object', properties: {} }, run: () => 'x'.repeat(5000) }, toolDef[1]],
    post: async (_t, body) => {
      bodies.push(JSON.parse(JSON.stringify(body))); n++;
      const call = n < 40 ? { id: `c${n}`, function: { name: 'big', arguments: '{}' } } : { id: 'f', function: { name: 'finish', arguments: '{"summary":"s","rootCause":"r"}' } };
      return { choices: [{ message: { content: '', tool_calls: [call] } }] };
    } });
  assert.equal(result.finished, true);
  assert.equal(result.turns, 40, 'ran well past the old 14-turn cap');
  const tools = bodies.at(-1).messages.filter(m => m.role === 'tool');
  assert.ok(tools.slice(0, 5).every(m => m.content.length < 400), 'old output is trimmed');
  assert.equal(tools.at(-1).content.length, 5000, 'recent output stays whole');
});

test('tool loop reports unknown tools back to the model and stops at maxTurns', async () => {
  const seen = [];
  const result = await runToolLoop({ target: { wireApi: 'chat_completions', url: 'http://x', apiKey: 'k' }, model: 'm', system: 's', user: 'u', tools: toolDef, maxTurns: 2,
    post: async (_t, body) => { seen.push(body); return { choices: [{ message: { content: '', tool_calls: [{ id: 'n', function: { name: 'nope', arguments: '{}' } }] } }] }; } });
  assert.equal(result.exhausted, true);
  assert.match(seen[1].messages.at(-1).content, /未知工具/);
});

test('service runs a diagnosis end to end and routes expose it', async () => {
  const { tools: _ignore, ...fx } = fixture(false);
  const doctor = createDoctorService({
    getSession: id => (id === 's1' ? { id: 's1', worktreePath: fx.worktree } : null), loadHistory: () => [], cwdOf: () => fx.worktree,
    resolveTarget: () => ({ target: { wireApi: 'messages', url: 'http://x', apiKey: 'k' }, model: 'm' }),
    repoRoot: fx.root, dataDir: fx.root, logDirs: [], exec: async () => ({ code: 0, stdout: '## main', stderr: '' }),
    loop: async ({ user, tools }) => {
      assert.match(user, /Preliminary snapshot/);
      assert.ok(!tools.some(t => t.name === 'edit_file'));
      return { finished: true, turns: 2, report: { summary: 'ok', rootCause: 'stale lock' } };
    },
  });
  const routes = {};
  mountDoctorRoutes({ post: (p, h) => { routes['POST ' + p] = h; }, get: (p, h) => { routes['GET ' + p] = h; } }, { doctor });
  const reply = () => { const r = { code: 200 }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; return r; };
  const missing = reply(); routes['POST /api/sessions/:id/doctor']({ params: { id: 'nope' }, body: {} }, missing);
  assert.equal(missing.code, 404);
  const started = reply(); routes['POST /api/sessions/:id/doctor']({ params: { id: 's1' }, body: { autofix: false } }, started);
  assert.ok(started.body.runId);
  await new Promise(r => setTimeout(r, 30));
  const got = reply(); routes['GET /api/doctor/runs/:runId']({ params: { runId: started.body.runId } }, got);
  assert.equal(got.body.run.status, 'done');
  assert.equal(got.body.run.report.rootCause, 'stale lock');
});

test('service refuses politely when Aux is unavailable', () => {
  const doctor = createDoctorService({ getSession: () => ({}), resolveTarget: () => { throw new Error('Aux Provider 不可用'); } });
  const out = doctor.start({ sessionId: 's1' });
  assert.equal(out.ok, false); assert.equal(out.status, 503);
});

test('chat button polls the run and posts one readable report', async () => {
  const { create } = require('../public/chat-doctor');
  const msgs = []; const calls = [];
  let polls = 0;
  const fetchStub = async (url, init) => {
    calls.push([url, init && init.body]);
    if (init && init.method === 'POST') return { ok: true, json: async () => ({ runId: 'doc_1' }) };
    polls++;
    const run = polls < 2 ? { status: 'running', events: [{ type: 'tool', name: 'tail_file' }] }
      : { status: 'done', autofix: true, actions: [{ kind: 'remove_lock', detail: 'x' }], events: [{ type: 'tool', name: 'tail_file' }], report: { summary: 'S', rootCause: 'R', nextSteps: ['restart'] } };
    return { ok: true, json: async () => ({ run }) };
  };
  const doc = { getElementById: () => null };
  const doctor = create({ document: doc, translate: (k, v) => k + JSON.stringify(v || {}), fetch: fetchStub, sleep: async () => {}, getSessionName: () => 's 1', addSystemMsg: m => msgs.push(m), withToken: u => u });
  const out = await doctor.diagnose({ autofix: true });
  assert.equal(out.ok, true);
  assert.match(calls[0][0], /sessions\/s%201\/doctor/);
  assert.equal(JSON.parse(calls[0][1]).autofix, true);
  assert.match(msgs.at(-1), /doctorRootCause\{"cause":"R"\}[\s\S]*remove_lock[\s\S]*restart/);
});

test('offer() puts one diagnose button on an abnormal output and reuses the same flow', () => {
  const { create } = require('../public/chat-doctor');
  const children = [];
  const el = { appendChild: c => children.push(c), querySelector: sel => children.find(c => sel === '.doctor-offer' && c.className === 'doctor-offer') || null };
  const makeBtn = () => ({ listeners: {}, style: {}, addEventListener(t, f) { this.listeners[t] = f; } });
  const doctor = create({ document: { getElementById: () => null, createElement: makeBtn }, translate: k => k, fetch: async () => ({ ok: false, json: async () => ({ error: 'x' }) }),
    getSessionName: () => 's1', addSystemMsg: () => {}, withToken: u => u });
  const button = doctor.offer(el);
  assert.equal(button.textContent, 'doctorOffer');
  assert.equal(doctor.offer(el), null, 'no duplicate button on the same element');
  assert.equal(doctor.offer(null), null);
});

function serviceWith(report, { draftTitle } = {}) {
  const fx = fixture(false);
  const home = os.homedir();
  const doctor = createDoctorService({
    getSession: id => (id === 's1' ? { id: 's1', cli: 'claude', worktreePath: fx.worktree } : null), loadHistory: () => [], cwdOf: () => fx.worktree,
    resolveTarget: () => ({ target: { wireApi: 'messages', url: 'http://x', apiKey: 'k' }, model: 'm' }),
    repoRoot: fx.root, dataDir: fx.root, logDirs: [], exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    loop: async ({ tools }) => {
      if (draftTitle) await tools.find(t => t.name === 'propose_issue').run({ title: draftTitle, body: `卡在 ${home}/x，token=sk-abcdefghijklmnopqrstuvwx` });
      return { finished: true, turns: 3, report };
    },
  });
  return doctor;
}
const settle = async (doctor) => {
  const { runId } = doctor.start({ sessionId: 's1' });
  await new Promise(r => setTimeout(r, 30));
  return doctor.get(runId);
};

test('unsolved run gets a scrubbed GitHub issue draft with a prefilled url, solved run does not', async () => {
  const unsolved = await settle(serviceWith({ summary: '卡死', rootCause: '未确认', fixed: false }, { draftTitle: `标题 ${os.homedir()}` }));
  assert.ok(unsolved.issue, 'issue offered');
  assert.equal(unsolved.issue.repo, 'lsjwzh/MultiCC');
  assert.ok(unsolved.issue.url.startsWith('https://github.com/lsjwzh/MultiCC/issues/new?title='));
  assert.ok(!unsolved.issue.body.includes(os.homedir()) && !unsolved.issue.title.includes(os.homedir()), 'home path scrubbed');
  assert.ok(!/sk-abcdefghijklmnopqrstuvwx/.test(unsolved.issue.body + unsolved.issue.url), 'credentials scrubbed');
  assert.match(unsolved.issue.body, /环境（自动附带）/);
  assert.equal(unsolved.issueDraft, undefined, 'raw draft is not exposed');
  const fallback = await settle(serviceWith({ summary: '没修好', rootCause: '未确认', evidence: ['日志里有 ERR'] }));
  assert.match(fallback.issue.body, /## 现象[\s\S]*没修好[\s\S]*日志里有 ERR/, 'auto-built when the model gave no draft');
  const solved = await settle(serviceWith({ summary: 'ok', rootCause: 'lock', fixed: true }));
  assert.equal(solved.issue, undefined);
});

test('issue button asks for confirmation before anything opens', async () => {
  const { create } = require('../public/chat-doctor');
  const makeBtn = () => ({ style: {}, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } });
  const opened = []; const msgs = []; const el = { appendChild(c) { this.btn = c; } };
  const issue = { repo: 'o/r', title: 'T', body: 'B', url: 'https://github.com/o/r/issues/new?title=T', truncated: false };
  let answer = false;
  const doctor = create({ document: { getElementById: () => null, createElement: makeBtn }, translate: (k, v) => k + JSON.stringify(v || {}),
    getSessionName: () => 's1', addSystemMsg: m => msgs.push(m), withToken: u => u, confirm: async () => answer, open: u => opened.push(u) });
  const btn = doctor.offerIssue(el, issue);
  const ev = { preventDefault() {}, stopPropagation() {} };
  await btn.listeners.click(ev);
  assert.deepEqual(opened, [], 'declined: nothing opens');
  answer = true;
  await btn.listeners.click(ev);
  assert.deepEqual(opened, [issue.url]);
  assert.match(msgs.at(-1), /doctorIssueOpened/);
});

function fakeDocument() {
  class El {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.textContent = ''; this.className = '';
      this.classList = { set: new Set(), add: (...n) => n.forEach(x => this.classList.set.add(x)), remove: (...n) => n.forEach(x => this.classList.set.delete(x)) };
    }
    appendChild(child) { this.children.push(child); return child; }
    remove() { this.removed = true; }
    setAttribute(name, value) { this.attributes = { ...(this.attributes || {}), [name]: value }; }
    find(predicate) { return this.children.find(predicate) || null; }
  }
  const body = new El('body');
  return { body, createElement: tag => new El(tag), getElementById: () => null, El };
}

test('diagnosis progress streams into one small panel, only the report reaches the chat', async () => {
  const { create } = require('../public/chat-doctor');
  const doc = fakeDocument();
  const msgs = [];
  let polls = 0;
  const fetchStub = async (url, init) => {
    if (init && init.method === 'POST') return { ok: true, json: async () => ({ runId: 'doc_1' }) };
    polls++;
    const run = polls < 2
      ? { status: 'running', events: [{ type: 'tool', name: 'run_command' }, { type: 'tool', name: 'tail_file' }] }
      : { status: 'done', events: [{ type: 'tool', name: 'run_command' }, { type: 'tool', name: 'tail_file' }], report: { summary: 'S', rootCause: 'R' } };
    return { ok: true, json: async () => ({ run }) };
  };
  const doctor = create({ document: doc, translate: (k, v) => k + JSON.stringify(v || {}), fetch: fetchStub, sleep: async () => {},
    getSessionName: () => 's1', addSystemMsg: m => msgs.push(m), withToken: u => u });
  await doctor.diagnose();

  const panel = doc.body.find(el => el.id === 'doctor-process-panel');
  assert.ok(panel, 'a floating panel is created');
  assert.deepEqual(panel.classList.set.has('done'), true);
  const body = panel.find(el => el.className === 'doctor-panel-body');
  assert.equal(body.children.length, 2, 'start line + one tool batch line');
  assert.match(body.children[1].textContent, /tail_file/);
  assert.equal(msgs.length, 1, 'progress never becomes chat messages');
  assert.match(msgs[0], /doctorReportDone/);
});
