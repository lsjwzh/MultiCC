'use strict';

// CLI over the message search index: build it, inspect it, query it.
//
//   node scripts/search-index.js stats
//   node scripts/search-index.js build [--force] --dir <dataDir>
//   node scripts/search-index.js sync <sessionId> [--force] --dir <dataDir>
//   node scripts/search-index.js query "<text>" [--limit 10] [--role user] [--session <id>] [--json]
//
// It exists because the index is derived data with a real corpus behind it: the
// only way to know a change to the tokenizer or the chunking actually helps is to
// build against real chat_history and look at what comes back.
//
// Reads (stats/query) work on the database alone, so `--db <file>` is enough. Writes
// need `--dir <dataDir>` pointing at the directory that holds `chat_history/` — on
// this machine that is the repo root, not the worktree — and the CLI refuses to run
// them against a data directory that has no `chat_history/`, because a wrong --dir
// would index nothing and report it as a clean run.
//
// Defaults come from resolveDataDir() (MULTICC_DATA_DIR or the cwd), and nothing is
// ever written outside `--db`.

const fs = require('node:fs');
const path = require('node:path');
const { resolveDataDir, createPaths } = require('../src/paths');
const { createSearchIndex } = require('../src/search/index-store');
const { createMessageCorpus, MESSAGE_SCOPE } = require('../src/search/message-corpus');
const { createChatHistoryFileRepository } = require('../src/session/adapters/chat-history-file-repository');

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split('=');
    if (inline !== undefined) { flags.set(name, inline); continue; }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { flags.set(name, next); index += 1; } else flags.set(name, true);
  }
  return { positional, flags };
}

function humanBytes(bytes) {
  if (!bytes) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(2)}MB`;
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] || 'stats';
  const dataDir = flags.get('dir') && flags.get('dir') !== true ? String(flags.get('dir')) : resolveDataDir();
  const paths = createPaths({ dataDir });
  const dbFile = flags.get('db') && flags.get('db') !== true
    ? path.resolve(String(flags.get('db')))
    : paths.searchIndexDbFile;

  // Refuse a build or sync against a data directory with no chat-history root instead
  // of reporting a clean run: a wrong --dir silently indexes nothing (or, before the
  // sweep guard, empties an index it never looked at), and the fix is always to name
  // the directory that actually holds the history. Reading commands are exempt.
  if (command === 'build' || command === 'sync') {
    if (!fs.existsSync(paths.chatHistoryDir)) {
      console.error(`数据目录里没有 chat-history：${paths.chatHistoryDir}`);
      console.error('用 --dir <数据目录> 指向真正存放历史的地方（真实语料通常是主仓根目录）。');
      return 2;
    }
  }

  // Only warnings are forwarded: `log` would echo the same sync summary this CLI
  // already prints in human form, while a skipped prune is something the operator
  // must see (it means the run found no sources and deliberately kept the index).
  const logger = { warn: (...args) => console.warn(...args) };
  const index = createSearchIndex({ dbFile, logger });
  if (!index.available) {
    console.error(`搜索索引不可用：${index.reason}`);
    console.error('（FTS5 缺失时检索会退回任务板的内存 BM25，消息索引不启用。）');
    return 1;
  }
  const history = createChatHistoryFileRepository({ dataDir });
  const corpus = createMessageCorpus({ index, history, logger });

  try {
    if (command === 'stats') {
      const stats = index.stats();
      console.log(`库文件   ${stats.dbFile}`);
      console.log(`体积     ${humanBytes(stats.bytes)}  (page ${stats.pageSize}B)`);
      console.log(`分词口径 ${stats.tokenizer}`);
      if (!stats.scopes.length) console.log('（还没有任何语料，先跑 build）');
      for (const scope of stats.scopes) {
        console.log(`域 ${scope.scope}: ${scope.chunks} 块 / ${scope.refs} 个来源 / 原文 ${humanBytes(scope.bytes)}`);
      }
      if (stats.emptyRefs) console.log(`无内容来源 ${stats.emptyRefs} 个（已记住 mtime，不再重复解析）`);
      return 0;
    }

    if (command === 'build') {
      const summary = corpus.syncAll({ force: flags.get('force') === true });
      console.log(`同步 ${summary.sessions} 个会话：写入 ${summary.synced}、跳过 ${summary.skipped}、` +
        `新增块 ${summary.chunks}、清理来源 ${summary.removedRefs}、耗时 ${summary.tookMs}ms`);
      if (summary.pruneSkipped) {
        console.log(`（本次一个来源都没发现，已保留索引里的 ${summary.pruneSkipped} 个来源；` +
          `确认数据目录没错且真要清空，再加 --force。）`);
      }
      const stats = index.stats();
      for (const scope of stats.scopes) console.log(`域 ${scope.scope}: ${scope.chunks} 块 / 原文 ${humanBytes(scope.bytes)} / 库 ${humanBytes(stats.bytes)}`);
      return 0;
    }

    if (command === 'sync') {
      const sessionId = positional[1];
      if (!sessionId) { console.error('sync 需要 sessionId'); return 2; }
      const result = corpus.syncSession(sessionId, { force: flags.get('force') === true });
      console.log(JSON.stringify(result));
      return 0;
    }

    if (command === 'query') {
      const text = positional.slice(1).join(' ').trim();
      if (!text) { console.error('query 需要检索词'); return 2; }
      const role = flags.get('role');
      const session = flags.get('session');
      const result = index.search({
        text,
        scope: MESSAGE_SCOPE,
        limit: Number(flags.get('limit')) || 10,
        kinds: role && role !== true ? [String(role)] : undefined,
        refIds: session && session !== true ? [String(session)] : undefined,
      });
      if (flags.get('json') === true) { console.log(JSON.stringify(result, null, 2)); return 0; }
      console.log(`模式 ${result.mode} / 词 ${result.terms.length} 个 / ${result.results.length} 条`);
      for (const hit of result.results) {
        const when = hit.updatedAt ? new Date(hit.updatedAt).toISOString().slice(0, 19).replace('T', ' ') : '-';
        console.log(`\n[${hit.score}] ${hit.refId} · ${hit.kind || '-'} · ${when}`);
        console.log(`  ${hit.snippet.text.replace(/\n/g, ' ').slice(0, 160)}`);
      }
      return 0;
    }

    console.error(`未知命令：${command}`);
    console.error('可用：stats | build | sync <sessionId> | query "<text>"');
    return 2;
  } finally {
    index.close();
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs };
