'use strict';

// Golden coverage for the task-context wall that a bound task session
// receives as its first-turn prompt prefix. Everything is pinned exactly:
// the whole rendered text, the manifest and the sha256 digests, so the
// builder can move to the Rust kernel without changing a byte.

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildTaskRunContext } = require('../src/task-board/turn-context');

const HEADER = '[MultiCC task run context v1]';

test('renders the full context wall, manifest and digest', () => {
  const out = buildTaskRunContext({
    task: {
      id: 'tsk-abc', title: 'Fix the thing', status: 'active',
      summary: 'A short summary.', areas: ['web', 'api', 'api'],
    },
    messages: [
      { id: 'm2', role: 'assistant', ts: 2000, text: 'second' },
      { id: 'm1', role: 'user', ts: 1000, text: 'first line\nsecond line' },
    ],
    artifacts: [
      { id: 'a1', name: 'report.txt', mimeType: 'text/plain', content: 'body text', size: 9 },
      { id: 'a2', name: 'log', path: '/tmp/x.log' },
    ],
    currentText: 'Do the thing.',
  });
  assert.deepStrictEqual(out, {
    text: `${HEADER}\n\nTask: Fix the thing\nTask ID: tsk-abc\nStatus: active\n`
      + 'Summary: A short summary.\nAreas: api, web\n\n'
      + 'Conversation history (chronological; earlier content may be omitted):\n'
      + '- User：first line\n  second line\n'
      + '- Assistant：second\n\n'
      + 'Related artifacts (references only, no content):\n'
      + '- report.txt (sha256:d9fbbc91492fbb3ba8e57ca15b039134e7098030a89578315a4c354f9117ccf2, 9 bytes)\n'
      + '- log (sha256:a93af66f8240113549201f261890efef402d3ca0da63b7506842ae81fa73794b)\n\n'
      + 'Current request:\nDo the thing.',
    manifest: {
      schema: 'multicc.task-run-context',
      version: 1,
      maxChars: 12000,
      task: {
        id: 'tsk-abc',
        title: 'Fix the thing',
        summaryHash: 'sha256:838485e01e095157c3023445252559256e2a26220b0192ff585382ded9d8caae',
      },
      messageCount: 2,
      history: {
        included: 2,
        omitted: 0,
        truncated: false,
        refs: [
          {
            id: 'm1',
            role: 'user',
            ts: 1000,
            hash: 'sha256:73621482ff083eca9ea88880393298f7d3f53402200780b0c16354a9beb0535a',
            partial: false,
          },
          {
            id: 'm2',
            role: 'assistant',
            ts: 2000,
            hash: 'sha256:16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4',
            partial: false,
          },
        ],
      },
      artifacts: [
        {
          id: 'a1',
          name: 'report.txt',
          hash: 'sha256:d9fbbc91492fbb3ba8e57ca15b039134e7098030a89578315a4c354f9117ccf2',
          mimeType: 'text/plain',
          size: 9,
        },
        {
          id: 'a2',
          name: 'log',
          hash: 'sha256:a93af66f8240113549201f261890efef402d3ca0da63b7506842ae81fa73794b',
        },
      ],
      artifactDisplayCount: 2,
      currentTextHash: 'sha256:5f398191f09fb70a2eee093ea10c4086b0858d3f2ad7c9ed03d8f8aa512a1fbd',
    },
    hash: 'sha256:11500c92d14cb2222d70c6b7ab4643229fd3f8aff9585d08d6e94f318194bcd1',
  });
});

