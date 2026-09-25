'use strict';

// Air 原生「临时上传」面板 —— 上传缓存这份磁盘占用（原生 DOM，不再嵌旧 manage 页）。
// 后端契约见 src/routes/file-transfer.js：GET /api/uploads/stats 读扫描结果
// （{ count, totalSize, dir }，另外还带一份 files 明细，这一页不用），
// DELETE /api/uploads/cleanup 删掉临时目录里那批 multicc_* 文件。
//
// 这一页是只读的三行数字 + 一个不可逆的删除按钮，所以两条红线：
//   ① 数字永远来自服务端的扫描，不在前端自己算（临时目录会被别的进程动）；
//   ② 清理必须先问一句、且问句里写清后果 —— 这是唯一一个按一下就真删文件的按钮。
//
// 它跟「设置中心」里的另外两格存储类面板同一层：入口在设置中心第四组，渲染走
// air-admin.js 那张 nativePanels 表（mode=storage），工具条的返回/刷新由它装。
(function initAirStorage(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  // 数字格式的唯一来源（shared/format.js，页面里先于本文件加载）。Node 侧的沙箱里
  // 没有页面全局，也没有 require，所以三种取法都留着 —— 测试要么注入
  // MultiCCFormat，要么让它落到 require 上。
  const FMT = (typeof window !== 'undefined' && window.MultiCCFormat)
    || (typeof globalThis !== 'undefined' && globalThis.MultiCCFormat)
    || (typeof require === 'function' ? require('./shared/format.js') : null);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };

  // render(host, context) 每进一次面板就重建 DOM，所以回调里要用的 context 只能存
  // 在模块上（同 air-secrets.js）；最近一次统计也留一份，「清理前」的问句和失败后的
  // 按钮状态都要读它。
  let context = null;
  let stats = { count: 0, totalSize: 0, dir: '' };
  let styleNode = null;

  // 样式跟模块走：这一页是后加的，不去动 air.css（那份是外壳和各面板共用的）。
  // 颜色只用 Air v2 的词表（--hairline / --muted / --faint / --shadow-1）。
  function injectStyle(host) {
    if (!styleNode) {
      styleNode = document.createElement('style');
      styleNode.textContent = `
        .air-storage-panel { display: grid; gap: 14px; }
        .air-storage-rows { display: grid; gap: 8px; }
        .air-storage-row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px;
          padding: 11px 13px; border: 1px solid var(--hairline); border-radius: 12px; background: #fff; box-shadow: var(--shadow-1); }
        .air-storage-row-dir { align-items: flex-start; }
        .air-storage-label { flex: 0 0 auto; color: var(--muted); font-size: 10.5px; }
        .air-storage-value { min-width: 0; color: #2f536f; font-size: 12px; font-weight: 650; text-align: right; }
        /* 目录是全页最长的一串字符：等宽字体 + 任意位置可断，宁可折行也不横着溢出。 */
        .air-storage-dir { flex: 1; font-family: var(--mono, monospace); font-size: 10.5px; font-weight: 500;
          overflow-wrap: anywhere; word-break: break-all; }
        .air-storage-foot { display: flex; align-items: center; gap: 10px; }
        .air-storage-foot button { min-height: 32px; padding: 5px 11px; font-size: 11px; }
        .air-storage-status { min-width: 0; color: var(--faint); font-size: 10.5px; overflow-wrap: anywhere; }
      `;
    }
    host.append(styleNode); // replaceChildren 会把它一起清掉，每次重绘都挂回去
  }

  // 字节数走全站唯一那份（shared/format.js）：一位小数、1024 进制、超过 TB 才停 ——
  // 临时目录堆到一个 G 的缓存不是不可能，那时候不该显示成「1024.0 MB」。本页只保留
  // 「没有值时画 0 B」这一处取舍。不走 i18n：单位是符号，不是句子。
  const STORAGE_SIZE = Object.freeze({ placeholder: '0 B' });

  // valueClass 只有目录那一行要用（等宽 + 可断行）；另外两行是短数字，走默认值样式。
  function row(labelText, valueId, valueClass = '') {
    const line = make('div', null, `air-storage-row${valueClass ? ' air-storage-row-dir' : ''}`);
    const value = make('span', '—', `air-storage-value${valueClass ? ` ${valueClass}` : ''}`);
    value.id = valueId;
    line.append(make('span', labelText, 'air-storage-label'), value);
    return line;
  }

  function paint() {
    const count = el('air-storage-count');
    if (count) count.textContent = t('airStorageCount', { n: stats.count });
    const size = el('air-storage-size');
    if (size) size.textContent = FMT.formatBytes(stats.totalSize, STORAGE_SIZE);
    const dir = el('air-storage-dir');
    if (dir) dir.textContent = stats.dir || '—';
    // 没有文件就没什么可清：按钮灰掉，并补一句为什么 —— 灰按钮自己不会解释。
    const button = el('air-storage-cleanup');
    if (button) button.disabled = stats.count === 0;
    const empty = el('air-storage-empty');
    if (empty) empty.hidden = stats.count > 0;
  }

  // keepResult：清理成功后的那句结果要活过紧接着的这一次重读（见 cleanup），
  // 只有手动刷新（工具条那颗）和首次进页面才把状态行清空。
  async function load(keepResult = false) {
    const status = el('air-storage-status');
    try {
      const data = await context.api('/api/uploads/stats');
      stats = {
        count: Number(data?.count) || 0,
        totalSize: Number(data?.totalSize) || 0,
        dir: String(data?.dir || ''),
      };
      paint();
      if (status && !keepResult) status.textContent = '';
    } catch (error) {
      if (status) status.textContent = t('airAdminLoadFailed', { message: error.message || String(error) });
    }
  }

  async function cleanup() {
    const status = el('air-storage-status');
    const button = el('air-storage-cleanup');
    // 问句里要带上「几个文件」和「删了回不来」：这是唯一一个按一下就真删的按钮。
    const question = `${t('airStorageCleanupTitle', { n: stats.count })}\n\n${t('airStorageCleanupBody')}`;
    if (!root.confirm(question)) return;
    if (button) button.disabled = true; // 应答期间再点一下不该发第二个请求
    if (status) status.textContent = t('airStorageCleaning');
    try {
      const result = await context.api('/api/uploads/cleanup', undefined, 'DELETE');
      if (status) status.textContent = t('airStorageCleanupDone', {
        deleted: Number(result?.deleted) || 0,
        freed: FMT.formatBytes(result?.freed, STORAGE_SIZE),
      });
      await load(true); // 删完的数字以服务端重扫为准：结果那句话留在状态行上
    } catch (error) {
      if (status) status.textContent = t('airStorageCleanupFailed', { message: error.message || String(error) });
      if (button) button.disabled = stats.count === 0;
    }
  }

  function render(host, ctx) {
    context = ctx;
    const panel = make('section', null, 'admin-panel air-storage-panel');
    const head = make('div', null, 'admin-panel-head');
    const title = make('div');
    title.append(make('span', 'STORAGE', 'eyebrow'), make('h3', t('airStorageTitle')));
    head.append(title, make('span', t('airStorageHint'), 'admin-panel-note'));

    const button = make('button', t('airStorageCleanup'), 'danger');
    button.type = 'button';
    button.id = 'air-storage-cleanup';
    button.disabled = true; // 统计没回来之前不知道能不能清，先按住
    button.onclick = () => cleanup();
    const status = make('span', '', 'air-storage-status');
    status.id = 'air-storage-status';
    const foot = make('div', null, 'air-storage-foot');
    foot.append(button, status);

    const rows = make('div', null, 'air-storage-rows');
    rows.append(
      row(t('airStorageFiles'), 'air-storage-count'),
      row(t('airStorageTotalSize'), 'air-storage-size'),
      row(t('airStorageLocation'), 'air-storage-dir', 'air-storage-dir'),
    );
    const empty = make('p', t('airStorageEmpty'), 'admin-empty');
    empty.id = 'air-storage-empty';
    empty.hidden = true;
    panel.append(head, rows, foot, empty);

    host.replaceChildren(panel);
    injectStyle(host);
    void load();
  }

  root.MultiCCAirStorage = Object.freeze({ render, refresh: () => load() });
})(typeof window !== 'undefined' ? window : null);
