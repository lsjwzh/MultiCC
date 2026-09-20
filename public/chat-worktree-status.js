(function (root) {
  'use strict';

  // Worktree merge/sync status for the chat page: the branch + behind-base row,
  // the one-click sync, the persistent conflict banner for a parked rebase, and
  // the poller that drives all three. Extracted from public/chat.js, which keeps
  // thin global wrappers under the original names because the merge-hint
  // observer and the CDP fixtures call them by name.
  //
  // The host injects the session id and the two merge controls, and reads
  // `mergeReady` back to decide how to word a merge confirmation.

  function create({ document, tt, withToken, sessionId, mergeButton, mergeHint, api, notice, syncRequest,
    isActive = () => true }) {
    let mergeReady = false;
    let syncConflict = false;
    let syncConflictFiles = [];
    let mergePollTimer = null;
    // Track last-warned behind count so we surface a notice when the worktree
    // first falls behind its base branch (or falls further), not on every 5s poll.
    let lastWarnedBehind = 0;

    // 工作区被回收（休眠 / 手工清理）：服务端在 merge-status 里给 worktreeMissing，
    // 老一点的口径只给 reason='hibernated'。两种都算「本地没有 checkout」——
    // 没有可同步的 worktree，也没有可比的落后量。
    function isReclaimed(st) {
      return !!(st && (st.worktreeMissing === true || st.reason === 'hibernated'));
    }

    function mergeStatusText(st) {
      // A reclaimed workspace has no checkout: "clean" would be wrong and
      // "behind" would advertise a sync the server refuses.
      if (isReclaimed(st)) return tt('worktreeReclaimed');
      if (!st || (!st.mergeReady && !(st.dirty || st.ahead > 0))) return tt('worktreeClean');
      // Dirty/ahead exist but merge is blocked — show why.
      if (!st.mergeReady && !st.baseCheckedOut) {
        return tt('mergeBlockedBranch', { base: st.baseBranch || 'main' });
      }
      const bits = [];
      if (st.dirty) bits.push(tt('dirtyChanges'));
      if ((st.ahead || 0) > 0) bits.push(tt('aheadCommits', { n: st.ahead }));
      return tt('worktreeMergeable', { detail: bits.join('，'), base: st.baseBranch || tt('defaultBase') });
    }

    function applyMergeStatus(st) {
      mergeReady = !!(st && st.mergeReady);
      syncConflict = !!(st && st.conflict);
      syncConflictFiles = (st && st.conflictFiles) || [];
      if (mergeButton) {
        mergeButton.classList.toggle('merge-ready', mergeReady);
        mergeButton.title = mergeReady ? mergeStatusText(st) : tt('mergeWorktreeTitle');
      }
      if (mergeHint) {
        mergeHint.classList.toggle('show', mergeReady);
        const text = mergeHint.querySelector('.merge-hint-text');
        if (text) text.textContent = mergeStatusText(st);
      }
      applyBehindStatus(st);
    }

    // Persistent conflict banner: rendered while the worktree is parked mid-rebase
    // after a conflicting sync. Stays put across refreshes (driven by merge state,
    // not a one-shot toast) and offers in-place 继续 / 放弃 controls.
    function applyConflictBanner(st) {
      let bar = document.getElementById('worktree-conflict-bar');
      const conflict = !!(st && st.conflict);
      if (!conflict) { if (bar) bar.remove(); return; }
      const files = (st && st.conflictFiles) || [];
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'worktree-conflict-bar';
        bar.className = 'worktree-conflict-bar';
        const anchor = document.getElementById('worktree-bar');
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
        else document.body.insertBefore(bar, document.body.firstChild);
      }
      bar.innerHTML = '';
      const label = document.createElement('span');
      label.className = 'conflict-label';
      label.textContent = `⚠️ 同步冲突：${files.length} 个文件待解决`;
      label.title = files.join('\n');
      const help = document.createElement('button');
      help.textContent = '如何解决';
      help.onclick = () => showConflictHelp(files);
      const cont = document.createElement('button');
      cont.className = 'conflict-continue';
      cont.textContent = '继续';
      cont.onclick = () => resolveRebase('continue');
      const abort = document.createElement('button');
      abort.className = 'conflict-abort';
      abort.textContent = '放弃';
      abort.onclick = () => resolveRebase('abort');
      bar.appendChild(label);
      bar.appendChild(help);
      bar.appendChild(cont);
      bar.appendChild(abort);
      // The parked-sync decisions (继续/放弃) live here, so requesting another sync
      // belongs next to them — the same affordance the status row carries (no id
      // here; the status row keeps the id, ids must stay unique).
      syncRequest.render(bar);
    }

    function showConflictHelp(files) {
      notice(
        `同步与基分支冲突，rebase 已暂停。请按下面步骤手动解决：\n` +
        `冲突文件（${files.length}）：\n${files.map(f => '  · ' + f).join('\n') || '  (无)'}\n` +
        `1. 在本会话的 worktree 里编辑上述文件，消除 <<<<<<< / ======= / >>>>>>> 冲突标记\n` +
        `2. 解决后点横幅上的「继续」（= git add -A && git rebase --continue）\n` +
        `3. 想放弃本次同步、回到同步前状态，点「放弃」（= git rebase --abort）`);
    }

    // Continue or abort the parked rebase from the chat banner.
    async function resolveRebase(action) {
      const session = sessionId();
      if (!session) { notice('无 session id，无法操作 rebase'); return; }
      try {
        const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(session)}/rebase`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        const data = await res.json().catch(() => ({}));
        const failure = res.ok ? null : api.errorFromPayload(data, { response: res });
        if (res.ok) {
          if (data.aborted) notice('✓ 已放弃 rebase，worktree 回到同步前状态');
          else if (data.done) notice('✓ 冲突已解决，同步完成');
          else notice('✓ rebase 已继续');
          refreshMergeStatus();
        } else if (res.status === 409 && data.conflicts) {
          notice(`✗ 仍有冲突未解决：${api.errorText(failure)}\n${data.conflicts.join(', ')}\n请全部解决后再点「继续」。`);
          refreshMergeStatus();
        } else {
          notice(`✗ 操作失败：${api.errorText(failure)}`);
        }
      } catch (e) {
        notice(`✗ 请求失败：${api.errorText(e)}`);
      }
    }

    // Show the current worktree branch + a "behind base" warning at the top of the
    // chat. Mirrors the Flutter app: a persistent banner while behind, plus a
    // one-time system notice when it first goes (or falls further) behind.
    function applyBehindStatus(st) {
      const behind = (st && Number(st.behind)) || 0;
      const branch = (st && st.branch) || '';
      const base = (st && st.baseBranch) || 'main';
      // 工作区被回收（休眠 / 手工清理）时记录仍留着 branch + worktreePath：既没有
      // 可同步的 checkout，也没有落后的可比对对象。说清状态、不给那颗点不动的
      // 「同步」（它只会拿到 409）；「强制同步」留着 —— 它把指令交给了会话，
      // 投递时会先把工作区恢复出来。
      const reclaimed = isReclaimed(st);
      const bar = document.getElementById('worktree-bar');
      if (bar) {
        if (branch) {
          bar.classList.add('show');
          bar.classList.toggle('behind', behind > 0 && !reclaimed);
          const label = reclaimed
            ? tt('worktreeReclaimed')
            : behind > 0
              ? tt('behindLabel', { branch, base, n: behind })
              : `⎇ ${branch}`;
          bar.innerHTML = '';
          const span = document.createElement('span');
          span.className = 'worktree-label';
          span.textContent = label;
          span.title = reclaimed ? `${label}（${branch}）` : label;
          bar.appendChild(span);
          if (behind > 0 && !reclaimed) {
            const btn = document.createElement('button');
            btn.id = 'worktree-sync-btn';
            btn.textContent = tt('sync');
            btn.onclick = syncWorktree;
            bar.appendChild(btn);
          }
          // 强制同步 rides this row too, not only the conflict banner: it is the
          // only sync path while the branch is clean.
          syncRequest.render(bar, 'worktree-force-sync-btn');
        } else {
          bar.classList.remove('show', 'behind');
          bar.innerHTML = '';
        }
      }
      if (!reclaimed) {
        if (behind > lastWarnedBehind) {
          notice(tt('behindBanner', { branch, base, n: behind }));
        }
        lastWarnedBehind = behind;
      }
      applyConflictBanner(st);
    }

    // One-click sync: pull the base branch into this session's worktree.
    async function syncWorktree() {
      const session = sessionId();
      if (!session) { notice('无 session id，无法同步'); return; }
      const btn = document.getElementById('worktree-sync-btn');
      if (btn) { btn.disabled = true; btn.textContent = tt('syncing'); }
      try {
        const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(session)}/sync`), { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        const failure = res.ok ? null : api.errorFromPayload(data, { response: res });
        if (res.ok) {
          notice(data.merged
            ? `✓ 已从 ${data.baseBranch || 'base'} 同步 ${data.commits} 个提交${data.committed ? '（已自动提交未保存改动）' : ''}`
            : (data.message || '已是最新'));
          refreshMergeStatus();
        } else if (res.status === 409 && data.conflicts) {
          notice(`✗ 同步与基分支冲突：${api.errorText(failure)}\n${data.conflicts.join(', ')}\n请用上方横幅的「继续 / 放弃」处理，或在 worktree 手动解决。`);
          refreshMergeStatus();
        } else {
          notice(`✗ 同步失败：${api.errorText(failure)}`);
        }
      } catch (e) {
        notice(`✗ 同步请求失败：${api.errorText(e)}`);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = tt('sync'); }
      }
    }

    async function refreshMergeStatus() {
      const session = sessionId();
      if (!session) return;
      try {
        const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(session)}/merge-status`));
        if (!res.ok) return;
        applyMergeStatus(await res.json());
      } catch (_) {}
    }

    function startMergeStatusPolling() {
      refreshMergeStatus();
      if (mergePollTimer) clearInterval(mergePollTimer);
      // 帧被 Air 收进池子（人在看别的任务）就跳过这一拍：这条状态没有人在看，问它
      // 只是白跑一趟接口。手动点 ↻ 走的是 refreshMergeStatus，不受这个开关影响。
      mergePollTimer = setInterval(() => { if (isActive() !== false) refreshMergeStatus(); }, 5000);
    }

    return {
      get mergeReady() { return mergeReady; },
      apply: applyMergeStatus,
      refresh: refreshMergeStatus,
      startPolling: startMergeStatusPolling,
    };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCWorktreeStatus = api;
})(typeof window !== 'undefined' ? window : globalThis);
