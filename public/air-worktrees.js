'use strict';
// 目录的 worktree 生命周期面板（`air.html` 的 `#directory-worktrees`）、目录卡上
// 那一行摘要，以及「现在回收」。
//
// 为什么要有这块：以前界面上只有一句「N 个 Worktree」，看不出这个数字是怎么长的
// —— 是本地真占着磁盘，还是已经睡下了、只剩一条分支引用，还是计划了还没落地。
// 用户要判断的正是「要不要现在腾地方」，所以三个数必须分开摆：
//   · 本地（resident/retained）：磁盘上真有这份 checkout，占地方的就是它们；
//   · 休眠（hibernated）：本地 checkout 已删、分支与提交保留，下次打开按需重建；
//   · 计划（planned）：记录建了，worktree 还没落地。
// 口径来自 /api/air 快照的 worktreeLifecycle（server 按 workspace registry 的
// residency 折算，客户端只读不推断）；worktreeCount 继续是总数，保留兼容。
//
// 主动回收 = POST /api/air/worktrees/reclaim（dirId 限定目录）。默认只收过了闲置
// 阈值的；一个都没收到、本地却还占着地方，才问一句「连最近用过的也一起收吗」——
// 那是用户按下按钮之后的显式确认，不是自动行为。回收只删本地 checkout，分支和提交
// 始终保留，所以这条路不需要「丢东西」的警告。
//
// 为什么是独立文件：air.js 贴着 3000 行的行数闸门（scripts/check-source-line-
// budget.js），一百多行 DOM 逻辑塞进主文件只会再抬一次天花板。这里只留两处接线：
// 目录卡那行文案走 summary()，目录首页那块面板走 render()。
(function initAirWorktrees(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  // i18n 由 i18n.js 提供；它没加载（单页/旧壳）时退回 key，不至于把界面打空。
  const translate = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const EMPTY = Object.freeze({ resident: 0, retained: 0, hibernated: 0, planned: 0, leased: 0, onDisk: 0, total: 0 });

  // 快照里没有这一格（旧 server / 还没接线）就返回 null：那时候只知道总数，硬把
  // 「全部算本地」说出来是编数字 —— 拆解的意义正是区分本地和睡下的，编不出来就
  // 不说，照旧只报总数。
  function lifecycleOf(directory) {
    const life = directory?.worktreeLifecycle;
    return life ? { ...EMPTY, ...life } : null;
  }

  function breakdown(life) {
    return translate('airWorktreeBreakdown', { onDisk: life.onDisk, hibernated: life.hibernated, planned: life.planned });
  }

  function totalOf(directory, life) { return Number(directory?.worktreeCount) || life?.total || 0; }

  // 总数是「会话记录」条数（含已休眠、只存分支引用的），不是磁盘上的 checkout 数。
  // 所以文案上拆解（本地/休眠/计划）永远摆前面，总数带标签压尾，不再以
  // 「98 个 Worktree」开头 —— 那个读法会让人以为磁盘上真有 98 份。
  function recordTotal(total) { return translate('airWorktreeRecordTotal', { n: total }); }

  // 目录卡上那一行（air.js 的 renderDirectories 直接拿它当文案）：拆解 + 带标签的
  // 记录总数；空目录照说「0 个」（一眼看出「这里没有」比留白有用），但没有拆解或
  // 总数是 0 时就只说总数 —— 三个 0 摆出来只是噪声，统计卡那行已经说过「0 个 WT」了。
  function summary(directory) {
    const life = lifecycleOf(directory);
    const total = totalOf(directory, life);
    if (!life || !total) return translate('airDirWorktreeCount', { n: total });
    return `${breakdown(life)} ${recordTotal(total)}`;
  }

  let ctx = null;
  let busy = false;

  function policyText() {
    const idleMs = Number(ctx?.data?.worktreePolicy?.idleMs) || 0;
    if (!(idleMs > 0)) return translate('airWorktreePolicyOff');
    // 默认阈值是 24 小时，说成「闲置超过 24 小时」比说 86400000 有用。
    return translate('airWorktreePolicy', { hours: Math.max(1, Math.round(idleMs / 3600000)) });
  }

  // air.js 每次 render 递进来的一份上下文（同 air-admin.js / air-directory-mode.js
  // 的 render(ctx)）：快照、当前目录、api、notice，以及「回收完成后重拉快照」。
  function render(context) {
    if (context) ctx = context;
    const section = el('directory-worktrees');
    const body = el('directory-worktree-body');
    if (!section || !body || !ctx) return;
    const directory = (ctx.data?.directories || []).find(item => item.id === ctx.directoryId);
    const life = lifecycleOf(directory);
    // 没选中目录（或目录被删了）、服务端没给拆解、这个目录一个 worktree 都没有：
    // 三种情况都整块收起来，不留一个空壳面板。
    if (!directory || !life || !totalOf(directory, life)) { section.hidden = true; return; }
    section.hidden = false;
    const heading = el('directory-worktree-summary');
    if (heading) {
      const parts = [breakdown(life), life.leased ? translate('airWorktreeLeased', { n: life.leased }) : ''].filter(Boolean);
      heading.textContent = `${parts.join(' · ')} ${recordTotal(totalOf(directory, life))}`;
    }
    const reclaim = node('button', busy ? translate('airWorktreeReclaiming') : translate('airWorktreeReclaim'), 'worktree-reclaim');
    reclaim.type = 'button';
    // 本地一个都没有就没什么可收的 —— 按钮变灰比点下去再说「没有可回收的」诚实。
    reclaim.disabled = busy || !life.onDisk;
    reclaim.onclick = () => void reclaimNow();
    body.replaceChildren(node('p', translate('airWorktreeLifecycleHint'), 'worktree-hint'), node('p', policyText(), 'worktree-policy'), reclaim);
  }

  async function reclaimNow() {
    if (busy || !ctx) return;
    busy = true;
    render();
    try {
      const target = { dirId: ctx.directoryId };
      let answer = await ctx.api('/api/air/worktrees/reclaim', target);
      // 一个都没收到、却确实还有本地 checkout：多半是都没到闲置阈值。这时候
      // 问一句要不要连最近用过的也一起收 —— 只有用户点头才会带 force 再发一次。
      if (answer?.ok !== false && !answer?.hibernated && answer?.considered) {
        if (root.confirm?.(translate('airWorktreeReclaimForce', { n: answer.considered }))) {
          answer = await ctx.api('/api/air/worktrees/reclaim', { ...target, force: true });
        }
      }
      const message = answer?.ok === false ? translate('airWorktreeReclaimFailed', { msg: answer.code || '' })
        : answer?.hibernated ? translate('airWorktreeReclaimDone', { hibernated: answer.hibernated, considered: answer.considered || 0, skipped: answer.skipped || 0 })
          : translate('airWorktreeReclaimEmpty');
      // 先重拉快照再报结果：refresh() 自己会把提示条清空（没有迁移错误时它就是空的），
      // 先说再刷新等于这句回执根本没人看见。刷新后再说，看到的就是「新的数字 + 刚发生
      // 了什么」。
      await ctx.refresh?.();
      ctx.notice?.(message);
    } catch (error) {
      ctx.notice?.(translate('airWorktreeReclaimFailed', { msg: error?.message || error }));
    } finally {
      busy = false;
      render();
    }
  }

  root.MultiCCAirWorktrees = { summary, render, lifecycleOf };
})(typeof window !== 'undefined' ? window : null);