test('redacts credentials and native session identities everywhere', () => {
  const out = buildTaskRunContext({
    task: {
      id: 'tsk-redact',
      title: 'api_key: sk-abcdefgh1234',
      summary: 'Authorization: Bearer abcdef123456 and cliSessionId=abc-123',
    },
    messages: [
      { id: 'm1', role: 'user', ts: 1, text: 'nativeSessionId: xyz 中文cliSessionId：zz' },
      {
        id: 'm2',
        role: 'assistant',
        ts: 2,
        text: '{"apiKey": "abc", "refreshToken": "def", "client_secret": "ghi"}',
      },
    ],
    currentText: 'token=secretvalue password="hunter2"',
  });
  assert.deepStrictEqual(out, {
    text: `${HEADER}\n\nTask: api_key=[redacted]\nTask ID: tsk-redact\n`
      + 'Summary: Authorization=[redacted]\n\n'
      + 'Conversation history (chronological; earlier content may be omitted):\n'
      + '- User：[redacted session id] 中文[redacted session field]：zz\n'
      + '- Assistant：{apiKey=[redacted], refreshToken=[redacted], client_secret=[redacted]}\n\n'
      + 'Current request:\ntoken=[redacted] password=[redacted]',
    manifest: {
      schema: 'multicc.task-run-context',
      version: 1,
      maxChars: 12000,
      task: {
        id: 'tsk-redact',
        title: 'api_key=[redacted]',
        summaryHash: 'sha256:a332200f26c8713d1c43bd5a36fee3c7b4564be36a36c4d07e7ef841e52600d7',
      },
      messageCount: 2,
      history: {
        included: 2,
        omitted: 0,
        truncated: false,
        refs: [
          {
            id: 'm1',
            role: 'user',
            ts: 1,
            hash: 'sha256:ebf39cc85c807786064d7b5428c86fe64f5d001f45d5607156cc618fc96802ed',
            partial: false,
          },
          {
            id: 'm2',
            role: 'assistant',
            ts: 2,
            hash: 'sha256:5c2f078fc644f5b773c268f4cb366b9e02f3b580ce297d47c69409b8e883c11c',
            partial: false,
          },
        ],
      },
      artifacts: [],
      artifactDisplayCount: 0,
      currentTextHash: 'sha256:5d770703d6c66545ca62a8a62c80207d482352809176a497b7001979e496e894',
    },
    hash: 'sha256:7791cd07624ca8afbb42a4f88d1c5007b3e1fcafe993bc279ce2378e754eae18',
  });
});

test('the default budget truncates to exactly 12000 UTF-16 code units', () => {
  const prefix = `${HEADER}\n\nTask: Long\nTask ID: tsk-long\n\n`
    + 'Conversation history (chronological; earlier content may be omitted):\n- User：';
  // 11861 body units + one ellipsis + the 138-unit shell == 12000.
  const expectedText = `${prefix}${'x'.repeat(12000 - prefix.length - 1)}…`;
  assert.equal(expectedText.length, 12000);

  const out = buildTaskRunContext({
    task: { id: 'tsk-long', title: 'Long' },
    messages: [{ id: 'm1', role: 'user', ts: 1, text: 'x'.repeat(30000) }],
    includeCurrent: false,
  });
  assert.equal(out.text, expectedText);
  assert.deepStrictEqual(out.manifest, {
    schema: 'multicc.task-run-context',
    version: 1,
    maxChars: 12000,
    task: { id: 'tsk-long', title: 'Long', summaryHash: null },
    messageCount: 1,
    history: {
      included: 1,
      omitted: 0,
      truncated: true,
      refs: [{
        id: 'm1',
        role: 'user',
        ts: 1,
        hash: 'sha256:8a6d5f7b1061fefacb7509d5bf23a3227c8a3a6ecfe51dc9f666772c99b75b98',
        partial: true,
      }],
    },
    artifacts: [],
    artifactDisplayCount: 0,
    currentTextHash: null,
  });
  assert.equal(out.hash, 'sha256:154cf22ddab7d457d7d38b567645e3ea099ba8f0a990beb601f43f699c04adda');
});

test('a cut through a surrogate pair leaves the lone high surrogate', () => {
  const out = buildTaskRunContext({
    task: { id: 't', title: '标题😀' },
    messages: [{ id: 'm', role: 'user', ts: 1, text: 'a😀b😀c😀d😀e😀f😀g😀h😀i😀j😀k😀l😀m😀n😀o😀p😀' }],
    includeCurrent: false,
    maxChars: 152,
  });
  assert.equal(
    out.text,
    `${HEADER}\n\nTask: 标题😀\nTask ID: t\n\n`
      + 'Conversation history (chronological; earlier content may be omitted):\n'
      + '- User：a😀b😀c😀d😀e😀f😀g\ud83d…',
  );
  assert.equal(out.text.length, 152);
  assert.equal(out.text.charCodeAt(out.text.length - 2), 0xD83D);
  assert.equal(out.manifest.history.refs[0].partial, true);
  assert.equal(out.hash, 'sha256:48c9640c7f1298b7f3ad199833a82d1aa0b053a02b0019a18124035080070f0a');
});

