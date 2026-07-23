'use strict';

const {
  explicitlyNamesTerminal,
  terminalForRecord,
} = require('./terminal-target-policy');

function routeLegacyCommanderMarkers({
  markers,
  dispatcherId,
  from,
  sourceUserText,
  sourceKey,
  records,
  crypto,
  isPlaceholder,
  validateTarget,
  appendEvent,
  dispatch,
  inject,
} = {}) {
  const deliveries = [];
  for (const [markerIndex, marker] of (markers || []).entries()) {
    if (marker.target === dispatcherId) continue;
    if (isPlaceholder(marker.target)) {
      inject(`⚠️ route 目标无效：${marker.target}`);
      continue;
    }
    const validated = validateTarget(marker.target);
    if (!validated.ok) {
      inject(`⚠️ 无法路由给 ${marker.target}：${validated.error}`);
      continue;
    }
    if (validated.rec.dirId !== from.dirId) {
      inject(`⚠️ 只能路由给同目录会话，已跳过 ${marker.target}`);
      continue;
    }
    const terminal = terminalForRecord(records, validated.rec);
    if (terminal && validated.rec.kind === 'chat') {
      inject(`⚠️ 「${marker.target}」是终端执行网关；请改用稳定 terminal session「${terminal.id}」`);
      continue;
    }
    if (terminal && !explicitlyNamesTerminal(sourceUserText, terminal)) {
      inject(`⚠️ 未路由给终端「${terminal.id}」：用户原话没有点名该 terminal session；请改选已有 chat worker。`);
      continue;
    }

    const taskId = `tsk-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const targetLabel = validated.rec.label || marker.target;
    deliveries.push(Promise.resolve().then(() => dispatch(marker.target, marker.message, {
      replyTo: dispatcherId,
      oneWay: true,
      taskId,
      taskStart: true,
      taskSource: 'commander',
      taskText: marker.message,
      idempotencyKey: `route:${dispatcherId}:${sourceKey}:${markerIndex}`,
    })).then(result => {
      if (!result?.ok) {
        inject(`⚠️ 路由给 ${targetLabel} 失败：${result?.error || 'dispatch_failed'}`);
        return result;
      }
      appendEvent(from.dirId, 'route', `→ ${targetLabel} [${taskId}]`, dispatcherId);
      const executionNote = result.chatId && result.chatId !== marker.target
        ? `，实际执行会话「${result.chatId}」`
        : '';
      inject(`📨 已持久排队给「${targetLabel}」[${taskId}]${executionNote}（单向派发，结果不回流）`);
      return result;
    }).catch(error => {
      inject(`⚠️ 路由 ${targetLabel} 异常：${error.message}`);
      return { ok: false, error: error.message };
    }));
  }
  return deliveries;
}

module.exports = { routeLegacyCommanderMarkers };
