#!/usr/bin/env node
'use strict';
/*
 * zcode-bridge — MultiCC 树内协议桥接（专用 zcode adapter 的执行体）。
 *
 * 为什么需要它：官方 ZCode 引擎（Electron 桌面 app 内的 zcode.cjs）是真正的
 * headless CLI，但它的协议与 multicc 流式框架不兼容：
 *   - multicc 框架（server.js 行读取循环）按 `\n` 切、每行 JSON.parse，
 *     失败的行直接丢弃 → 只能消费【单行 JSONL】。
 *   - zcode.cjs `--json` 输出的是【多行 pretty-print JSON】整体对象，一轮跑完
 *     才有输出；子命令是 `--prompt <text> --json`，不是 multicc opencode-like 的
 *     `run --format json --auto`。
 * 本 bridge 做且仅做协议翻译：取末尾 argv 作为 prompt（multicc 把 payload 作为
 * 末尾位置参数传入，见 server.js 的 `[...args, payload]`），把引擎输出摊平为
 * 单行 JSONL 事件流（opencode raw 事件 shape），让 multicc 既有 decodeEvent 直接
 * 消费。不改动核心流式框架。
 *
 * 两条路径（2026-09-25 起）：
 *   1. **app-server（默认，流式）**：`zcode.cjs app-server` 是引擎自带的 ZCode
 *      Protocol stdio 服务端（引擎 0.16.x，实测 0.16.5）。bridge 起一个子进程，
 *      走 session/create|resume → session/subscribe → session/send，然后**边收
 *      `session/event` 边往 stdout 写** opencode 事件（文字/思考/工具调用/用量都是
 *      实时分片），一轮结束才退出。逐条映射逻辑在 ./zcode-app-server.js（纯函数，
 *      可单测）。
 *   2. **legacy（自动回退）**：握手失败（引擎没有 app-server 子命令、进程提前退出、
 *      请求超时/报错、create 拿不到合法 sess_ id）时，原样退回旧的 `--json
 *      --prompt` 整体 JSON 路径，保证老引擎/异常场景行为不变。
 *      `MULTICC_ZCODE_LEGACY=1` 可强制走旧路径。
 *
 * 协议要点（实测）：
 *   - stdio 上换行分隔 JSON；**没有 `jsonrpc` 字段**（.strict() schema 会拒绝它）；
 *   - 客户端→服务端 {id, method, params}；服务端→客户端也用 {id, method, params}
 *     （引擎用字符串 id，如 "server-1"），bridge 必须回 {id, result|error}，
 *     例如 session/requestRuntimePreferences（不回就得等引擎 15s 自己的兜底）；
 *   - 一轮结束：turn.completed（payload.resultType = success | cancelled |
 *     error_max_turns | error_max_budget | error_during_execution | error_max_tool_calls）
 *     或 turn.failed（payload.error）。
 *
 * 取消（multicc 的停止按钮 = 对本进程发 SIGTERM，宿主 1.5s 后 SIGKILL）：
 *   先发协议里的 `session/stop`（实测是 no-op：它只是把输入交给 v4 前台执行并清
 *   activeAbortController），再发真正会中断这一轮前台执行的
 *   `v4/command {type:'stop'}`，最多等 ~0.9s 让引擎把 turn.completed(cancelled)
 *   吐回来，然后收掉子进程并退出（>1.5s 会被宿主 SIGKILL，留下孤儿引擎）。
 *
 * 仅在用户显式发起的会话中被 spawn；不主动上传代码、不产生额外付费调用。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { DEFAULT_ZCODE_ENGINE } = require('./zcode-engine');
const { isZcodeSessionId } = require('./zcode-session');
const {
  RUNTIME_PREFERENCES,
  DEFAULT_MODE,
  DELIVERY_KIND,
  PROTOCOL_CLIENT_ID,
  TERMINAL_ERROR_CODE,
  buildRuntimeModel,
  createZcodeTurnMapper,
} = require('./zcode-app-server');

// 引擎路径：优先 ZCODE_ENGINE env（可移植、可追溯），回退到本机 .app 内的默认位置。
const ZCODE_ENGINE = process.env.ZCODE_ENGINE || DEFAULT_ZCODE_ENGINE;

// 握手期单条请求的超时。引擎自己的 requestRuntimePreferences 兜底是 15s，所以这里
// 必须更宽，否则我们会比引擎先放弃。握手失败会退回 legacy，代价只是这一轮慢一点。
const HANDSHAKE_TIMEOUT_MS = 20_000;
// 握手完成后的单条请求（subscribe/send 的受理回执都是毫秒级）。
const REQUEST_TIMEOUT_MS = 30_000;
// 收到 SIGTERM 后等引擎收尾的上限；加上 KILL_ESCALATE_MS 必须明显小于宿主的 1.5s。
const STOP_SETTLE_MS = 900;
const KILL_ESCALATE_MS = 250;
// 回退前留给 app-server 子进程退出的时间（spawnSync 会阻塞事件循环，必须先收干净）。
const FALLBACK_DISPOSE_MS = 500;

// ── 1. 解析 multicc 传入的参数：--session <id> 用于续轮，末尾位置参数 = prompt ─
// multicc 以 `node bridge [--session sid] <prompt>` 形式 spawn（payload 是末尾 argv）。
const argv = process.argv.slice(2);
let cliSessionId = null;
let model = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--session' && i + 1 < argv.length) {
    cliSessionId = argv[++i];
  } else if (argv[i] === '--model' && i + 1 < argv.length) {
    model = argv[++i];
  } else {
    positional.push(argv[i]);
  }
}
// 末尾位置参数即 prompt（multicc 追加 payload 为最后一个 arg）
const prompt = positional.length ? positional[positional.length - 1] : '';

function emit(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (_) { /* stdout 已断 */ }
}

