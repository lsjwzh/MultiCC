(function (root) {
  'use strict';
  function syncPrompt() {
    return '请同步本会话的工作区到所属工作目录的最新本地基分支，并解决同步冲突。\n'
      + '只在当前会话自己的 worktree 操作，不修改主工作区。执行时重新确认工作区、基分支、Git 状态及是否已有 merge/rebase；有未完成同步则先检查并解决。\n'
      + '保留所有未提交、未跟踪文件和独有提交，必要时先建立可恢复的备份或提交；不要使用 reset --hard、clean、强制覆盖或丢弃无法证明已合入的改动。\n'
      + '确认没有其他 Git 操作或写入者并发后，用合适的 fast-forward、rebase 或 merge 同步，结合双方意图解决冲突，不盲选 ours/theirs。无法判断归属或冲突含义时保留现场并说明阻碍。\n'
      + '完成后运行与改动相关的检查，核验 git status --short 和 HEAD...基分支 的 ahead/behind，确认 behind 为 0；如仍有 ahead 或保留的改动请说明。报告同步结果后继续原任务。';
  }

  function create({ document, getSession, getShell, readOnly, request, notice }) {
    // The affordance renders into every live container: the persistent
    // worktree status row and the conflict banner (the one that also carries
    // 放弃/继续). Containers dropped from the DOM are pruned on each render.
    // A container may claim the button's id — the status row does, because it
    // is the always-present copy — since ids must stay unique per document.
    let busy = false, retry = null;
    const bars = new Map();
    function render(container, buttonId) {
      if (container) bars.set(container, buttonId || bars.get(container) || '');
      for (const [bar, id] of bars) {
        if (!bar.isConnected) { bars.delete(bar); continue; }
        let button = bar.querySelector('.worktree-force-sync-btn');
        if (!button && !readOnly()) {
          button = document.createElement('button');
          button.className = 'worktree-force-sync-btn'; button.type = 'button';
          if (id) button.id = id;
          button.title = '发送同步指令，由会话保留改动并处理冲突；忙碌时排队';
          button.onclick = send; bar.appendChild(button);
        }
        if (button) {
          button.disabled = busy;
          button.textContent = busy ? '正在发送…' : retry ? '重试同步指令' : '强制同步';
        }
      }
    }
    async function send() {
      if (busy || readOnly()) return;
      const sessionId = getSession(), shellId = getShell();
      if (!sessionId || !shellId) { notice('会话尚未连接，请稍后重试同步指令。'); return; }
      busy = true; render();
      try {
        const scope = await request(`/api/task-shells/${encodeURIComponent(shellId)}/chat`);
        if (!scope.taskId || scope.activeSessionId !== sessionId || getSession() !== sessionId) {
          throw new Error('当前任务已变化，请确认会话后重新发送同步指令。');
        }
        // Reuse the receipt key after a lost response. A polling refresh or
        // double click must not start an extra synchronization turn.
        if (!retry || retry.taskId !== scope.taskId) retry = { taskId: scope.taskId,
          body: { text: syncPrompt(), intent: 'work', clientMsgId: `worktree-sync-${root.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)}` } };
        const result = await request(`/api/task-shell-tasks/${encodeURIComponent(retry.taskId)}/messages`, {
          method: 'POST', json: retry.body,
        });
        if (result.ok === false) throw new Error(result.error || result.code || '发送失败');
        retry = null;
        notice(result.decision === 'queued'
          ? '✓ 同步指令已加入 FIFO，轮到后会保留改动、解决冲突并同步。'
          : '✓ 同步指令已发送，会话将保留改动、解决冲突并同步。');
      } catch (error) { notice(`✗ 同步指令未确认送达：${error.message}；可重试。`); }
      finally { busy = false; render(); }
    }
    return { render };
  }
  const api = { create, syncPrompt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCWorktreeSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
