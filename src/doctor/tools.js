'use strict';
// Tool belt for the session doctor. Everything is jailed: reads stay inside a
// few roots and never touch credential files, commands are argv-only from an
// allowlist (no shell), and writes exist only in autofix mode and only inside
// the MultiCC main checkout (where the running server lives) or the diagnosed
// session's own worktree. Nothing here can restart the server.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const OUT_MAX = 12000;
const SECRET_PATH = /(^|\/)(\.env[^/]*|secrets?[^/]*|[^/]*\.(pem|key|p12|keystore)|id_(rsa|ed25519)[^/]*|auth\.json|providers\.json|sessions\.json|\.credentials[^/]*|[^/]*token[^/]*\.json)$/i;
const SECRET_FIELD = /token|key|secret|password|credential|authorization|cookie/i;
const SECRET_TEXT = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{8,})/gi;

function redact(text) {
  return String(text).replace(SECRET_TEXT, (m, _a, prefix) => (prefix ? `${prefix}***` : '***'));
}
function clip(text, max = OUT_MAX) {
  const s = redact(text);
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}
function redactObject(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : redact(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redactObject(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELD.test(k) ? '***' : redactObject(v, depth + 1);
    return out;
  }
  return value;
}

function realOrSelf(p) { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } }
function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const GIT_READ = new Set(['status', 'diff', 'log', 'branch', 'rev-parse', 'rev-list', 'show', 'ls-files', 'remote', 'blame', 'reflog']);
const GIT_FIX = [['rebase', '--abort'], ['merge', '--abort'], ['cherry-pick', '--abort'], ['worktree', 'prune']];
const GIT_BAD_FLAG = /^(-c|-C|--git-dir|--work-tree|--exec-path|--upload-pack|--output|--ext-diff|--textconv)/;
const EXEC_SUBCMD_ONLY = { ps: 1, pgrep: 1, lsof: 1, df: 1 };

function checkCommand(argv, autofix) {
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string')) return 'argv 必须是非空字符串数组';
  const [bin, ...args] = argv;
  if (bin === 'git') {
    if (args.some(a => GIT_BAD_FLAG.test(a))) return '禁止的 git 参数';
    const sub = args[0];
    if (GIT_READ.has(sub)) return null;
    if (sub === 'worktree' && args[1] === 'list') return null;
    if (sub === 'stash' && args[1] === 'list') return null;
    if (GIT_FIX.some(p => p.every((x, i) => args[i] === x))) {
      return autofix ? null : '修复类 git 命令仅在 autofix 模式可用';
    }
    return `git ${sub || ''} 不在白名单`;
  }
  if (EXEC_SUBCMD_ONLY[bin]) return null;
  if (bin === 'node' && args[0] === '--check' && args.length === 2) return null;
  return `命令 ${bin} 不在白名单（可用：git 只读子命令、ps、pgrep、lsof、df、node --check <file>）`;
}