// ── 2. 无 prompt：退化为引擎 --version 透传（无副作用启动检查，供 multicc 自检）──
if (!prompt) {
  if (!fs.existsSync(ZCODE_ENGINE)) {
    process.stderr.write(`zcode-bridge: 引擎不存在 (${ZCODE_ENGINE})；请用 ZCODE_ENGINE 指向 zcode.cjs\n`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [ZCODE_ENGINE, '--version'], { encoding: 'utf8' });
  process.stdout.write((r.stdout || '') + (r.stderr || ''));
  process.exit(r.status || 0);
}

if (!fs.existsSync(ZCODE_ENGINE)) {
  emit({
    type: 'error',
    error: { message: `zcode-bridge: 引擎不存在 (${ZCODE_ENGINE})；请用 ZCODE_ENGINE 指向 zcode.cjs` },
  });
  process.exit(0);
}

// ── 3. 模型一致性检查（不做临时覆盖）──────────────────────────────────────
// 引擎 0.15.2 的 parser 实际拒绝 --settings（help 广告了但未实现：所有子命令、所有
// 位置、等号形式全部 "Unknown option"，2026-07-25 实测），临时注入覆盖配置这条路在
// 引擎侧根本不存在。协议侧虽然 session/create 收 model 字段，但那要连 provider 凭证
// 通道一起搬到 bridge 里（per-session provider 的注入点在宿主，不在桥），本轮不做。
// 因此改为：
//   - 会话 model 与厂商默认配置一致 → 不传任何覆盖，引擎自动读默认配置
//     （"不传就用默认配置"）；
//   - 不一致 → 明确报错。静默用厂商默认 model 跑会让 multicc 的 per-session
//     model 形同虚设，比失败更糟；
//   - 厂商配置读不到 → 直接放行，让引擎报它自己的原生错误（如 Model config
//     is missing），不在此处二次包装。
function vendorConfigPath() {
  return process.env.ZCODE_SETTINGS
    || path.join(process.env.ZCODE_DATA_BASE_DIR || os.homedir(), '.zcode', 'cli', 'config.json');
}

function readVendorConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(vendorConfigPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;   // 读不到/解析不了 → 交给引擎自己报错，不阻断
  }
}

if (model) {
  const source = vendorConfigPath();
  const config = readVendorConfig();
  if (config && config.model && config.model !== model) {
    emit({
      type: 'error',
      error: { message: `ZCode 0.15.2 不支持 model 覆盖（--settings 未实现）：会话模型是 ${model}，但 ${source} 里是 ${config.model}。请把该文件的 model 改成 ${model}，或在 multicc 把会话模型切回 ${config.model}。` },
    });
    process.exit(0);
  }
}

