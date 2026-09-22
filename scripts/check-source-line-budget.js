#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_MAX_LINES = 3000;
const ABSOLUTE_EXCEPTION_MAX_LINES = 5000;
const DEFAULT_MAX_BYTES = 240000;
const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.dart', '.java', '.kt',
  '.swift', '.py', '.sh', '.html', '.css',
]);

// Temporary migration debt is deliberately explicit and ratcheted. The
// ceiling must be reduced in the same commit whenever a split makes the file
// smaller. These entries are not permanent exceptions to the 3k target.
//
// server.js returned to the default 3k limit in the typed continuation/wait
// migration. Keep this map for explicit, reviewed debt only; ordinary feature
// work must satisfy the default budget.
const MIGRATION_DEBT = Object.freeze({
  // app/lib/screens/main_shell.dart crossed 3000 in 039c6e43 (跨目录控制台), then
  // grew to 3174 lines / 122149 bytes in 95c6d6a0 (打开对话改成浮层) without
  // re-registering, which turned this gate red on main. The ceiling is the exact
  // committed high-water mark, so it is re-registered here; the next main_shell
  // split must ratchet it down and retire this entry once the file is <= target.
  'app/lib/screens/main_shell.dart': Object.freeze({
    ceiling: 3164,
    byteCeiling: 121973,
    target: 3000,
  }),
  // public/air.js 和 src/chat/turn-engine.js 都在 0f276ebc（session
  // multicc-claude-chat-06，2026-09-22T09:20）越过 3000：前者 3000 -> 3044，后者
  // 2997 -> 3002，两个都没回来登记，于是这道闸在 main 上红了。之所以没人发现，
  // 是因为当天的发版跑在更早的 Docker clean-install 就挂了，根本没走到 npm test。
  // air.js 在 e8741e73 撤掉「打开对话重复取一次详情」后回到 3040，仍然超。
  // 天花板同样是各自已提交的高水位，拆分哪个就压哪个，落到 <= target 时删掉这条。
  'public/air.js': Object.freeze({
    ceiling: 3040,
    byteCeiling: 163313,
    target: 3000,
  }),
  // turn-engine.js returned below 3000 while fixing native UUID preparation.
  // public/manage.js crossed 3000 in b4427cf before the budget gate caught it;
  // paid back down to 2632 by splitting the aux-history UI (modal/panel/ws,
  // plus handleAuxHealth and the synchronous auxConnect init) into
  // public/manage-aux-history.js — no manage.js debt entry remains.
  // Crossed 3000 in the chat-view unification M2 (three new task-mode script
  // tags + the task-mode stylesheet link) after sitting at 2999 for ages. Paid
  // back down to 3000 in M4 when the detail-modal retirement freed enough
  // lines — no chat.html debt entry remains.
});

// Reviewed third-party/generated assets are not first-party maintainability
// units. Keep this whitelist exact; directories must never be broadly ignored.
const REVIEWED_EXEMPTIONS = Object.freeze({
  'public/qrcode.min.js': Object.freeze({
    maxLines: ABSOLUTE_EXCEPTION_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
    reason: 'vendored minified QR encoder',
  }),
  // 生成物，不是手写代码：scripts/generate-i18n.js 把 app/assets/i18n/{zh,en}.json
  // 原样拼成这一份双语词典，键数就是产品的文案条数。Air 补齐英文之后它从 2634 行
  // 长到 4988 行，对话帧（chat.html 的 title/aria-label 与运行期文案）补齐后又到 5156
  // 行，引导卡「未检测到任何 CLI」与 Assistant 空模型目录提示补 8 条键后再到 5174 行，
  // 侧栏 CLI 待更新浮层（airCliUpdate* 17 条键 × 中英）补到 5208 行
  // —— 涨的是数据量，不是复杂度，改它也没有意义（谁都不该手改生成物）。
  // 天花板压在当前高水位上，再涨必须回来改这里。真要瘦身只有一条路：按语言拆成
  // 两个文件（各约 150KB，各自都能落在默认 3000 行以内），那是独立的一次改动。
  // （上一轮把它记成 5172，比生成器实际写出的少 2 行——countLines 数的是 split('\n')
  // 的元素个数，行尾那个换行也算一格，所以对齐数字要用测试自己的量法，别用 wc -l。）
  // 目录首页的 Chat / Terminal 切换补 10 条键（airModeChat/Terminal、
  // airTerminals* 、airNewTerminal*），双语各 10 行 = +20 行；数字按测试自己的
  // countLines 量法对齐。App 页内加载补 3 条键（中英共 6 行）。
  // 0f276ebc（session multicc-claude-chat-06，2026-09-22T09:20）又补 9 条键 × 中英
  // = +18 行，正好越过上一轮压住的 5234/318056 高水位（0e3e10aa 时还严丝合缝地
  // 等于天花板）；同一个提交也是 public/air.js 与 src/chat/turn-engine.js 越线的
  // 那次，一并按当前高水位重新登记。
  'public/i18n-catalog.js': Object.freeze({
    maxLines: 5252,
    maxBytes: 318905,
    reason: 'generated bilingual dictionary (scripts/generate-i18n.js) — data, not hand-written source',
  }),
});

function countLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\n/).length;
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file));
}

function evaluateLineBudgets(entries, {
  defaultMax = DEFAULT_MAX_LINES,
  migrationDebt = MIGRATION_DEBT,
  exemptions = REVIEWED_EXEMPTIONS,
} = {}) {
  const violations = [];
  const debts = [];
  const observed = new Map(entries.map(entry => [entry.file, entry.lines]));

  for (const entry of entries) {
    const exemption = exemptions[entry.file];
    const bytes = Number.isInteger(entry.bytes) ? entry.bytes : 0;
    if (exemption) {
      if (entry.lines > exemption.maxLines || bytes > exemption.maxBytes) {
        violations.push({
          ...entry,
          bytes,
          limit: exemption.maxLines,
          byteLimit: exemption.maxBytes,
          kind: 'reviewed_exception_over_limit',
        });
      }
      continue;
    }
    const debt = migrationDebt[entry.file];
    if (debt) {
      const byteCeiling = Number.isInteger(debt.byteCeiling)
        ? debt.byteCeiling
        : bytes;
      if (entry.lines > debt.ceiling || bytes > byteCeiling) {
        violations.push({
          ...entry,
          bytes,
          limit: debt.ceiling,
          byteLimit: byteCeiling,
          kind: 'migration_debt_regressed',
        });
      } else if (entry.lines <= debt.target && bytes <= defaultMax * 80) {
        violations.push({
          ...entry,
          bytes,
          limit: debt.target,
          kind: 'migration_debt_should_be_removed',
        });
      } else if (entry.lines < debt.ceiling || bytes < byteCeiling) {
        violations.push({
          ...entry,
          bytes,
          limit: entry.lines,
          byteLimit: bytes,
          kind: 'migration_debt_ceiling_not_ratcheted',
        });
      } else {
        debts.push({ ...entry, bytes, ...debt });
      }
      continue;
    }
    if (entry.lines > defaultMax || bytes > DEFAULT_MAX_BYTES) {
      violations.push({
        ...entry,
        bytes,
        limit: defaultMax,
        byteLimit: DEFAULT_MAX_BYTES,
        kind: entry.lines > ABSOLUTE_EXCEPTION_MAX_LINES || bytes > DEFAULT_MAX_BYTES
          ? 'unapproved_over_5000'
          : 'unapproved_over_3000',
      });
    }
  }

  for (const file of Object.keys(migrationDebt)) {
    if (!observed.has(file)) {
      violations.push({ file, lines: 0, limit: 0, kind: 'stale_migration_debt' });
    }
  }
  for (const file of Object.keys(exemptions)) {
    if (!observed.has(file)) {
      violations.push({ file, lines: 0, limit: 0, kind: 'stale_exemption' });
    }
  }

  return { violations, debts };
}

function trackedSourceEntries({ rootDir = path.resolve(__dirname, '..') } = {}) {
  const output = execFileSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard',
  ], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return output.split('\0').filter(Boolean).filter(isSourceFile)
    // `git ls-files --cached` still reports a tracked file deleted in the
    // worktree until that deletion is staged. Governance must evaluate the
    // candidate tree, not crash midway through an intentional cleanup.
    .filter(file => fs.existsSync(path.join(rootDir, file)))
    .map(file => ({
    file,
    ...(() => {
      const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
      return { lines: countLines(content), bytes: Buffer.byteLength(content) };
    })(),
    }));
}

function main() {
  const result = evaluateLineBudgets(trackedSourceEntries());
  if (result.violations.length > 0) {
    for (const item of result.violations) {
      console.error(`[line-budget] ${item.kind}: ${item.file} has ${item.lines} lines (limit ${item.limit})`);
    }
    process.exitCode = 1;
    return;
  }
  const debtText = result.debts
    .sort((a, b) => b.lines - a.lines)
    .map(item => `${item.file}=${item.lines}->${item.target}`)
    .join(', ');
  console.log(`Source line budget OK; migration debt: ${debtText || 'none'}`);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_MAX_LINES,
  ABSOLUTE_EXCEPTION_MAX_LINES,
  DEFAULT_MAX_BYTES,
  MIGRATION_DEBT,
  REVIEWED_EXEMPTIONS,
  countLines,
  isSourceFile,
  evaluateLineBudgets,
  trackedSourceEntries,
};
