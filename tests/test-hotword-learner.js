'use strict';
// Learned hotwords: mining rules (src/voice/hotword-miner.js) and the
// persisted learner (src/voice/hotword-learner.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const miner = require('../src/voice/hotword-miner');
const { createHotwordLearner } = require('../src/voice/hotword-learner');
const { correctWithHotwords } = require('../src/voice/hotword-corrector');

const quiet = { log() {}, error() {} };
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-hotwords-'));
}

test('a misheard word becomes a term=alias pair, widened to a whole word', () => {
  assert.deepEqual(miner.minePairs('然后从里面去找热水。', '然后从里面去找热词'), [{ term: '热词', alias: '热水' }]);
  assert.deepEqual(miner.minePairs('可以像OpenCloud一样对话', '可以像OpenClaw一样对话'), [{ term: 'OpenClaw', alias: 'OpenCloud' }]);
});

test('a case or spacing fix teaches the term alone', () => {
  assert.deepEqual(miner.minePairs('你们的s t t和', '你们的STT和'), [{ term: 'STT' }]);
});

test('content edits are not mistaken for mishearing', () => {
  // Different sound, different length: the user changed what they meant.
  assert.deepEqual(miner.minePairs('帮我找相关的事例吧', '帮我找类似项目吧'), []);
  // Punctuation-only and identical texts teach nothing.
  assert.deepEqual(miner.minePairs('好的，继续。', '好的 继续'), []);
  assert.deepEqual(miner.minePairs('一样', '一样'), []);
});

test('in a heavy rewrite only fixes that land on an ASCII term survive', () => {
  const pairs = miner.minePairs('野外不是谁你们的s t t和', '所以webcc的STT和typeless里面的stt有什么区别？');
  assert.ok(pairs.every(p => /[A-Za-z]/.test(p.term)), JSON.stringify(pairs));
  assert.ok(pairs.some(p => p.term === 'STT'));
});

test('typed vocabulary keeps distinctive identifiers and ignores prose, paths and code', () => {
  const terms = miner.mineTypedTerms([
    { session: 'a', text: '用 MultiCC 跑一下 CC-Switch，再看 pm2 和 the session' },
    { session: 'b', text: 'MultiCC 的 `FooBar` 和 /usr/LocalThing 以及 MULTICC_BASE_URL，CC-Switch 配 pm2' },
  ]);
  assert.equal(terms.get('multicc').count, 2);
  assert.equal(terms.get('multicc').sessions.size, 2);
  assert.ok(terms.has('cc-switch') && terms.has('pm2'));
  for (const k of ['the', 'session', 'foobar', 'localthing', 'multicc_base_url']) assert.ok(!terms.has(k), k);
  assert.ok(!miner.distinctive('API') && !miner.distinctive('hello') && miner.distinctive('GapaSea'));
  assert.ok(!miner.distinctive('CLAUDE') && !miner.distinctive('r722lph51psgw7'));
});

test('typed vocabulary keeps the user\'s usual spelling once a name-like one proved it', () => {
  const msgs = [
    'multicc 起来了', 'multicc 又挂了', '看下 multicc 日志', 'MultiCC 发版', 'MultiCC 的 README',
    'claude 回复了', 'claude 又慢了', 'CLAUDE 不行', 'CLAUDE CLAUDE',
    'task 列表', 'task 状态', 'TASK 清单', 'TASK 不对', 'STT 和 STT', 'stt 换一下',
    '路径是/var/folders/r7/nstf85rm0000gp/T 下面',
  ].map((text, i) => ({ session: `s${i % 3}`, text }));
  const terms = miner.mineTypedTerms(msgs);
  assert.equal(terms.get('multicc').term, 'multicc');
  assert.ok(!terms.has('claude'), 'shouting is not evidence');
  assert.ok(!terms.has('task'), 'an acronym spelling counts only when it is the usual one');
  assert.equal(terms.get('stt').term, 'STT');
  assert.ok(!terms.has('nstf85rm0000gp') && !terms.has('var'));
});