// ── 4. legacy 路径：引擎整体 JSON → opencode raw 事件 JSONL ────────────────
function runLegacy() {
  const zargs = [ZCODE_ENGINE, '--json', '--prompt', prompt];
  if (isZcodeSessionId(cliSessionId)) zargs.push('--resume', cliSessionId);
  const res = spawnSync(process.execPath, zargs, { encoding: 'utf8', env: process.env, maxBuffer: 1e8 });

  if (res.status !== 0) {
    const msg = ((res.stdout || '') + (res.stderr || '')).split('\n').slice(0, 3).join(' ').slice(0, 300);
    emit({
      type: 'error', error: { message: msg || ('zcode.cjs 退出码 ' + res.status) },
    });
    process.exit(0);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    emit({ type: 'error', error: { message: '无法解析 zcode.cjs 输出' } });
    process.exit(0);
  }

  if (!parsed || !isZcodeSessionId(parsed.sessionId)) {
    emit({ type: 'error', error: {
      code: 'zcode_invalid_session_id', message: 'ZCode 未返回有效的原生会话 ID；未接受无法归属的输出。',
    } });
    process.exit(0);
  }
  const sid = parsed.sessionId;

  // The installed engine's runPrompt awaits submitPrompt and returns its
  // projection. Preserve failure/unknown outcomes instead of inventing stop
  // merely because JSON parsed. Missing projection supports older producers only
  // as an unknown outcome; it is not proof of success.
  const nativeStatus = parsed.projection?.status;
  if (parsed.error || ['failed', 'error', 'cancelled'].includes(nativeStatus)) {
    emit({ type: 'error', error: { code: TERMINAL_ERROR_CODE, message: `ZCode ended: ${nativeStatus || 'error'}` } });
    process.exit(1);
  }
  if (typeof parsed.response !== 'string') {
    emit({ type: 'error', error: { code: 'zcode_invalid_result', message: 'ZCode 未返回有效的结果内容。' } });
    process.exit(1);
  }

  emit({ sessionID: sid, type: 'step_start' });
  if (parsed.response) {
    emit({ sessionID: sid, type: 'text', part: { text: parsed.response } });
  }
  const u = parsed.usage || {};
  emit({
    sessionID: sid,
    type: 'step_finish',
    part: {
      reason: nativeStatus === 'idle' ? 'stop' : 'unknown',
      tokens: {
        input: u.inputTokens || 0,
        output: u.outputTokens || 0,
        cache: { read: u.cacheReadTokens || 0, write: u.cacheWriteTokens || 0 },
      },
    },
  });
  // 不显式 process.exit：让事件循环自然排空，避免截断 stdout 上未 flush 的管道写入
  //（整段回答可能很大，丢一条就少了半段）。
}

// ── 5. app-server 路径（流式）──────────────────────────────────────────────

// 握手失败（= 还没让引擎真正开始跑这一轮）→ 由 main 落回 legacy。
class HandshakeError extends Error {}

// 退出前把管道让干净再走：process.exit() 会截断 stdout 上未 flush 的管道写入，
// 而这里每一条事件都必须送达（step_finish 丢了整轮就判 unknown）。
function exitFlushed(code) {
  process.exitCode = code;
  // 关掉子进程的管道，让事件循环自己排空（比 process.exit 更不容易截断 stdout）；
  // 兜底再挂一个强制退出的定时器。
  try {
    if (appChild) {
      appChild.stdin.destroy();
      appChild.stdout.destroy();
      appChild.stderr.destroy();
    }
  } catch (_) {}
  const hard = setTimeout(() => process.exit(code), 400);
  hard.unref();
}

let appChild = null;

function serverErrorText(error) {
  if (!error) return '';
  const code = typeof error.code === 'number' || typeof error.code === 'string' ? ` (${error.code})` : '';
  return `${error.message || error.type || 'unknown'}${code}`;
}

