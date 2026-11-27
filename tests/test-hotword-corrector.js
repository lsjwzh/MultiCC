#!/usr/bin/env node
// Pinyin hotword post-correction (src/voice/hotword-corrector.js).
const assert = require('assert');

const hot = require('../src/native/binding').voiceCorrector;

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}\n  ${e.message}`); }
}
const fix = (text, list) => hot.correctWithHotwords(text, list);

test('parseHotwords splits on commas/newlines/、, dedupes, reads aliases', () => {
  const e = hot.parseHotwords('React, Claude=克劳德/克拉德\n哈勃、react,  ');
  assert.deepStrictEqual(e.map(x => x.term), ['React', 'Claude', '哈勃']);
  assert.deepStrictEqual(e[1].aliases, ['克劳德', '克拉德']);
});

test('stripAliases leaves only the terms for a cloud prompt', () => {
  assert.strictEqual(hot.stripAliases('React, Claude=克劳德/克拉德, 哈勃'), 'React, Claude, 哈勃');
});

test('homophone of a two-character term is replaced', () => {
  assert.strictEqual(fix('这个权线需要再确认一下', '权限'), '这个权限需要再确认一下');
});

test('two-character terms accept homophones only, never near-sounds', () => {
  assert.strictEqual(fix('打开设值', '设置'), '打开设置');
  assert.strictEqual(fix('打开设自', '设置'), '打开设自'); // zi vs zhi: near, not equal
});

test('longer terms tolerate one near syllable, not two', () => {
  assert.strictEqual(fix('做资识图谱', '知识图谱'), '做知识图谱'); // zi/zhi
  assert.strictEqual(fix('做资私图谱', '知识图谱'), '做资私图谱'); // zi/zhi + si/shi
  assert.strictEqual(fix('打开开发者中心文挡', '开发者中心文档'), '打开开发者中心文档'); // homophone
});

test('three-character term allows exactly one near syllable', () => {
  assert.strictEqual(fix('请打开设自页', '设置页'), '请打开设置页');
  assert.strictEqual(fix('请打开色自页', '设置页'), '请打开色自页'); // se/she + zi/zhi
});

test('alias spellings are rewritten to the canonical term', () => {
  assert.strictEqual(fix('让克劳德帮我看一下', 'Claude=克劳德/克拉德'), '让Claude帮我看一下');
  assert.strictEqual(fix('克拉德写得不错', 'Claude=克劳德/克拉德'), 'Claude写得不错');
});

test('the correct spelling is left alone and shields its span from shorter terms', () => {
  assert.strictEqual(fix('哈勃望远镜', '哈勃望远镜, 哈勃'), '哈勃望远镜');
  assert.strictEqual(fix('哈勃望远镜', '哈勃, 哈勃望远镜'), '哈勃望远镜');
});

test('a polyphone is read in context, not by its first reading', () => {
  // 银行 is yin-hang here; 杭 has only that reading, so only context can match.
  assert.strictEqual(fix('去银行办事', '音杭'), '去音杭办事');
  assert.strictEqual(fix('去音杭办事', '音杭'), '去音杭办事');
});

test('matches never cross non-Chinese characters', () => {
  assert.strictEqual(fix('权, 线', '权限'), '权, 线');
  assert.strictEqual(fix('权abc线', '权限'), '权abc线');
});

test('ASCII terms ignore case and inner spaces but respect word boundaries', () => {
  assert.strictEqual(fix('open multi cc now', 'MultiCC'), 'open MultiCC now');
  assert.strictEqual(fix('use TYPESCRIPT here', 'TypeScript'), 'use TypeScript here');
  assert.strictEqual(fix('reactive', 'React'), 'reactive');
});

test('a multi-word term keeps its space and never rewrites paths or identifiers', () => {
  assert.strictEqual(fix('用claude code写', 'Claude Code'), '用Claude Code写');
  assert.strictEqual(fix('打开 /code/claudecode/webcc 目录', 'Claude Code'), '打开 /code/claudecode/webcc 目录');
  assert.strictEqual(fix('claudecode 是目录名', 'Claude Code'), 'claudecode 是目录名');
  assert.strictEqual(fix('读 MULTICC_BASE_URL 和 multicc-base', 'MultiCC'), '读 MULTICC_BASE_URL 和 multicc-base');
  assert.strictEqual(fix('看 .multicc 目录', 'MultiCC'), '看 .multicc 目录');
  assert.strictEqual(fix('spawned claude pid=4679 和 pid 都在', 'PID'), 'spawned claude pid=4679 和 PID 都在');
  assert.strictEqual(fix('这是multicc。', 'MultiCC'), '这是MultiCC。');
});

test('an ASCII alias is rewritten to the canonical spelling', () => {
  assert.strictEqual(fix('像OpenCloud一样', 'OpenClaw=OpenCloud'), '像OpenClaw一样');
  assert.strictEqual(fix('有cloud code agent', 'Claude Code=Cloud Code'), '有Claude Code agent');
});

test('empty input and empty list are no-ops', () => {
  assert.strictEqual(fix('', '权限'), '');
  assert.strictEqual(fix('权线', ''), '权线');
  assert.strictEqual(fix('权线', '   '), '权线');
  assert.strictEqual(fix(undefined, '权限'), undefined);
});

test('changing the list takes effect on the next call', () => {
  assert.strictEqual(fix('这个权线', '权限'), '这个权限');
  assert.strictEqual(fix('这个权线', '哈勃'), '这个权线');
});

test('size and entry caps hold', () => {
  const many = Array.from({ length: 500 }, (_, i) => `词${i}`).join(',');
  assert.ok(hot.parseHotwords(many).length <= 200);
  assert.strictEqual(hot.parseHotwords('x'.repeat(41)).length, 0);
});

test('missing pinyin-pro degrades to ASCII-only correction without throwing', () => {
  const native = require('../src/native/binding').getNative();
  const bare = native.voiceCorrectorApi({
    loadPinyin() { throw new Error("Cannot find module 'pinyin-pro'"); },
    windows: native.HotwordWindows,
  });
  assert.strictEqual(bare.correctWithHotwords('这个权线 multi cc', '权限, MultiCC'), '这个权线 MultiCC');
});

test('nearSyllable covers accent pairs and rejects unrelated sounds', () => {
  assert.ok(hot.nearSyllable('zhi', 'zi'));
  assert.ok(hot.nearSyllable('xin', 'xing'));
  assert.ok(hot.nearSyllable('nan', 'lan'));
  assert.ok(hot.nearSyllable('yan', 'yang'));
  assert.ok(!hot.nearSyllable('ba', 'pa'));
  assert.ok(!hot.nearSyllable('ma', 'mo'));
});

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');

require('node:test')('67f54869 differential: voice/hotword-corrector', async () => {
  const { compare } = require('./helpers/compare-leaf-hosts');
  await compare('voice/hotword-corrector.js', api => {
    const lexicon = '权限、测试权限, Claude Code=克劳德/克劳德,权限,🚀';
    return [api.parseHotwords(lexicon), api.stripAliases(lexicon),
      ...['🚀测试权线，权线', 'CLAUDE CODE /claude code', '克劳德'].map(text => api.correctWithHotwords(text, lexicon)),
      ...[['zhan','zang'], ['shi','si'], ['量','量']].map(pair => api.nearSyllable(...pair))];
  }, hot);
});
