'use strict';

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
  return [...records.values()]
    .filter(s => s.id !== sessionId)
    .filter(s => s.type !== 'aux' && s.type !== 'gateway')
    .filter(s => s.dirId === from.dirId)
    .slice(0, 30)
    .map(s => {
      const activeChat = chatSessions.get(s.id);
      return {
        id: s.id,
        label: s.label || '',
        cli: s.cli || 'claude',
        kind: s.kind || 'terminal',
        active: !!activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming),
      };
    });
}

function buildDispatchContextPrompt(sessionId) {
  const targets = dispatchableSessionsFor(sessionId);
  if (!targets.length) return '';
  const current = records.get(sessionId);
  if (!current?.autoDispatch) return '';
  const ultra = normalizeEffort(current?.effort) === 'ultracode';
  const intro = ultra
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
    '格式：<<dispatch target="真实 session id">完整、自包含的任务说明</dispatch>>',
    'target 必须逐字使用下面列表中的某个 id；不要使用 ...、SID、SESSION_ID、<目标会话id> 等占位符。',
    '如果要并行执行多个子任务，可以在同一回复中输出多个 dispatch 标记；系统会把结果自动回流给你。',
    '等价方式（适合在回合中途派活）：POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/dispatch，JSON body 必须包含 target 和 message；target 仍然必须是下面列表里的真实 id，结果同样自动回流。',
    `可用目标 sessions: ${JSON.stringify(targets)}`,
    ultra ? '[MultiCC Ultracode workflow end]' : '[MultiCC cross-session dispatch end]',
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