test('keeps lone surrogates already present in the input', () => {
  const out = buildTaskRunContext({
    task: { id: 't', title: 'A\ud83dB' },
    messages: [{ id: 'm', role: 'user', ts: 1, text: 'A\ud83dB' }],
    includeCurrent: false,
    maxChars: 4000,
  });
  assert.equal(
    out.text,
    `${HEADER}\n\nTask: A\ud83dB\nTask ID: t\n\n`
      + 'Conversation history (chronological; earlier content may be omitted):\n- User：A\ud83dB',
  );
  assert.equal(out.manifest.task.title, 'A\ud83dB');
  assert.equal(out.hash, 'sha256:86b11eaf7fabc3c60bb782dab05c642f9fd8c0e12850a53f09c094b3bc727b61');
  assert.equal(
    out.manifest.history.refs[0].hash,
    'sha256:b9070035264f4bad638fbb193b6a0e0a1453a4a7b340a3907e06c43c3f7c19b4',
  );
});

test('caps the task id at 200 and the title at 240 code units', () => {
  const id = `${'i'.repeat(199)}…`;
  const title = `${'T'.repeat(239)}…`;
  const out = buildTaskRunContext({
    task: { id: 'i'.repeat(250), title: 'T'.repeat(300) },
    messages: [],
    includeCurrent: false,
  });
  assert.equal(id.length, 200);
  assert.equal(title.length, 240);
  assert.equal(out.text, `${HEADER}\n\nTask: ${title}\nTask ID: ${id}`);
  assert.equal(out.manifest.task.id, id);
  assert.equal(out.manifest.task.title, title);
  assert.equal(out.hash, 'sha256:ff63c60df3036a19cc64c250ad70381527307e0bbb56e509b6709424da064012');
});

test('orders messages by ts, then id, then role, then hash', () => {
  const out = buildTaskRunContext({
    task: { id: 'tsk-order', title: 'Order' },
    messages: [
      { id: 'b', role: 'user', ts: 5, text: 'five-b' },
      { id: 'a', role: 'assistant', ts: 5, text: 'five-a' },
      { id: 'a', role: 'user', ts: 5, text: 'five-a-user' },
      { id: 'z', role: 'system', ts: 1, text: 'one' },
    ],
    includeCurrent: false,
    maxChars: 4000,
  });
  assert.equal(
    out.text,
    `${HEADER}\n\nTask: Order\nTask ID: tsk-order\n\n`
      + 'Conversation history (chronological; earlier content may be omitted):\n'
      + '- System：one\n- Assistant：five-a\n- User：five-a-user\n- User：five-b',
  );
  assert.deepStrictEqual(
    out.manifest.history.refs.map(ref => `${ref.ts}:${ref.id}:${ref.role}`),
    ['1:z:system', '5:a:assistant', '5:a:user', '5:b:user'],
  );
});

