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
const { getNative } = require('../native/binding');
const DEFAULT_MAX_AUTO_LINES = 24;

function similar(candidate, line) {
  return getNative().similarTaskMemory(String(candidate || '').trim(), String(line || '').trim());
}
function cleanMemoryCandidate(value) {
  return getNative().cleanTaskMemory(String(value == null ? '' : value));
}
function mergeAutoSection(content, candidate, { maxAutoLines = DEFAULT_MAX_AUTO_LINES } = {}) {
  return getNative().mergeTaskMemory(String(content || '').trim(), `- ${candidate}`,
    () => String(candidate || ''), () => +(-maxAutoLines));
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
