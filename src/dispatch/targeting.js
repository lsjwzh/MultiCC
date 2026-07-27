'use strict';

const { isTerminalGateway } = require('./terminal-target-policy');
const { sanitizePublicText } = require('../session-dto');

const MAX_ROLE_SUMMARY_CHARS = 320;
const MAX_RECENT_TASKS = 4;
const MAX_RECENT_TASK_CHARS = 120;

function compactSafeText(value, maxChars) {
  const safe = sanitizePublicText(value, maxChars * 2);
  return safe ? safe.replace(/\s+/g, ' ').trim().slice(0, maxChars) : '';
}

function roleSummaryFor(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.rolePrompt) {
    return compactSafeText(record.rolePrompt, MAX_ROLE_SUMMARY_CHARS);
  }
  if (typeof record.agent === 'string') {
    return compactSafeText(record.agent, MAX_ROLE_SUMMARY_CHARS);
  }
  if (record.agent && typeof record.agent === 'object') {
    const parts = ['role', 'description', 'name', 'label']
      .map(key => compactSafeText(record.agent[key], MAX_ROLE_SUMMARY_CHARS))
      .filter(Boolean);
    if (parts.length) return compactSafeText(parts.join(' · '), MAX_ROLE_SUMMARY_CHARS);
  }
  return compactSafeText(record.label, MAX_ROLE_SUMMARY_CHARS);
}

function recentTasksFor(record) {
  const state = record?.taskState && typeof record.taskState === 'object'
    ? record.taskState : {};
  const history = Array.isArray(state.classifyHistory)
    ? [...state.classifyHistory].reverse()
    : [];
  if (state.goal) {
    history.push({
      goal: state.goal,
      phase: state.phase,
      state: state.classifyState,
    });
  }

  const seen = new Set();
  const recent = [];
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    const task = compactSafeText(entry.goal, MAX_RECENT_TASK_CHARS);
    const key = task.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    if (!task || seen.has(key)) continue;
    seen.add(key);
    const item = { task };
    const phase = compactSafeText(entry.phase, 40);
    const taskState = compactSafeText(entry.state, 24);
    if (phase) item.phase = phase;
    if (taskState) item.state = taskState;
    recent.push(item);
    if (recent.length >= MAX_RECENT_TASKS) break;
  }
  return recent;
}

function routingStateFor(record) {
  const pendingInput = record?.taskState?.pendingUserInput;
  if (pendingInput && pendingInput.resolved !== true) return 'waiting_user';
  const state = String(record?.taskState?.classifyState || '').trim().toUpperCase();
  return {
    W: 'waiting_user',
    P: 'processing',
    C: 'processing',
    B: 'background',
    E: 'error',
    D: 'ready',
  }[state] || 'unknown';
}

// Dispatch targeting: which sibling sessions a given session may dispatch to,
// and the cross-session dispatch context prompt injected into a turn. Extracted
// verbatim from server.js; the host injects the session registry, the live chat
// session map, and normalizeEffort so targeting/prompt stay free of globals.

function createDispatchTargeting({ records, chatSessions, normalizeEffort } = {}) {
  if (!records || typeof records.get !== 'function' || typeof records.values !== 'function') {
    throw new TypeError('[dispatch-targeting] records must be a map-like session registry');
  }
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('[dispatch-targeting] chatSessions must be map-like');
  }
  if (typeof normalizeEffort !== 'function') {
    throw new TypeError('[dispatch-targeting] normalizeEffort must be a function');
  }