test('normalizes every content shape through the same text pipeline', () => {
  const out = buildTaskRunContext({
    task: {
      id: 'tsk-shapes',
      title: { z: 1, a: [true, null, 'x'] },
      summary: 12345,
      status: ['a', 'b'],
      areas: ['b', 2, '', null, 'a'],
    },
    messages: [
      {
        id: 'm1',
        role: 'user',
        ts: '1700000000000',
        text: [{ type: 'text', text: 'alpha' }, { text: 'beta' }, { content: 'gamma' }, { z: 9, a: 1 }],
      },
      { id: 'm2', role: 'ASSISTANT ', ts: '2024-01-02T03:04:05Z', content: { text: 'obj text', secret: 'token=abc123' } },
      { id: 'm3', role: 'bogus', ts: 'not-a-date', body: 'body text' },
      'plain string message',
      42,
      null,
    ],
    includeCurrent: false,
    maxChars: 4000,
  });
  assert.equal(
    out.text,
    `${HEADER}\n\nTask: [object Object]\nTask ID: tsk-shapes\nStatus: a,b\n`
      + 'Summary: 12345\nAreas: 2, a, b\n\n'
      + 'Conversation history (chronological; earlier content may be omitted):\n'
      + '- Message：42\n'
      + '- Message：plain string message\n'
      + '- Message：body text\n'
      + '- User：alpha\n  beta\n  gamma\n  {"a":1,"z":9}\n'
      + '- Assistant：obj text',
  );
  assert.deepStrictEqual(
    out.manifest.history.refs.map(ref => [ref.id, ref.role, ref.ts]),
    [
      ['', 'unknown', 0],
      ['', 'unknown', 0],
      ['m3', 'unknown', 0],
      ['m1', 'user', 1700000000000],
      ['m2', 'assistant', 1704164645000],
    ],
  );
  assert.equal(out.manifest.task.title, '[object Object]');
  assert.equal(out.manifest.task.summaryHash, 'sha256:5994471abb01112afcc18159f6cc74b4f511b99806da59b3caf5a9c173cacfc5');
  assert.equal(out.hash, 'sha256:26f67cbc503e22ea2ca63e0d31da62de9cc629c2155acf113b56dbae800e8a04');
});

test('redacts secret keys in structured content and drops session fields', () => {
  const out = buildTaskRunContext({
    task: { id: 'tsk-structured', title: 'Structured' },
    messages: [{
      id: 'm1',
      role: 'tool',
      ts: 3,
      text: {
        nativeSessionId: 'abc',
        nested: { apiKey: 'zzz', ok: 'y' },
        list: [1, { cliSessionId: 'q', password: 'p' }],
      },
    }],
    includeCurrent: false,
    maxChars: 4000,
  });
  assert.equal(
    out.text,
    `${HEADER}\n\nTask: Structured\nTask ID: tsk-structured\n\n`
      + 'Conversation history (chronological; earlier content may be omitted):\n'
      + '- Tool：{"list":[1,{"password":"[redacted]"}],"nested":{"apiKey":"[redacted]","ok":"y"}}',
  );
  assert.equal(out.hash, 'sha256:f1c22deaddb432293517addaa5b6e3119a8c0f55d4de7662f7aa22c108b68091');
});

test('honours version, maxChars and includeCurrent', () => {
  const out = buildTaskRunContext({
    task: { id: 'tsk-custom', title: 'Custom' },
    messages: [{ id: 'm1', role: 'user', ts: 1, text: 'hello' }],
    currentText: 'now',
    version: 'v2',
    maxChars: 300,
  });
  assert.deepStrictEqual(out, {
    text: '[MultiCC task run context vv2]\n\nTask: Custom\nTask ID: tsk-custom\n\n'
      + 'Conversation history (chronological; earlier content may be omitted):\n- User：hello\n\n'
      + 'Current request:\nnow',
    manifest: {
      schema: 'multicc.task-run-context',
      version: 'v2',
      maxChars: 300,
      task: { id: 'tsk-custom', title: 'Custom', summaryHash: null },
      messageCount: 1,
      history: {
        included: 1,
        omitted: 0,
        truncated: false,
        refs: [{
          id: 'm1',
          role: 'user',
          ts: 1,
          hash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          partial: false,
        }],
      },
      artifacts: [],
      artifactDisplayCount: 0,
      currentTextHash: 'sha256:ed5eb9a37e2d8231af3388319b941995f6dc8755c56043d0cc52b5fe405a87de',
    },
    hash: 'sha256:26c56c483efb95b67a8353bbb2afe7c762418e0a7fcab5f2b1801816b2daa551',
  });
});

test('renders a minimal record with the default title', () => {
  const out = buildTaskRunContext({
    task: { id: 'tsk-empty' },
    messages: [],
    artifacts: [],
    includeCurrent: false,
  });
  assert.deepStrictEqual(out, {
    text: `${HEADER}\n\nTask: untitled task\nTask ID: tsk-empty`,
    manifest: {
      schema: 'multicc.task-run-context',
      version: 1,
      maxChars: 12000,
      task: { id: 'tsk-empty', title: 'untitled task', summaryHash: null },
      messageCount: 0,
      history: { included: 0, omitted: 0, truncated: false, refs: [] },
      artifacts: [],
      artifactDisplayCount: 0,
      currentTextHash: null,
    },
    hash: 'sha256:737bfd60b48d740af2ed7f8ba9d687a73affb4b226f7a7aff7ab620911aa72d1',
  });
});

