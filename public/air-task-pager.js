'use strict';
// 目录首页任务清单（`#directory-task-list`）的分页，以及它下面那条 `#directory-task-pager`。
//
// 为什么要有这块：那份清单现在是**完整**的一份（抬头、筛选、分页三行固定，列表自己在
// 这张卡里滚），条数不再由「最近几条」封顶。一个用了半年的目录动辄几百条，全塞进那一个
// 滚动区里，滚轮就成了唯一的刻度 —— 看不出「一共多少条、我翻到哪儿了」。所以一页固定
// 20 条（两列十行，约等于一屏多），翻页一次换一整页，条数与页码写在页码里。
//
// 第二个职责是**那张卡有多高**（分页与它是同一件事：一页装几条，取决于能看见几行）。
// 高度不能写成 CSS 里的 `calc(100dvh - 常数)`：面板上面那段（工具栏 / 配置卡 / 统计卡）
// 是会出现、隐藏、随窗口折行的，减错一个数就是「清单被挤成一条」。所以这里按实测算：
//   面板高 = 滚动口可见高 − 面板上面那一段 − 贴在下沿的输入框占掉的那条带子
// 写进 --directory-task-panel-h。输入框是 sticky 的，那条带子按它当下的实测高度算 ——
// 折起来是一条细杠，展开是整个输入框；代码卡在面板下面，滚到底时归 air.css 的
// margin-top 管（它比 sticky 的 bottom 偏移大一截，最后一行不会压到输入框底下）。
// 触发点：resize、#empty 及其子树的增删（统计卡填数、换目录）、输入框折起/展开、每次渲染。
//
// 为什么是独立文件：air.js 贴着 3000 行的行数闸门（scripts/check-source-line-
// budget.js）。这里只留四个接线点：清单渲染前问一次 `paint(rows)`（它返回这一页要画的
// 行，并把页码画好、顺手量一次高度），筛选/搜索/排序/换目录时 `reset()`，换页后
// `bind(fn)` 收到的那个回调由 air.js 拿去重画列表，窗口变化由这里的观察者自己接。
(function initAirTaskPager(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  // i18n 由 i18n.js 提供；它没加载（单页/旧壳）时退回 key，不至于把界面打空。
  const translate = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);

  // 一页 20 条：两列就是十行，桌面一屏大约正好装下。它不跟着窗口高矮实时算 —— 那样
  // 拖一下窗口「一页」的定义就变了，页码会跟着跳；列表本身仍按剩余高度滚，两件事
  // 各管各的：一页装不下时先滚，滚到底再翻页。
  const PAGE_SIZE = 20;

  // 面板再矮就没有「一屏清单」可言了：抬头 + 筛选条 + 分页条本身要占掉两百来像素，
  // 剩下的才是清单。窗口很矮时宁可整列滚，也不把它压成一条缝。
  const FLOOR = 360;
  // 面板下沿与输入框之间留的一条缝：贴在一起看像是清单被输入框切断了。
  const GAP = 14;
  const PANEL_VAR = '--directory-task-panel-h';
  const PHONE = typeof root.matchMedia === 'function' ? root.matchMedia('(max-width: 760px)') : null;

  let page = 1;
  let pages = 1;
  let onChange = null;

  /** 输入框在滚动口底部占掉的那条带子（`emptyBottom − 输入框上沿`，再加一条缝）。
   *  它在 #empty 里是 sticky 的：贴在滚动口下沿、内容从它底下滚过去，所以它固定占着
   *  视口最下面那一条（滚不滚它都在那儿），面板得停在它上面，否则分页条就被它压住了。
   *  折起来是一条细杠、展开是整个输入框，所以必须实测；它被搬进「＋ 新任务」弹窗时
   *  不在这一列里，那条带子是 0；这一列还装得下、输入框压根不在视口里时也是 0。 */
  function composerBand(empty) {
    const form = el('quick-task-form');
    if (!form || !empty.contains(form)) return 0;
    const height = form.getBoundingClientRect().height;
    if (!height) return 0;
    return Math.max(0, empty.getBoundingClientRect().bottom - form.getBoundingClientRect().top) + GAP;
  }

  let lastPanel = '';
  function write(value) {
    // 同一个值不重复写：观察者会在每次渲染时回来，写同一个值等于白标一次 dirty。
    if (value === lastPanel) return;
    lastPanel = value;
    if (value) document.documentElement.style.setProperty(PANEL_VAR, value);
    else document.documentElement.style.removeProperty(PANEL_VAR);
  }

  /** 量一次，把面板高度写到 :root 的变量上。 */
  function measure() {
    const empty = el('empty');
    if (!empty || !empty.clientHeight) return;
    // 手机上清单不抢高度（air.css 的 760px 断点里 height: auto 压过这条变量），
    // 把变量交回去，免得两条规则各说各话。
    if (PHONE && PHONE.matches) { write(''); return; }
    const panel = empty.querySelector('.directory-task-panel');
    if (!panel || root.getComputedStyle(panel).display === 'none') return;
    const style = root.getComputedStyle(empty);
    const padTop = parseFloat(style.paddingTop) || 0;
    // 面板上沿距滚动口上沿的距离，换算到内容坐标（与当前滚到哪儿无关）
    const rect = empty.getBoundingClientRect();
    const above = panel.getBoundingClientRect().top - rect.top - empty.clientTop - padTop + empty.scrollTop;
    // 滚动口里能分给面板的高度：可见高 − 上方那一段 − 贴在下沿的输入框。
    const room = empty.clientHeight - padTop - above - composerBand(empty);
    write(`${Math.round(Math.max(FLOOR, room))}px`);
  }

  // 观察者：窗口/这一列/输入框的尺寸变化，以及 #empty 子树的增删（统计卡填数、配置卡
  // 出现、换目录整列重画）。都在一帧里只读一次布局，写回的是同一批变量，不会自己触发
  // 自己 —— 面板高度不改变它上面那一段，也不改变输入框的高度。
  function watch() {
    const empty = el('empty');
    if (!empty) return;
    root.addEventListener('resize', measure);
    if (PHONE) PHONE.addEventListener('change', measure);
    if (typeof root.ResizeObserver === 'function') {
      const observer = new root.ResizeObserver(measure);
      observer.observe(empty);
      const form = el('quick-task-form');
      if (form) observer.observe(form);
    }
    if (typeof root.MutationObserver === 'function') {
      new root.MutationObserver(measure).observe(empty, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    }
  }

  // 当前页的切片。页码越界（筛完只剩两页，而人停在第 5 页）时自己夹回范围内，所以
  // 调用方不需要知道筛选前后条数变了多少。
  function view(rows) {
    const list = rows || [];
    pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * PAGE_SIZE;
    return { items: list.slice(start, start + PAGE_SIZE), page, pages, total: list.length };
  }

  /** 画分页条并返回这一页的行。只有一页时整条收起 —— 一颗按不动的「下一页」加上
   *  「第 1 / 1 页」只是页脚上多出来的一行噪声。顺带量一次高度：每次渲染后那张卡的
   *  高度都是最新的（筛选条可能折行、分页条可能收起）。 */
  function paint(rows) {
    const state = view(rows);
    const bar = el('directory-task-pager');
    if (bar) {
      bar.hidden = state.pages <= 1;
      const label = el('directory-task-page');
      if (label) label.textContent = translate('airTaskPageOf', { page: state.page, total: state.pages });
      const prev = el('directory-task-prev');
      const next = el('directory-task-next');
      if (prev) prev.disabled = state.page <= 1;
      if (next) next.disabled = state.page >= state.pages;
    }
    measure();
    return state.items;
  }

  /** 回到第一页。筛选、搜索、排序、换目录都算「换了一份清单」——停在原来的页码上
   *  看到的是另一批任务，那不叫翻页，叫换了个列表。 */
  function reset() { page = 1; }

  function go(delta) {
    const target = page + delta;
    if (target < 1 || target > pages) return;
    page = target;
    // 换页必须从第一行读起：新一页的第十行不该接着上一页的滚动位置出现在屏幕中间。
    const list = el('directory-task-list');
    if (list) list.scrollTop = 0;
    if (onChange) onChange();
  }

  const prev = el('directory-task-prev');
  const next = el('directory-task-next');
  if (prev) prev.onclick = () => go(-1);
  if (next) next.onclick = () => go(1);

  watch();
  measure();

  root.MultiCCAirTaskPager = {
    PAGE_SIZE,
    reset,
    view,
    paint,
    measure,
    bind: handler => { onChange = handler; },
  };
})(typeof window !== 'undefined' ? window : null);