test('a pair activates on the second sighting and is vetoed when the user writes the alias', () => {
  const pairs = { [miner.pairKey('热词', '热水')]: { term: '热词', alias: '热水', count: 1 } };
  let built = miner.buildHotwords({ pairs });
  assert.equal(built.list, '');
  assert.equal(built.pending.length, 1);

  pairs[miner.pairKey('热词', '热水')].count = 2;
  built = miner.buildHotwords({ pairs });
  assert.equal(built.list, '热词=热水');

  built = miner.buildHotwords({ pairs }, ['今天喝了一杯热水']);
  assert.equal(built.list, '');
  assert.equal(built.vetoed.length, 1);
  // ASCII aliases are vetoed as whole words only.
  assert.equal(miner.vetoedBy('OpenCloud', ['OpenClouds are not it']), false);
  assert.equal(miner.vetoedBy('Cloud Code', ['用微信控制 Cloud Code']), true);
});

test('learner seeds from saved corrections once, then learns new ones and persists', () => {
  const dir = tmpDir();
  const examplesFile = path.join(dir, 'voice_examples.json');
  const file = path.join(dir, 'voice_hotwords.json');
  fs.writeFileSync(examplesFile, JSON.stringify([
    { raw: '去找热水。', userFinal: '去找热词', ts: '2026-10-18T00:00:00Z' },
    { raw: '你们的s t t和', userFinal: '你们的STT和', ts: '2026-10-18T00:01:00Z' },
  ]));
  const learner = createHotwordLearner({ file, examplesFile, log: quiet });
  learner.seedFromExamples();
  learner.seedFromExamples();
  assert.equal(learner.list(), 'STT');
  assert.deepEqual(learner.snapshot().pending, [{ term: '热词', alias: '热水', count: 1 }]);

  // The same example arriving again through feedback is not double-counted.
  learner.learnFromExample({ raw: '去找热水。', userFinal: '去找热词', ts: '2026-10-18T00:00:00Z' });
  assert.equal(learner.snapshot().pending.length, 1);
  learner.learnFromExample({ raw: '这个热水表', userFinal: '这个热词表', ts: '2026-10-18T01:00:00Z' });
  assert.equal(learner.list(), '热词=热水, STT');

  // A fresh process reads the same state back.
  const again = createHotwordLearner({ file, examplesFile, log: quiet });
  assert.equal(again.list(), '热词=热水, STT');
  assert.equal(correctWithHotwords('去找热水', again.list()), '去找热词');

  assert.equal(again.reject({ term: '热词', alias: '热水' }), true);
  assert.equal(again.list(), 'STT');
  assert.equal(again.reject({}), false);
});

test('chat history scan reads JSONL and array files, skips templates and internal sessions', async () => {
  const dir = tmpDir();
  const history = path.join(dir, 'chat_history');
  fs.mkdirSync(history);
  const line = (role, content) => JSON.stringify({ role, content });
  fs.writeFileSync(path.join(history, 'a.json'), [
    line('user', '把 MultiCC 的 CC-Switch 打开'),
    line('assistant', 'MultiCC GapaSea GapaSea'),
    line('user', 'MultiCC 再试一次'),
  ].join('\n'));
  fs.writeFileSync(path.join(history, 'b.json'), JSON.stringify([
    { role: 'user', content: 'MultiCC 和 CC-Switch 都好了' },
    { role: 'user', content: '【后台任务完成】MultiCC MultiCC' },
  ]));
  const template = '每小时刷新 TSLA 的数据并汇报 NVDA 情况';
  fs.writeFileSync(path.join(history, 'c.json'), [1, 2, 3, 4].map(() => line('user', template)).join('\n'));
  fs.writeFileSync(path.join(history, 'd.json'), line('user', 'CC-Switch 再看看 MultiCC'));
  fs.writeFileSync(path.join(history, '__aux__.json'), [1, 2, 3].map(i => line('user', `AuxOnly 第${i}次`)).join('\n'));

  const learner = createHotwordLearner({ file: path.join(dir, 'voice_hotwords.json'), chatHistoryDir: history, log: quiet });
  await learner.refresh();
  const snap = learner.snapshot();
  const typed = Object.fromEntries(snap.typed.map(t => [t.term, t.count]));
  assert.deepEqual(typed, { MultiCC: 4, 'CC-Switch': 3 });
  assert.ok(snap.scannedAt);
  assert.equal(learner.list(), 'MultiCC, CC-Switch');
});