function dispatchableSessionsFor(sessionId) {
  const from = records.get(sessionId);
  if (!from || !from.dirId) return [];
  const includeRoutingProfile = from.type === 'commander';
  return [...records.values()]
    .filter(s => s.id !== sessionId)
    // Never dispatch to a system/commander session: aux/gateway are internal,
    // commander only dispatches out (it is never a worker).
    .filter(s => s.type !== 'aux' && s.type !== 'gateway' && s.type !== 'commander')
    .filter(s => s.dirId === from.dirId)
    // A terminal gateway is an execution detail, not a second worker choice.
    // The Commander selects the stable terminal id only after explicit user
    // targeting; dispatchToSession then reuses this gateway automatically.
    .filter(s => !isTerminalGateway(records, s))
    .slice(0, 30)
    .map(s => {
      const activeChat = chatSessions.get(s.id);
      const target = {
        id: s.id,
        label: s.label || '',
        cli: s.cli || 'claude',
        kind: s.kind || 'terminal',
        active: !!activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming),
      };
      if (includeRoutingProfile) {
        target.role = roleSummaryFor(s);
        target.recentTasks = recentTasksFor(s);
        target.load = activeChat?.isStreaming ? 'running' : 'available';
        // Host-owned workflow state is separate from physical process load.
        // Expose only the bounded enum; never leak the pending question/options.
        target.routingState = routingStateFor(s);
      }
      return target;
    });
}