function run(argv, cwd, timeoutMs = 15000) {
  return new Promise(resolve => {
    execFile(argv[0], argv.slice(1), { windowsHide: true, cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function createDoctorTools(deps) {
  const {
    sessionId, getSession, loadHistory, cwdOf, repoRoot, dataDir, logDirs = [], autofix = false,
    serverPid = process.pid, backupDir, exec = run, now = Date.now, onIssueDraft = () => {},
  } = deps;
  const session = getSession(sessionId) || {};
  const cwd = cwdOf ? cwdOf(sessionId) : null;
  const worktree = session.worktreePath ? realOrSelf(session.worktreePath) : null;
  const main = realOrSelf(repoRoot);
  const readRoots = [repoRoot, cwd, worktree, dataDir, ...logDirs].filter(Boolean).map(realOrSelf);
  const actions = [];
  // Runtime data that lives beside the source in the main checkout: never edited.
  const DATA_DIRS = new Set(['.git', 'node_modules', '.multicc-worktrees', 'chat_history', 'aux_runs', 'events', 'bridges', 'artifacts', '.journal', 'logs', 'memories']);
  const whereDir = where => (where === 'session' ? (worktree || realOrSelf(cwd || repoRoot)) : main);

  function guardRead(p) {
    if (typeof p !== 'string' || !p) throw new Error('path 必填');
    const abs = realOrSelf(path.isAbsolute(p) ? p : path.join(main, p));
    if (!readRoots.some(r => within(r, abs))) throw new Error(`路径不在可读范围内：${p}`);
    if (SECRET_PATH.test(abs) || abs.split(path.sep).includes('node_modules')) throw new Error(`路径被拒绝（凭据或依赖目录）：${p}`);
    return abs;
  }
  function guardWrite(p) {
    if (!autofix) throw new Error('当前为只读诊断模式，未开启 autofix');
    if (typeof p !== 'string' || !p) throw new Error('path 必填');
    const abs = path.resolve(path.isAbsolute(p) ? p : path.join(main, p));
    const real = realOrSelf(path.dirname(abs));
    // Writable: the main checkout's source files, or the session's own worktree.
    const root = [worktree, main].filter(Boolean).find(r => within(r, abs) && within(r, real));
    if (!root) throw new Error('只允许写入 main 主仓或该会话自己的 worktree');
    const rel = path.relative(root, abs).split(path.sep);
    const sibling = root === main && rel[0] === '.multicc-worktrees' && !(worktree && within(worktree, abs));
    if (rel.some(seg => seg === '.git' || seg === 'node_modules') || sibling || (root === main && DATA_DIRS.has(rel[0])) || SECRET_PATH.test(abs)) {
      throw new Error('该路径禁止写入（运行数据、依赖、.git、其它会话的 worktree 或凭据）');
    }
    return { abs, root };
  }
  function backup(abs) {
    if (!backupDir || !fs.existsSync(abs)) return null;
    fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, `${now()}-${path.basename(abs)}`);
    fs.copyFileSync(abs, dest);
    return dest;
  }
  const note = (kind, detail) => actions.push({ kind, detail, at: now() });
  const str = (description) => ({ type: 'string', description });

  const tools = [
    {
      name: 'session_info', description: '读取会话记录（状态、cli、provider、cwd、worktree 等，凭据字段已打码）。省略 sessionId 即被诊断会话。',
      parameters: { type: 'object', properties: { sessionId: str('可选') } },
      run: args => {
        const rec = getSession(args.sessionId || sessionId);
        return rec ? redactObject(rec) : '会话不存在';
      },
    },
    {
      name: 'chat_tail', description: '读取会话聊天记录最近 N 条（默认 12，最大 40），含 error/tool 标记。',
      parameters: { type: 'object', properties: { sessionId: str('可选'), count: { type: 'integer' } } },
      run: args => {
        const n = Math.max(1, Math.min(40, Number(args.count) || 12));
        const msgs = (loadHistory(args.sessionId || sessionId) || []).slice(-n);
        return clip(msgs.map(m => `[${m.role}${m.error ? ' ERROR' : ''}${m.taskType ? ' ' + m.taskType : ''}] ${typeof m.content === 'string' ? m.content.slice(0, 1200) : JSON.stringify(m.content || '').slice(0, 1200)}`).join('\n---\n'));
      },
    },
    {
      name: 'list_dir', description: '列目录（只读，限定在仓库/会话 cwd/数据目录/日志目录）。',
      parameters: { type: 'object', properties: { path: str('目录') }, required: ['path'] },
      run: args => {
        const abs = guardRead(args.path);
        return fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200)
          .map(e => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n');
      },
    },
    {
      name: 'read_file', description: '读文本文件（带行号）。大文件用 offset/limit 分段，日志想看末尾用 tail_file。',
      parameters: { type: 'object', properties: { path: str('文件'), offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] },
      run: args => {
        const abs = guardRead(args.path);
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const off = Math.max(0, Number(args.offset) || 0);
        const lim = Math.max(1, Math.min(400, Number(args.limit) || 200));
        return clip(lines.slice(off, off + lim).map((l, i) => `${off + i + 1}\t${l}`).join('\n'));
      },
    },
    {
      name: 'tail_file', description: '读文件末尾 N 行，可选 filter 正则只保留匹配行（排查日志首选）。',
      parameters: { type: 'object', properties: { path: str('文件'), lines: { type: 'integer' }, filter: str('正则') }, required: ['path'] },
      run: args => {
        const abs = guardRead(args.path);
        const size = fs.statSync(abs).size;
        const fd = fs.openSync(abs, 'r');
        try {
          const len = Math.min(size, 512 * 1024);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, size - len);
          let lines = buf.toString('utf8').split('\n');
          if (args.filter) { const re = new RegExp(args.filter, 'i'); lines = lines.filter(l => re.test(l)); }
          return clip(lines.slice(-Math.max(1, Math.min(300, Number(args.lines) || 80))).join('\n'));
        } finally { fs.closeSync(fd); }
      },
    },
    {
      name: 'search_text', description: '在目录下按正则搜索文本（跳过 node_modules/.git，最多 60 条命中）。',
      parameters: { type: 'object', properties: { pattern: str('正则'), path: str('目录，默认会话 cwd') }, required: ['pattern'] },
      run: args => {
        const root = guardRead(args.path || cwd || repoRoot);
        const re = new RegExp(args.pattern, 'i');
        const hits = [];
        const walk = (dir, depth) => {
          if (hits.length >= 60 || depth > 8) return;
          let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
          for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            const full = path.join(dir, e.name);
            if (SECRET_PATH.test(full)) continue;
            if (e.isDirectory()) walk(full, depth + 1);
            else if (e.isFile()) {
              try {
                if (fs.statSync(full).size > 1024 * 1024) continue;
                fs.readFileSync(full, 'utf8').split('\n').forEach((l, i) => { if (hits.length < 60 && re.test(l)) hits.push(`${path.relative(root, full)}:${i + 1}: ${l.trim().slice(0, 200)}`); });
              } catch (_) { /* binary or unreadable */ }
            }
          }
        };
        walk(root, 0);
        return clip(hits.join('\n') || '无命中');
      },
    },
    {
      name: 'run_command', description: '执行白名单命令（argv 数组，无 shell）。git 只读子命令/ps/pgrep/lsof/df/node --check；autofix 下另允许 git rebase|merge|cherry-pick --abort 与 git worktree prune。where 选择工作目录：main（默认，主仓）或 session（该会话 worktree）。',
      parameters: { type: 'object', properties: { argv: { type: 'array', items: { type: 'string' } }, where: { type: 'string', enum: ['main', 'session'] } }, required: ['argv'] },
      run: async args => {
        const bad = checkCommand(args.argv, autofix);
        if (bad) throw new Error(bad);
        const r = await exec(args.argv, whereDir(args.where));
        const fixing = autofix && args.argv[0] === 'git' && GIT_FIX.some(p => p.every((x, i) => args.argv[1 + i] === x));
        if (fixing) note('command', `${args.argv.join(' ')} @${args.where === 'session' ? 'session' : 'main'}`);
        return clip(`exit=${r.code}\n${r.stdout}${r.stderr ? `\nSTDERR:\n${r.stderr}` : ''}`);
      },
    },
  ];

  if (autofix) {
    tools.push(
      {
        name: 'edit_file', description: '在 main 主仓（相对路径默认基于主仓）或该会话 worktree 内做精确字符串替换，old 必须唯一。运行数据目录、.git、依赖、其它会话的 worktree、凭据文件不可写。改动服务端代码后需用户手动重启才生效。',
        parameters: { type: 'object', properties: { path: str('文件'), old: str('原文'), new: str('新文') }, required: ['path', 'old', 'new'] },
        run: args => {
          const { abs, root } = guardWrite(args.path);
          const text = fs.readFileSync(abs, 'utf8');
          const count = text.split(args.old).length - 1;
          if (!args.old || count !== 1) throw new Error(`old 必须恰好出现 1 次，实际 ${count} 次`);
          const bak = backup(abs);
          fs.writeFileSync(abs, text.replace(args.old, () => args.new));
          note('edit_file', `${root === main ? 'main:' : 'session:'}${path.relative(root, abs)}${bak ? ` (backup ${bak})` : ''}`);
          return 'ok';
        },
      },
      {
        name: 'remove_stale_git_lock', description: '删除陈旧的 .git/index.lock（先确认没有 git 写操作在运行）。where：main（默认）或 session。',
        parameters: { type: 'object', properties: { where: { type: 'string', enum: ['main', 'session'] } } },
        run: async args => {
          const dir = whereDir(args.where);
          const gitDirRes = await exec(['git', 'rev-parse', '--git-dir'], dir);
          const gitDir = path.resolve(dir, gitDirRes.stdout.trim());
          const lock = path.join(gitDir, 'index.lock');
          if (!fs.existsSync(lock)) return '没有 index.lock';
          const ps = await exec(['pgrep', '-fl', 'git'], dir);
          if (/git (add|commit|merge|rebase|checkout|stash|worktree)/.test(ps.stdout)) throw new Error('仍有 git 进程在运行，拒绝删除锁');
          fs.unlinkSync(lock);
          note('remove_lock', lock);
          return `已删除 ${lock}`;
        },
      },
      {
        name: 'kill_process', description: '对 cwd 位于该会话 worktree 内的残留进程发 SIGTERM（不会动服务本体）。',
        parameters: { type: 'object', properties: { pid: { type: 'integer' } }, required: ['pid'] },
        run: async args => {
          const pid = Number(args.pid);
          if (!worktree || !Number.isInteger(pid) || pid <= 1 || pid === serverPid || pid === process.ppid) throw new Error('拒绝：pid 非法或指向服务本体');
          const r = await exec(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], worktree);
          const line = r.stdout.split('\n').find(l => l.startsWith('n'));
          if (!line || !within(worktree, realOrSelf(line.slice(1)))) throw new Error('该进程 cwd 不在会话 worktree 内，拒绝');
          process.kill(pid, 'SIGTERM');
          note('kill', `SIGTERM ${pid}`);
          return `已发送 SIGTERM 给 ${pid}`;
        },
      },
    );
  }

  tools.push({
    name: 'propose_issue',
    description: '穷尽手段仍无法解决时，整理一份 GitHub issue 草稿（标题 + Markdown 正文：现象、已收集的证据、已排除项、复现线索）。不会自动提交——由用户在界面上点击后才会打开 GitHub。之后仍须调用 finish。',
    parameters: { type: 'object', properties: { title: str('简短标题'), body: str('Markdown 正文，不要包含任何凭据') }, required: ['title', 'body'] },
    run: args => {
      if (!args.title || !args.body) throw new Error('title 与 body 必填');
      onIssueDraft({ title: String(args.title), body: String(args.body) });
      return '草稿已保存，等待用户点击提交。请继续调用 finish。';
    },
  });

  tools.push({
    name: 'finish', description: '结束诊断并提交报告。必须调用且只调用一次。',
    parameters: {
      type: 'object',
      properties: {
        summary: str('一句话结论'),
        rootCause: str('根因，没有把握就写「未确认」并说明证据缺口'),
        evidence: { type: 'array', items: { type: 'string' } },
        fixed: { type: 'boolean', description: '是否已经修复' },
        nextSteps: { type: 'array', items: { type: 'string' }, description: '需要用户做的事（如手动重启服务）' },
      },
      required: ['summary', 'rootCause'],
    },
    run: () => 'ok',
  });

  return { tools, actions };
}

module.exports = { createDoctorTools, checkCommand, redact, redactObject };