test('model replies add terms only when they recur across many sessions', async () => {
  const dir = tmpDir();
  const history = path.join(dir, 'chat_history');
  fs.mkdirSync(history);
  const line = (role, content) => JSON.stringify({ role, content });
  const write = (name, lines) => fs.writeFileSync(path.join(history, name), lines.join('\n'));

  // A term the user never types but the model uses session after session.
  for (let i = 0; i < 6; i++) write(`a${i}.json`, [line('assistant', `AutoCommit 第${i}次提交`)]);
  // An all-caps token below the stricter bar is a ticker, not vocabulary.
  for (let i = 0; i < 9; i++) write(`b${i}.json`, [line('assistant', `GSPC 第${i}次收盘`)]);
  // One that really is part of the daily vocabulary clears the higher bar.
  for (let i = 0; i < 10; i++) write(`c${i}.json`, [line('assistant', `CDP 第${i}次连上`)]);
  // A canned reply that repeats verbatim is a template, not vocabulary.
  for (let i = 0; i < 4; i++) write(`d${i}.json`, [line('assistant', '模板回复 TemplateOnly 请稍候')]);
  // Long model output is skipped before mining.
  for (let i = 0; i < 5; i++) write(`e${i}.json`, [line('assistant', `LongOnlyTerm ${i} ` + 'x'.repeat(1500))]);

  const learner = createHotwordLearner({ file: path.join(dir, 'voice_hotwords.json'), chatHistoryDir: history, log: quiet });
  await learner.refresh();
  const byTerm = Object.fromEntries(learner.snapshot().typed.map(t => [t.term, t]));
  assert.equal(byTerm.AutoCommit.sessions, 6);
  assert.equal(byTerm.AutoCommit.source, 'assistant');
  assert.equal(byTerm.CDP.sessions, 10);
  for (const absent of ['GSPC', 'TemplateOnly', 'LongOnlyTerm']) assert.ok(!byTerm[absent], absent);
});

test('the user\'s own spelling outranks a model spelling of the same term', async () => {
  const dir = tmpDir();
  const history = path.join(dir, 'chat_history');
  fs.mkdirSync(history);
  const line = (role, content) => JSON.stringify({ role, content });
  const write = (name, lines) => fs.writeFileSync(path.join(history, name), lines.join('\n'));

  for (let i = 0; i < 3; i++) write(`u${i}.json`, [line('user', `multicc 第${i}次启动`)]);
  for (let i = 0; i < 2; i++) write(`v${i}.json`, [line('user', `MultiCC 第${i}次启动`)]);
  for (let i = 0; i < 6; i++) write(`m${i}.json`, [line('assistant', `MultiCC 第${i}次启动`)]);

  const learner = createHotwordLearner({ file: path.join(dir, 'voice_hotwords.json'), chatHistoryDir: history, log: quiet });
  await learner.refresh();
  const typed = learner.snapshot().typed.map(t => [t.term, t.count, t.sessions, t.source]);
  assert.deepEqual(typed, [['multicc', 5, 5, 'user']]);
  assert.equal(learner.list(), 'multicc');
});

test('the voice host only starts learning when the real server opts in', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/voice/host.js'), 'utf8');
  assert.match(src, /if \(autoDownloadAsrModels && voice\.autoHotwordsEnabled && voice\.autoHotwords\)/);
  const config = fs.readFileSync(path.join(__dirname, '../src/voice/config.js'), 'utf8');
  assert.doesNotMatch(config, /autoHotwords\.start\(\)/, 'requiring the config module must not start a scan');
});