function buildDispatchContextPrompt(sessionId) {
  const targets = dispatchableSessionsFor(sessionId);
  if (!targets.length) return '';
  const current = records.get(sessionId);
  const isCommander = current?.type === 'commander';
  // Commander always gets the dispatch prompt (it's a real-LLM dispatcher and
  // routes one-way to workers); every other session must opt in via autoDispatch.
  if (!isCommander && !current?.autoDispatch) return '';
  const ultra = normalizeEffort(current?.effort) === 'ultracode';
  const intro = isCommander
    ? [
        '[MultiCC Commander routing]',
        '你是本 fleet 的 Commander。默认优先判断是否应把自包含任务用 route_task 单向派发给下面列出的同 fleet worker。',
        '这不是强制 route-only：轻量分析、检查、规划、解释，或用户明确要求你自己处理时，可以在当前会话完成；如果选择自己完成，请简短说明为什么不派发。',
        '涉及代码修改、长时间执行、验证/提交/合并、跨 provider、多模块并行或需要独立 worktree 的任务，优先 route_task 派发。',
        ...(ultra ? [
          '当前会话具备 Ultracode 能力，可用于轻量分析、验证和小范围自执行；但跨 session 派发仍只使用 route_task，不使用 <<dispatch>>。',
        ] : []),
      ]
    : ultra
      ? [
        '[MultiCC Ultracode workflow]',
        '当前会话开启了 ultracode（effort=xhigh + dynamic workflow）。你拥有两套任务分发能力，应根据任务性质选择：',
        '',
        '【A. Claude 内置 Task/Agent/Workflow 工具 — 进程内并行】',
        '适用于轻量只读/纯分析任务（搜索文件、读代码、快速研究、数据提取）。',
        '特点：低延迟、共享上下文、自动汇总，无需占用 worker session。',
        '用法：直接用 TaskCreate 创建任务，用 Agent 派生子代理并行执行，或用 Workflow 编排多阶段分析。',
        '',
        '【B. <<dispatch>> 标记 — 跨 session 分发】',
        '适用于重量级改代码任务（需要独立 worktree、跨 provider、需要 git commit/merge）、',
        '需要不同 provider 执行的任务、需要持久化且可追溯的独立操作。',
        '保持每个 dispatch 指令完整自包含：目标、约束、要读/改/验证的范围、最终需要回报的内容。',
        '需要改代码时，要求 worker 先 sync，完成后 commit + merge，并报告结果。',
        '',
        '⚠️ 把任务交给 worker session 的唯一途径是下面的 dispatch 标记或 dispatch API。',
        'run-detached 只是后台 shell 命令、notes 只是留言，都不会让任何 worker 干活。',
        '',
        '两者不互斥：同一回合可以同时使用 Task/Agent/Workflow 做分析 + <<dispatch>> 派发改动。',
      ]
      : [
        '[MultiCC cross-session dispatch]',
        '你可以把自包含子任务分发给同目录的其它 session。只有确实需要其它 session 干活时才输出标记，普通回答不要输出。',
      ];
  return [
    ...intro,
    isCommander
      ? '工具格式：route_task({"target_session_id":"multicc-claude-chat-05","message":"完整、自包含的任务说明"})（把示例 id 换成下方「可用目标 sessions」列表中逐字复制的 id）'
      : '格式：<<dispatch target="multicc-claude-chat-05">完整、自包含的任务说明</dispatch>>（把示例里的 id 换成上方「可用目标 sessions」列表中你选定的那个 id，逐字复制其 id 字段）',
    'target 必须逐字复制下面列表中某个对象的 id 字段值（如 multicc-claude-chat-05）；绝对不要使用 xxx、...、SID、SESSION_ID、worker-1 等占位符，否则派发必定失败。',
    isCommander
      ? '必须优先复用列表中的已有匹配会话；不得因为会话当前活跃、任务名称提到某种 CLI/终端，或为了“更合适”就新建会话。只有确实没有可胜任的现有 worker 时才报告缺少目标。'
      : '如果要并行执行多个子任务，可以在同一回复中输出多个 dispatch 标记；系统会把结果自动回流给你。',
    ...(isCommander ? [
      '候选字段含 role（稳定职责摘要）、recentTasks（最近任务，按新到旧）、load（进程负载）和 routingState（工作流状态）。这些是服务端提供的有界事实；候选列表顺序不表示优先级，不要根据 id、CLI 名称或最近活跃时间猜职责。',
      '选择顺序：① 用户明确点名的合法 chat session；② 与 recentTasks 中同一任务、模块或延续工作最匹配的会话；③ role 与任务领域最匹配的会话；④ 做过最相似近期任务的会话；⑤ 只有前述匹配相当时才用 load 破同分。',
      'role 表示长期职责，优先级高于一次偶发任务；recentTasks 用于判断经验与上下文连续性，不能把一次任务永久当成该会话的角色。',
      'load="running" 时 route_task 会持久排队且不会打断当前 turn。不要仅因最相关会话正在运行就改投不相关 worker；也不要把同一任务广播给多个会话。',
      'routingState="waiting_user" 表示该 worker 正等待上一任务的用户决定，新 route 会进入持久 FIFO。候选在任务连续性、role 和近期经验上相近时，优先选择非 waiting_user；用户明确点名、属于同一任务延续或相关性明显更高时仍可选择它。若仍选择它，需向用户说明任务已派发但正在 FIFO 等待。',
    ] : []),
    isCommander
      ? '默认只选择 kind="chat"。任务正文出现“终端/terminal/CLI”不代表用户指定了 terminal session；只有用户原话点名某个 terminal 的完整 id 或完整 label 时，才可选择该 terminal id 并设置 allow_terminal=true。'
      : '等价方式（适合在回合中途派活）：POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/dispatch，JSON body 必须包含 target 和 message；target 仍然必须是下面列表里的真实 id，结果同样自动回流。',
    ...(isCommander ? [
      '不要输出 <<route>> 或 <<dispatch>> 标记，也不要直接调用创建 session/终端的 API；跨 session 派发只调用 route_task，queued/operation_id 回执才是有效派发。',
      '如果要并行派发多个独立子任务，可连续调用多个 route_task；派发是单向的，worker 结果不会回流给你。',
    ] : []),
    `可用目标 sessions: ${JSON.stringify(targets)}`,
    isCommander
      ? '[MultiCC Commander routing end]'
      : ultra ? '[MultiCC Ultracode workflow end]' : '[MultiCC cross-session dispatch end]',
    '',
  ].join('\n');
}

function dispatchTargetHintFor(sessionId) {
  const targets = dispatchableSessionsFor(sessionId);
  if (!targets.length) return '当前同目录没有可分发的目标 session';
  return `可用目标 sessions: ${JSON.stringify(targets)}`;
}

  return { dispatchableSessionsFor, dispatchTargetHintFor, buildDispatchContextPrompt };
}

module.exports = { createDispatchTargeting };