// 起 app-server、握手、流式转发。正常结束不会返回（自己退出）；握手失败抛
// HandshakeError（调用方落回 legacy）；SIGTERM 后被收掉时抛 HandshakeError 但
// main 会因为 settled 标志直接返回、不会真的跑 legacy。
async function runAppServer() {
  const child = spawn(process.execPath, [ZCODE_ENGINE, 'app-server'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  appChild = child;
  // 引擎可能在握手前就退出（老引擎不认 app-server）；此时写 stdin 会 EPIPE，
  // 不接住就是未处理异常。
  child.stdin.on('error', () => {});
  // 引擎平时不写 stderr；只在失败时报出来（否则管道噪声会灌进会话日志）。
  let engineStderr = '';
  child.stderr.on('data', (chunk) => {
    if (engineStderr.length < 4_096) engineStderr += String(chunk).slice(0, 4_096 - engineStderr.length);
  });

  let nextId = 1;
  const pending = new Map();
  const state = {
    settled: false,        // 已在收尾（子进程已杀，即将退出）
    turnAccepted: false,   // session/send 已被受理 = 引擎真的开始跑这一轮了
    turnEvidence: false,   // 收到过这一轮的流式事件（即便受理回执丢了也别回退）
    sid: null,
    afterSeq: null,
    mapper: null,
    buffered: [],          // 受理回执之前先到的这一轮事件（不能丢，也不能提前写出去）
  };

  const rl = readline.createInterface({ input: child.stdout });

  function send(msg) {
    try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch (_) {}
  }

  function request(method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const err = new Error(`${method} 超时 (${timeoutMs}ms)`);
        err.timeout = true;
        reject(err);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      send({ id, method, params });
    });
  }

  function rejectPending(reason) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    pending.clear();
  }

  // 收尾：杀子进程 + flush 退出。等 close（最多 KILL_ESCALATE_MS）避免留孤儿引擎；
  // 超过就 SIGKILL。
  function teardown(code) {
    if (state.settled) return;
    state.settled = true;
    rejectPending(new HandshakeError('bridge 已停止'));
    try { child.kill('SIGTERM'); } catch (_) {}
    const hard = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      exitFlushed(code);
    }, KILL_ESCALATE_MS);
    child.once('close', () => {
      clearTimeout(hard);
      try { rl.close(); } catch (_) {}
      exitFlushed(code);
    });
    if (child.exitCode !== null || child.signalCode) {
      clearTimeout(hard);
      exitFlushed(code);
    }
  }

  // 引擎在握手前的**任何**异常都按握手失败处理（回退 legacy）；回退前必须等子进程
  // 真的死掉，因为接下来 spawnSync 会阻塞事件循环，收不干净就留孤儿引擎。
  function disposeChild() {
    if (child.exitCode !== null || child.signalCode) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once('close', finish);
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, KILL_ESCALATE_MS);
      setTimeout(finish, FALLBACK_DISPOSE_MS);
    });
  }

  function failHandshake(err) {
    const message = err && err.message ? err.message : String(err);
    return disposeChild().then(() => {
      if (engineStderr.trim()) {
        process.stderr.write(`zcode-bridge: app-server 握手失败，回退 legacy（${message}）\n${engineStderr.trim()}\n`);
      }
      throw new HandshakeError(message);
    });
  }

  // 引擎发过来的客户端请求（服务端 → 客户端）。不回就得等引擎自己的 15s 兜底，
  // 所以每一个都要答。
  function answerClientRequest(msg) {
    let result = null;
    let error = null;
    if (msg.method === 'session/requestRuntimePreferences') {
      result = RUNTIME_PREFERENCES;
    } else if (msg.method === 'interaction/requestPermission') {
      // 无人值守：一律放行（等价 `--mode yolo` 的自动通过）。
      result = { decision: 'allow', reason: 'multicc auto-approve' };
    } else if (msg.method === 'interaction/requestUserInput') {
      // 无人值守会话没法替用户回答问题；取消比编一个答案诚实。
      // 正常不会走到：偏好里 askUserQuestionAutoResolutionEnabled=true 时引擎自己消解。
      result = { action: 'cancel', reason: 'multicc 无人值守会话无法回答问题' };
    } else {
      error = { code: -32601, message: `multicc zcode bridge: unsupported ${msg.method}` };
    }
    send(error ? { id: msg.id, error } : { id: msg.id, result });
  }

  function forward(params) {
    const { events, done } = state.mapper.map(params);
    for (const event of events) { if (!state.settled) emit(event); }
    if (done) teardown(done === 'failed' ? 1 : 0);
  }

  function onSessionEvent(params) {
    if (!params || typeof params !== 'object') return;
    if (state.sid && typeof params.sessionId === 'string' && params.sessionId !== state.sid) return;
    if (typeof params.seq === 'number') {
      if (state.afterSeq !== null && params.seq <= state.afterSeq) return;   // 订阅前的重放
      state.afterSeq = params.seq;
    }
    // 会话级事件（session.updated/titleUpdated）不是「这一轮已经开跑」的证据。
    if (!state.turnAccepted) {
      if (!/^session\./.test(String(params.type))) state.turnEvidence = true;
      // 受理回执还没来得及处理时先到的分片：不能丢（可能是整轮的唯一分片），
      // 也不能提前写出去（此时回退还是安全的）。
      if (state.mapper && state.buffered.length < 5_000) state.buffered.push(params);
      return;
    }
    forward(params);
  }

  rl.on('line', (line) => {
    let msg = null;
    try { msg = JSON.parse(line); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.id !== 'undefined' && typeof msg.method === 'string') {
      answerClientRequest(msg);
      return;
    }
    if (typeof msg.id !== 'undefined' && (msg.result !== undefined || msg.error !== undefined)) {
      // 引擎可能把数字 id 回成字符串，宽松匹配一次。
      const p = pending.get(msg.id) || pending.get(Number(msg.id)) || pending.get(String(msg.id));
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method} 失败: ${serverErrorText(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'session/event') onSessionEvent(msg.params);
  });

  // 子进程没了：握手期 → 回退；流式中 → 引擎中途挂掉，如实报错（此时 send 已被
  // 受理，回退会变成第二次模型调用，所以不回退）。
  child.on('close', (code, signal) => {
    if (state.settled) return;
    if (!state.turnAccepted) {
      const err = new HandshakeError(`app-server 在握手期退出 (code=${code} signal=${signal || ''})`);
      rejectPending(err);
      return;
    }
    state.settled = true;
    rejectPending(new HandshakeError('app-server 已退出'));
    const detail = engineStderr.trim() ? `：${engineStderr.trim().split('\n').slice(-3).join(' ')}` : '';
    emit({
      type: 'error',
      error: { code: TERMINAL_ERROR_CODE, message: `ZCode 引擎在回合中途退出 (code=${code} signal=${signal || ''})${detail}` },
    });
    exitFlushed(1);
  });
  child.on('error', (err) => {
    if (state.settled) return;
    if (!state.turnAccepted) { rejectPending(new HandshakeError(`app-server 启动失败: ${err.message}`)); return; }
    state.settled = true;
    emit({ type: 'error', error: { code: TERMINAL_ERROR_CODE, message: `ZCode 引擎启动失败: ${err.message}` } });
    exitFlushed(1);
  });

  // 最后一道保险：无论如何别把引擎子进程留成孤儿。
  process.on('exit', () => { try { child.kill('SIGKILL'); } catch (_) {} });

  // 取消：宿主对本进程 SIGTERM（1.5s 后 SIGKILL）。先按协议发 session/stop，再发
  // 真正生效的 v4/command stop，等引擎把 turn.completed(cancelled) 吐回来（上限
  // STOP_SETTLE_MS），然后收掉子进程退出。
  function onSignal() {
    if (state.settled) return;
    if (!state.turnAccepted || !state.sid) { teardown(0); return; }
    state.stopRequested = true;
    send({ id: nextId++, method: 'session/stop', params: { sessionId: state.sid } });
    send({
      id: nextId++,
      method: 'v4/command',
      params: {
        type: 'stop',
        sessionId: state.sid,
        commandId: `multicc-stop-${Date.now()}`,
        issuedAt: Date.now(),
        clientId: PROTOCOL_CLIENT_ID,
        baseRevision: 0,
        payload: {},
      },
    });
    // 不 ref：引擎自己会把 turn.completed(cancelled) 送回来（那就立刻收尾），这个
    // 定时器只是「等不到就别等了」的兜底，不该拖住进程退出。
    setTimeout(() => teardown(0), STOP_SETTLE_MS).unref?.();
  }
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  function sessionIdOf(result) {
    if (!result || typeof result !== 'object') return null;
    const nested = result.session && typeof result.session === 'object' ? result.session.sessionId : null;
    if (isZcodeSessionId(nested)) return nested;
    return isZcodeSessionId(result.sessionId) ? result.sessionId : null;
  }

  try {
    const workspace = { workspacePath: process.cwd(), workspaceKey: process.cwd() };
    let sid = null;
    if (isZcodeSessionId(cliSessionId)) {
      // 续轮：全新进程的 workspaceModelCatalogs 是空的，不喂 runtimeModel 的话
      // resume 会给会话挂 restoreWarning，紧随其后的 send 直接 -32031。
      const runtimeModel = buildRuntimeModel(readVendorConfig(), null);
      const resumed = await request('session/resume', {
        sessionId: cliSessionId,
        workspace,
        ...(runtimeModel ? { runtimeModel } : {}),
      }, HANDSHAKE_TIMEOUT_MS);
      sid = sessionIdOf(resumed) || cliSessionId;
    } else {
      // mode=yolo：等价于 CLI `--prompt` 的默认模式（help: "default: yolo for --prompt"），
      // 即旧的无人值守行为。model 不传 —— 上面已校验过会话 model 与厂商配置一致。
      const created = await request('session/create', { workspace, mode: DEFAULT_MODE }, HANDSHAKE_TIMEOUT_MS);
      sid = sessionIdOf(created);
      if (!sid) throw new HandshakeError('session/create 未返回 sess_ 开头的原生会话 ID');
    }
    state.sid = sid;
    state.mapper = createZcodeTurnMapper({ sessionId: sid });

    const sub = await request('session/subscribe', {
      sessionId: sid,
      deliveryKind: DELIVERY_KIND,
      includeSnapshot: false,
    }, HANDSHAKE_TIMEOUT_MS);
    state.afterSeq = sub && typeof sub.eventSeq === 'number' ? sub.eventSeq : null;

    try {
      await request('session/send', { sessionId: sid, content: prompt }, REQUEST_TIMEOUT_MS);
    } catch (err) {
      // 受理回执丢了但已经看到这一轮的事件 → 引擎确实在跑，继续把这一轮转发完，
      // 绝不能回退（回退会变成第二次模型调用）。
      if (!state.turnEvidence && !err.timeout) throw err;
    }
    state.turnAccepted = true;
    const buffered = state.buffered.splice(0);
    for (const params of buffered) { if (!state.settled) forward(params); }
  } catch (err) {
    // 走到这里说明这一轮还没被受理 → 可以安全回退。
    try { rl.close(); } catch (_) {}
    if (state.settled) {
      // 已被 SIGTERM 收掉（teardown 已经安排好退出），这里不能再落回 legacy。
      const stopped = new HandshakeError(err && err.message ? err.message : 'bridge 已停止');
      stopped.stopped = true;
      throw stopped;
    }
    return failHandshake(err);
  }
}

async function main() {
  if (process.env.MULTICC_ZCODE_LEGACY !== '1') {
    try {
      await runAppServer();
      return;   // 正常路径不会走到这里（teardown 自己退出）
    } catch (err) {
      // 已被取消/已在收尾：别落回 legacy（那会在一个即将退出的进程里再跑一轮）。
      if (err && err.stopped) return;
      if (!(err instanceof HandshakeError)) throw err;
      if (appChild && appChild.exitCode === null && !appChild.signalCode) {
        try { appChild.kill('SIGKILL'); } catch (_) {}
      }
      // 握手失败 → 落到 legacy
    }
  }
  runLegacy();
}

main().catch((err) => {
  emit({ type: 'error', error: { message: `zcode-bridge 内部错误: ${err && err.message ? err.message : err}` } });
  process.exit(1);
});