test('语音纠错按冻结输入对拍 UTF-16 边界、重复片段和拼音回退', () => {
  const { compileFunction } = require('node:vm');
  const { createRequire } = require('node:module');
  const { createHash } = require('node:crypto');
  const filename = path.resolve(__dirname, '../src/voice/hotword-miner.js');
  const frozen = fs.readFileSync(path.join(__dirname,'helpers/frozen-hotword-miner.js'));
  assert.equal(createHash('sha1').update('blob '+frozen.length+'\0').update(frozen).digest('hex'),
    '27b3aba981a091dd88fc4a91c499878ef1a2f78e');
  const resolve = createRequire(filename);
  const samples = [
    [null,{}], ['',''], [new String('abc'),'ABC'], ['热水','热词'], ['开始热水了','开始热词了'],
    ['甲乙甲乙甲乙','乙甲乙甲乙甲'], ['x A x B x','x B x A x'], ['STT.','stt'],
    ['\ud800A🙂er\udc00','\ud800A🙂ER\udc00'], ['A ß S','A SS S'],['x a\u00a0b c y','x ABC y'],
    ['字'.repeat(597)+'a b','字'.repeat(597)+'AB'], ['字'.repeat(598)+'a b','字'.repeat(598)+'AB'],
    [' 跑 '.repeat(250),' 跑 '.repeat(250)+'a'], [' \ufeff ST T ',' StT \n'],
    ['现在录音用OpenCloud。','现在录音用OpenClaw。'], ['前一段hot\u2028word','前一段HotWord'],
    ['先输入abcabc末','先输入ABCABC末'], ['尾末热水—热水','尾末热词—热词'],
  ];
  const words = ['回','词','水','甲','Alpha','STT','S','t','PM2','CC-Switch','_', '.', '/', ';','，','🙂','\ud800','\ufeff','\t',' ','+'];
  let seed=37;
  const pick = n => { seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n; };
  for(let i=0;i<320;i++) {
    const a=Array.from({length:4+pick(28)},()=>words[pick(words.length)]), b=a.slice();
    b.splice(pick(b.length),1+pick(3),words[pick(words.length)],words[pick(words.length)]);
    samples.push([a.join(''),b.join('')]);
  }
  function exercise(body, mode) {
    const events=[], unsupported=Error('dictionary'), box={exports:{}};
    const corrector = {
      toSyllables(s) {
        events.push(s);
        if (mode==='throw') throw unsupported;
        return mode==='absent' ? null : [...s].map(c=>c==='水'?'x':c==='词'?'y':c);
      },
      nearSyllable(a,b){ events.push([a,b]); return a===b; },
    };
    compileFunction(body.toString(),['module','require'],{filename})(box,id=>id==='./hotword-corrector'?corrector:resolve(id));
    return { results:samples.map(([a,b])=>{
      try { return box.exports.minePairs(a,b); }
      catch(e){ assert.equal(e,unsupported);return 'dictionary failed'; }
    }),events };
  }
  const current=fs.readFileSync(filename);
  for(const mode of ['absent','present','throw']) assert.deepEqual(exercise(current,mode),exercise(frozen,mode),mode);
});

test('输入词汇统计与冻结版本保持出现次数、拼写顺序及会话集合身份', () => {
  const { compileFunction } = require('node:vm'), { createRequire } = require('node:module');
  const { createHash } = require('node:crypto');
  const filename = path.resolve(__dirname, '../src/voice/hotword-miner.js');
  const bytes = fs.readFileSync(path.join(__dirname,'helpers/frozen-hotword-typed-terms.js'));
  assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'), 'b7e9a263ea334c3426e29b773262f9f308099d5b');
  const original = {exports:{}};
  compileFunction(bytes.toString(), ['module','require'], {filename})(original,createRequire(filename));
  const opaque = Object.freeze({toJSON(){throw Error('session must stay opaque');}});
  const id = Symbol('session'), stop = Error('message');
  function run(api) {
    const log=[];
    const messages = [
      [opaque,'MultiCC MultiCC cc-Switch CC-Switch STT'],
      [opaque,'multicc multicc CC-switch cc-switch STT'],
      [id,'STT STT FooBar FooBar fooBar FOO1 foo1 API CLI HELLO'],
      [NaN,'MultiCC CLI CLI CLI'],[NaN,'MultiCC'],
      [null,'`FooBar` https://FooBar/x /FooBar/x $UPPER FooBar'],
      ['x','```\nAbcDef AbcDef\n``` A-B-A A-B-A'],
      [-0,'\ud800FooBar\udc00MultiCC\u00a0pm2 \ufeffpm2'],
      [id,{toString(){log.push('toString');return 'FooBar';}}],
    ];
    const iterable = { *[Symbol.iterator]() {
      try { for (const [session,text] of messages) yield {
        get session(){log.push('session');return session;},get text(){log.push('text');return text;},
      }; } finally {log.push('close');}
    }};
    const map=api.mineTypedTerms(iterable);
    assert.ok(map instanceof Map);
    assert.equal([...map.get('multicc').sessions][0],opaque);
    assert.ok(map.get('stt').sessions.has(id));assert.ok(map.get('multicc').sessions.has(NaN));
    for(const entry of map.values()){assert.ok(entry.forms instanceof Map);assert.ok(entry.sessions instanceof Set);}
    assert.throws(()=>api.mineTypedTerms({ *[Symbol.iterator](){ try {yield {text:{toString(){throw stop;}}};} finally {log.push('failed-close');} }}),e=>e===stop);
    return [log,[...map].map(([k,e])=>[k,Object.keys(e),e.term,e.count,[...e.sessions],[...e.forms]])];
  }
  assert.deepEqual(run(miner),run(original.exports));
});
