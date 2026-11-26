'use strict';

// 任务级记忆的自动蒸馏写守卫（P4 输入侧）。两条写入路径汇到这里：
//   · 归因 aux 的 memory_candidate（turn 结束，与归因共用一次调用）；
//   · 交付回执（merge published 后的 evidence 钩子）。
// 写入只碰 MEMORY.md 里的「自动蒸馏」小节——手工维护的内容一个字节都不动。
// 守卫规则：
//   去重 → 新条目与已有条目相似（包含关系或 bigram Jaccard ≥ 0.6）时原位替换，
//          否则追加到小节末尾；
//   容量 → 小节超过 maxAutoLines（默认 24）条时丢最旧的自动条目；
//   门槛 → 只有任务层收自动内容。machine/global 层不收（提升必须人工）。
// 任何一步失败都返回 false：蒸馏是增强，绝不阻塞归因或交付。

const AUTO_SECTION = '## 自动蒸馏';
const MAX_CANDIDATE_CHARS = 240;
const DEFAULT_MAX_AUTO_LINES = 24;

// bigram 集合：短中文句子用字符二元组足够稳定。
function bigrams(text) {
  const value = String(text || '');
  const set = new Set();
  for (let i = 0; i < value.length - 1; i++) set.add(value.slice(i, i + 2));
  return set;
}
function jaccard(a, b) {
  const setA = bigrams(a), setB = bigrams(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared++;
  return shared / (setA.size + setB.size - shared);
}
function similar(candidate, line) {
  const a = String(candidate || '').trim();
  const b = String(line || '').trim();
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  return jaccard(a, b) >= 0.6;
}

/** 清洗 aux 给出的 memory_candidate：压空白、限长、剔除占位词。 */
function cleanMemoryCandidate(value) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    // 全角标点后的空格是压换行带进来的，中文里读着是噪音。
    .replace(/([：，。；、）】》])\s+/g, '$1')
    .replace(/\s+([（【《])/g, '$1')
    .replace(/^[-·•*\s]+/, '')
    .trim();
  if (!text || /^(null|none|无|null。?)$/i.test(text)) return null;
  if (text.length < 8) return null; // 「记住这个」级别的碎片不进记忆
  return text.length > MAX_CANDIDATE_CHARS ? `${text.slice(0, MAX_CANDIDATE_CHARS - 1)}…` : text;
}

/** 把一条候选合并进现有文件内容：纯函数，供单测与写入层共用。 */
function mergeAutoSection(content, candidate, { maxAutoLines = DEFAULT_MAX_AUTO_LINES } = {}) {
  const text = String(content || '').trim();
  const line = `- ${candidate}`;
  const build = (head, autoLines) => {
    const body = ['# 任务记忆', '', AUTO_SECTION, ...autoLines].join('\n');
    return head ? `${head}\n\n${body}\n` : `${body}\n`;
  };
  if (!text) return { content: build([], [line]), replaced: false };

  const lines = text.split('\n');
  const marker = lines.findIndex(value => value.trim() === AUTO_SECTION);
  if (marker === -1) {
    // 没有小节：追加在文件末尾，不重排已有内容。
    const autoLines = [line];
    return { content: `${text.replace(/\s*$/, '')}\n\n${AUTO_SECTION}\n${autoLines.join('\n')}\n`, replaced: false };
  }
  const head = lines.slice(0, marker);            // 小节标题之前的内容原样保留
  const tail = [];                                 // 小节之后的手工内容也原样保留
  const auto = [];
  let inTail = false;
  for (const value of lines.slice(marker + 1)) {
    if (/^#{1,6}\s/.test(value.trim()) && value.trim() !== AUTO_SECTION) inTail = true;
    (inTail ? tail : auto).push(value);
  }
  while (auto.length && !auto.at(-1).trim()) auto.pop();
  const index = auto.findIndex(value => value.trim().startsWith('- ') && similar(candidate, value.trim().slice(2)));
  let replaced = false;
  if (index === -1) auto.push(line);
  else { auto[index] = line; replaced = true; }   // 去重 → 原位替换
  const trimmed = auto.slice(-maxAutoLines);      // 容量 → 丢最旧
  const body = `${AUTO_SECTION}\n${trimmed.join('\n')}`;
  const keptHead = head.length ? `${head.join('\n').replace(/\s*$/, '')}\n\n` : '';
  const keptTail = tail.length ? `\n${tail.join('\n').replace(/^\s*/, '')}` : '';
  return { content: `${keptHead}${body}${keptTail}\n`, replaced };
}

/**
 * deps: { fs, path, taskDir(dirId, taskId), listFiles(dir), logger?, maxAutoLines? }
 * 返回 record({ dirId, taskId, text, tag }) → 是否落盘。
 */
function createTaskMemoryDistiller(deps) {
  const fs = deps.fs || require('node:fs');
  const path = deps.path || require('node:path');
  const logger = deps.logger || console;
  const maxAutoLines = Number.isInteger(deps.maxAutoLines) && deps.maxAutoLines > 0
    ? deps.maxAutoLines : DEFAULT_MAX_AUTO_LINES;
  function record({ dirId, taskId, text, tag = 'aux' }) {
    const candidate = cleanMemoryCandidate(text);
    if (!candidate || !dirId || !taskId) return false;
    try {
      const dir = deps.taskDir(dirId, taskId);
      if (!dir) return false;
      const file = path.join(dir, 'MEMORY.md');
      const existing = (deps.listFiles(dir).find(entry => entry.name === 'MEMORY.md') || {}).content || '';
      const merged = mergeAutoSection(existing, `[${tag}] ${candidate}`, { maxAutoLines });
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, merged.content, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      logger.warn?.('task_memory_distill_failed', { dirId, taskId, error: error?.message || String(error) });
      return false;
    }
  }
  return { record };
}

module.exports = {
  AUTO_SECTION,
  DEFAULT_MAX_AUTO_LINES,
  cleanMemoryCandidate,
  mergeAutoSection,
  similar,
  createTaskMemoryDistiller,
};
