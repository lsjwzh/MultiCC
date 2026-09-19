(function (root) {
  'use strict';

  // 侧栏「最近任务」换位用的三件小工具：点击当下把卡片抬起来、重排前量一次
  // 位置、重排后把每行从旧位置动画回新位置（FLIP）。它们只认 `data-task` 和一
  // 次 `getBoundingClientRect`，不读任何全局状态，所以控制台那份列表将来也能
  // 直接用同一套。
  //
  // 为什么不是「重排之后加个入场动画」：换位是「同一张卡换了地方」，只有先量
  // 旧位置才知道它要从哪儿出发。位移也全部走 `transform`（外加一次 opacity），
  // 不碰任何会触发重排/重绘的属性 —— 和彩虹圈那次改动同一个理由：逐帧重排布局
  // 的属性会把 CPU 吃满，而 transform/opacity 是合成器接管的。

  const LIFT = 'is-lifting';
  const MOVING = 'is-reordering';
  const FLYING = 'is-flying';
  const COLLAPSING = 'is-collapsing';
  const EASE = 'cubic-bezier(.22,.68,.24,1)';

  function rows(container) {
    if (!container) return [];
    return Array.from(container.children || []).filter(el => el && el.dataset && el.dataset.task);
  }

  function rowById(container, id) {
    if (!id) return null;
    return rows(container).find(el => el.dataset.task === id) || null;
  }

  function toggleClass(el, name, on) {
    const list = el && el.classList;
    if (!list) return;
    if (on) list.add(name); else list.remove(name);
  }

  function rectOf(el) {
    return el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  }

  /** 量一次：taskId → {top,left}。重排前量的是起点，重排后量的是终点。 */
  function capture(container) {
    const rects = new Map();
    for (const el of rows(container)) {
      const rect = rectOf(el);
      if (!rect) continue;
      rects.set(el.dataset.task, { top: rect.top, left: rect.left });
    }
    return rects;
  }

  /** 纯几何：起点和终点各一份，算出谁要往哪儿走。位移小于半像素的不算动过
   *  （亚像素抖动不该换来一次过渡），新出现的行（起点里没有）也不参与。 */
  function moves(before, after) {
    const list = [];
    for (const [id, rect] of after || []) {
      const prev = before && typeof before.get === 'function' ? before.get(id) : null;
      if (!prev || !rect) continue;
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      list.push({ id, dx, dy });
    }
    return list;
  }

  /** 点击当下把这张卡抬起来 —— 换位要晚一拍发生，这一拍里得先有个反应。
   *  只加类：位置由 play() 的 transform 负责，两处都动 transform 会互相打架。 */
  function lift(container, id) { toggleClass(rowById(container, id), LIFT, true); }

  function clear(container, id) {
    const el = rowById(container, id);
    for (const name of [LIFT, MOVING, FLYING, COLLAPSING]) toggleClass(el, name, false);
  }

  /** 列表顶端那个槽位此刻是否还看得见。它决定卡片是「飞上去」还是「就地收掉」：
   *  那个槽位整条都缩到带子上沿以外时，飞过去等于凭空消失，不如就地收掉。
   *  判据取槽位的底边而不是顶边 —— 露出半条也算看得见，这时候飞上去是对的。 */
  function topSlotVisible(container) {
    const first = rows(container)[0];
    const band = rectOf(container);
    const slot = rectOf(first);
    if (!first || !band || !slot) return false;
    return slot.bottom > band.top + 1;
  }

  /**
   * 重排之后调用：把每行从旧位置 FLIP 到新位置。
   * `flight:false` 时被抽出的那张卡停在原地淡出（它要去的槽位在屏幕外）。
   * 返回真正动过的行数 —— 没有位移就没有动画，调用方和测试都据此判断。
   */
  function play(container, before, options = {}) {
    const liftId = options.liftId || null;
    const duration = Number(options.duration) || 260;
    const flight = options.flight !== false;
    const collapseMs = Math.min(duration, 180);
    const steps = [];
    for (const move of moves(before, capture(container))) {
      const el = rowById(container, move.id);
      if (!el) continue;
      steps.push({ el, dx: move.dx, dy: move.dy, lifted: move.id === liftId, offstage: false });
    }
    // 没有任何位移（重排没换到位置、或者行已经不在这一列里）：不留动画，也不让
    // 抬起那张永远悬着 —— 这里返回 0 之后调用方不会再碰它。
    if (!steps.length) { if (liftId) clear(container, liftId); return 0; }

    for (const move of steps) {
      const style = move.el.style || (move.el.style = {});
      // 每一行都先站到「自己原来那个位置」上。要飞的那张随后走 transform 回新槽；
      // 目的地已经滚出屏幕的那张（offstage）就停在这儿淡掉 —— 它真正的落点在
      // 屏幕外，让它飞过去谁也看不见，就地收掉才看得到「这张卡被抽走了」。
      move.offstage = move.lifted && !flight;
      style.transition = 'none';
      style.transform = `translate(${move.dx}px, ${move.dy}px)`;
      toggleClass(move.el, MOVING, true);
      if (move.lifted) toggleClass(move.el, move.offstage ? COLLAPSING : FLYING, true);
    }
    // 读一次布局：让上面写下的起点真的生效，否则下面改成终点会被合并成一步。
    void (container && container.offsetHeight);
    for (const move of steps) {
      const style = move.el.style;
      if (move.offstage) {
        // 只让透明度走过渡：位置留在原地，宽度/高度不参与，收尾也不留空档。
        style.transition = `opacity ${collapseMs}ms ease-out`;
        style.opacity = '0';
      } else {
        style.transition = `transform ${duration}ms ${EASE}`;
        style.transform = '';
      }
    }

    const settle = () => {
      for (const move of steps) {
        const style = move.el.style;
        if (style) { style.transition = ''; style.transform = ''; style.opacity = ''; }
        toggleClass(move.el, MOVING, false);
        toggleClass(move.el, FLYING, false);
        toggleClass(move.el, COLLAPSING, false);
      }
    };
    const timer = setTimeout(settle, duration + 90);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return steps.length;
  }

  const api = { capture, moves, lift, clear, play, topSlotVisible, rowById };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCTaskMotion = api;
})(typeof window !== 'undefined' ? window : globalThis);