test('renders artifact references with hash and size fallbacks', () => {
  const out = buildTaskRunContext({
    task: { id: 'tsk-art', title: 'Art' },
    messages: [],
    artifacts: [
      { name: 'with-hash', hash: 'ABCDEF'.padEnd(64, '0') },
      { name: 'prefixed', sha256: `sha256:${'a'.repeat(64)}`, size: 12 },
      { name: 'bad-hash', hash: 'nope' },
      'primitive artifact',
      { id: 'id-only', path: '/p', mimeType: 'image/png', bytes: 'raw' },
      { name: 'negative', size: -4 },
      { name: 'fractional', size: 2.5 },
    ],
    includeCurrent: false,
    maxChars: 4000,
  });
  assert.equal(
    out.text,
    `${HEADER}\n\nTask: Art\nTask ID: tsk-art\n\n`
      + 'Related artifacts (references only, no content):\n'
      + '- bad-hash (sha256:60bf9d5ef3111e97bf163bfb3f83b6ca0e5a915b85de0961a16faacf6b016945)\n'
      + '- fractional (sha256:bacb41d5104525e1a22860e0e982f14c75deab26411e09f3dec561d1cd719c74, 2.5 bytes)\n'
      + '- negative (sha256:5827483a89552b9e0e9221df72998286e8da3c40ebef09fac1acc6cda79636bf)\n'
      + `- prefixed (sha256:${'a'.repeat(64)}, 12 bytes)\n`
      + '- primitive artifact (sha256:0424b7b3c22ff59248b422c396a379c696f52f3fc8a20a788d9c6868008a90fa)\n'
      + '- with-hash (sha256:abcdef0000000000000000000000000000000000000000000000000000000000)\n'
      + '- unnamed artifact (sha256:d7439bee24773bcbfa2d0a97947ee36227b10d1022b1a55847e928965bb6bfde, 3 bytes)',
  );
  assert.deepStrictEqual(out.manifest.artifacts, [
    {
      id: '',
      name: 'bad-hash',
      hash: 'sha256:60bf9d5ef3111e97bf163bfb3f83b6ca0e5a915b85de0961a16faacf6b016945',
    },
    {
      id: '',
      name: 'fractional',
      hash: 'sha256:bacb41d5104525e1a22860e0e982f14c75deab26411e09f3dec561d1cd719c74',
      size: 2.5,
    },
    {
      id: '',
      name: 'negative',
      hash: 'sha256:5827483a89552b9e0e9221df72998286e8da3c40ebef09fac1acc6cda79636bf',
    },
    {
      id: '',
      name: 'prefixed',
      hash: `sha256:${'a'.repeat(64)}`,
      size: 12,
    },
    {
      id: '',
      name: 'primitive artifact',
      hash: 'sha256:0424b7b3c22ff59248b422c396a379c696f52f3fc8a20a788d9c6868008a90fa',
    },
    {
      id: '',
      name: 'with-hash',
      hash: 'sha256:abcdef0000000000000000000000000000000000000000000000000000000000',
    },
    {
      id: 'id-only',
      name: 'unnamed artifact',
      hash: 'sha256:d7439bee24773bcbfa2d0a97947ee36227b10d1022b1a55847e928965bb6bfde',
      mimeType: 'image/png',
      size: 3,
    },
  ]);
  assert.equal(out.manifest.artifactDisplayCount, 7);
});

