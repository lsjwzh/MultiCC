'use strict';

// ── 目录首页「本目录产物」入口（public/air-artifacts.js）──────────────────────
// 「服务与文档」面板（air-admin.js 的 docs 一栏）是跨目录的一览：它回答「这台机器
// 上有哪些产物」。目录首页要回答的是另一个问题 ——「我正看着的**这个**目录里有什么」。
// 入口就摆在目录工具条的「备忘」旁边（最右两颗），点开是那一页：
//
//     window.open('/artifacts.html?dirId=<目录 id>')
//
// 清单本身是一张**单独的页面**（public/artifacts.html + air-artifacts-page.js），
// 跟「备忘」(/memo.html?dirId=…) 一个模式 —— 也是 App 那边的做法
// （app/lib/screens/directory_artifacts_screen.dart）。以前它是在目录页里展开的内联
// 区块（#directory-artifacts-panel）：展开会把「最近任务 / Git / 新任务输入框」整段
// 往下推，而产物是要一边看一边点开的东西（网页 / 文件 / 永久保留 / 置顶），本来就该
// 有自己的地址，可以单独开着、单独刷新。
//
// 所以这个模块现在只做一件事：接线那颗按钮。数据、PATCH、排序全在那一页里。
// 它同样不改 air.js 一个字节 —— 自己找 #directory-memo、自己插按钮、自己盯显隐。
(function initAirArtifactsEntry(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  let toggle = null;
  const dirIdOf = () => new URLSearchParams(root.location.search).get('dir');

  function openPage() {
    const dirId = dirIdOf();
    if (!dirId) return;
    // noopener：那一页是独立文档，不需要回头操作这一页（同 air.js 打开备忘的写法）。
    root.open(`/artifacts.html?dirId=${encodeURIComponent(dirId)}`, '_blank', 'noopener');
  }

  function mount() {
    const memo = document.getElementById('directory-memo');
    if (!memo || !memo.parentElement || document.getElementById('directory-artifacts')) return;
    toggle = node('button', null, null);
    toggle.type = 'button';
    toggle.id = 'directory-artifacts';
    toggle.setAttribute('data-i18n-title', 'airDirArtifactsOpen');
    toggle.setAttribute('data-i18n-aria-label', 'airDirArtifactsOpen');
    toggle.title = t('airDirArtifactsOpen');
    toggle.setAttribute('aria-label', t('airDirArtifactsOpen'));
    const glyph = node('span', '📦');
    glyph.setAttribute('aria-hidden', 'true');
    // data-i18n 挂在内层标签上，不挂按钮：applyI18n() 给带 data-i18n 的元素写
    // textContent，挂在按钮上会把前面的图标一起冲掉。目录工具条里「新终端」那颗
    // （air.html 的 #directory-terminal-new）就是这么分的。
    const label = node('span', t('airDirArtifacts'));
    label.setAttribute('data-i18n', 'airDirArtifacts');
    toggle.append(glyph, document.createTextNode(' '), label);
    toggle.onclick = openPage;
    // 插在「备忘」后面：工具条的 margin-left:auto 在备忘身上，两颗一起贴着右边界，
    // 产物是最右那颗（顺序由 DOM 定，见 air.css 里 .directory-toolbar 那段注释）。
    memo.after(toggle);

    // 为什么这里要看 DOM 而不是在 air.js 里加一行：public/air.js 卡在行数棘轮的
    // 天花板上（scripts/check-source-line-budget.js 里登记的高水位就是它当前的行数，
    // 加一行即红），所以入口的显隐只能从外面接。air.js 每次渲染都会写
    // `$('directory-memo').hidden`（没目录 / 不在任务视图 / 选中了某条任务时为 true），
    // 产物入口要跟备忘入口一模一样地出现和消失 —— 盯住这个属性就够了，不轮询。
    const observer = new root.MutationObserver(() => {
      if (!toggle) return;
      const memoNow = document.getElementById('directory-memo');
      toggle.hidden = !memoNow || memoNow.hidden;
    });
    observer.observe(memo, { attributes: true, attributeFilter: ['hidden'] });
    // 首次同步：脚本在 air.js 之前解析，那时 #directory-memo 还是 HTML 里的初始
    // 可见状态，等 air.js 第一次渲染会补一次 mutation，但这一次不能省
    // —— 目录页以外的路径（比如 /air?view=docs）本来就不该露出这个入口。
    toggle.hidden = memo.hidden;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})(typeof window !== 'undefined' ? window : null);