test('renders CJK and emoji unchanged', () => {
  const out = buildTaskRunContext({
    task: {
      id: '任务-1',
      title: '修复：多语言 😀 支持',
      status: '进行中',
      summary: '包含 CJK 与 emoji 🎉 的摘要',
      areas: ['前端', '后端'],
    },
    messages: [
      { id: 'm1', role: 'user', ts: 1, text: '第一行\n第二行 😀' },
      { id: 'm2', role: 'assistant', ts: 2, text: '回复：已完成 ✅' },
    ],
    includeCurrent: false,
  });
  assert.equal(
    out.text,
    `${HEADER}\n\nTask: 修复：多语言 😀 支持\nTask ID: 任务-1\nStatus: 进行中\n`
      + 'Summary: 包含 CJK 与 emoji 🎉 的摘要\nAreas: 前端, 后端\n\n'
      + 'Conversation history (chronological; earlier content may be omitted):\n'
      + '- User：第一行\n  第二行 😀\n'
      + '- Assistant：回复：已完成 ✅',
  );
  assert.equal(out.manifest.task.summaryHash, 'sha256:984ba705c3eeb35397864cce1a99c0a4fd1a9d6fcdb4cfc712b732d86388b534');
  assert.equal(out.hash, 'sha256:d0d0e170a0fd15514e5e7c1d2d5616678f5e82d47a6f778215404e870153b4e2');
});

test('truncates the summary and areas to the remaining budget', () => {
  const out = buildTaskRunContext({
    task: {
      id: 'tsk-sum',
      title: 'S',
      summary: 'summary-'.repeat(400),
      areas: Array.from({ length: 30 }, (_, i) => `area-${i}`),
    },
    messages: [],
    includeCurrent: false,
    maxChars: 1200,
  });
  assert.equal(
    out.text,
    `${HEADER}\n\nTask: S\nTask ID: tsk-sum\nSummary: ${'summary-'.repeat(42)}sum…\n`
      + 'Areas: area-0, area-1, area-10, area-11, area-12, area-13, area-14, area-15, '
      + 'area-16, area-17, area-18, area-19, area…',
  );
  assert.equal(out.manifest.maxChars, 1200);
  assert.equal(out.manifest.task.summaryHash, 'sha256:b4b7e2e5c20880aeec45887c0c51d5721066f777d4fbd28798af7221774e2e9f');
  assert.equal(out.hash, 'sha256:01b1bcb9ce30c02955165b962c67d8664d0fb6045131300287fe91566b9edf34');
});

test('rejects missing or empty required input', () => {
  assert.throws(() => buildTaskRunContext(), {
    name: 'TypeError',
    message: 'task must be an object',
  });
  assert.throws(() => buildTaskRunContext({}), {
    name: 'TypeError',
    message: 'task must be an object',
  });
  assert.throws(() => buildTaskRunContext({ task: 'x' }), TypeError);
  assert.throws(() => buildTaskRunContext({ task: [], currentText: 'x' }), {
    name: 'TypeError',
    message: 'task.id must be a non-empty string',
  });
  assert.throws(() => buildTaskRunContext({ task: { id: '' }, currentText: 'x' }), {
    name: 'TypeError',
    message: 'task.id must be a non-empty string',
  });
  assert.throws(() => buildTaskRunContext({ task: { id: 't' } }), {
    name: 'TypeError',
    message: 'currentText must be a non-empty string',
  });
  assert.throws(() => buildTaskRunContext({ task: { id: 't' }, currentText: '   ' }), {
    name: 'TypeError',
    message: 'currentText must be a non-empty string',
  });
  assert.throws(() => buildTaskRunContext(null), TypeError);
  // includeCurrent is only defaulted for undefined, so null is falsy.
  assert.equal(
    buildTaskRunContext({ task: { id: 't' }, includeCurrent: null }).text,
    `${HEADER}\n\nTask: untitled task\nTask ID: t`,
  );
  assert.equal(
    buildTaskRunContext({ task: { id: 0 }, currentText: 'x' }).text,
    `${HEADER}\n\nTask: untitled task\nTask ID: 0\n\nCurrent request:\nx`,
  );
});

test('is deterministic and emits sha256 digests', () => {
  const args = {
    task: { id: 'tsk-det', title: 'Det', summary: 'sum' },
    messages: [{ id: 'm', role: 'user', ts: 1, text: 'text' }],
    currentText: 'go',
  };
  const first = buildTaskRunContext(args);
  const second = buildTaskRunContext(args);
  assert.deepStrictEqual(first, second);
  assert.match(first.hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.manifest.task.summaryHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.manifest.history.refs[0].ts, 1);
});
