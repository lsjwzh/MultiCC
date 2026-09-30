'use strict';

/* 会话交接包（handoff bundle）的 web 入口：导出与导入两个对话框，挂在聊天页
   的「分享会话」卡片里。

   独立文件：public/chat.js 是 3000 行棘轮文件（只减不增），这两个对话框合起来
   两百来行放不下。三层载荷（env 执行环境 / context 上下文 / code 代码）各自的
   落点写在 docs/session-environment-handoff.md；这里只把接口变成能点的界面，
   不复制任何判定 —— 代码层同不同仓库由服务端 sameRepository 说了算，界面上
   因此没有 git 开关，只有一个「只导执行环境」。 */

(function installChatHandoff(root) {
  const OVERLAY_STYLE = 'position:fixed;inset:0;background:var(--chat-overlay, rgba(0,0,0,.7));z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
  const BOX_STYLE = 'background:var(--chat-surface, #161b22);border:1px solid var(--chat-line, #30363d);border-radius:12px;padding:18px;width:560px;max-width:94vw;max-height:90vh;overflow:auto;color:var(--chat-text, #c9d1d9);';
  const FIELD_STYLE = 'width:100%;box-sizing:border-box;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:7px 9px;';
  const BUTTON_STYLE = 'background:var(--chat-soft, #21262d);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:6px 14px;cursor:pointer;';
  const PRIMARY_STYLE = 'background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:7px 14px;cursor:pointer;';
  const MUTED = 'color:var(--chat-muted, #8b949e);';
  const DANGER = 'color:var(--chat-danger, #f85149);';
  const SUCCESS = 'color:var(--chat-success, #3fb950);';

  // 执行环境是全量的：machine / cli / shared 这三层本来就是「别的会话也在读」的
  // 层，少带一层就不是复刻环境了。context / code 层由 context=0、git=0 单独关。
  const EXPORT_SCOPES = 'session,shared,task,cli,machine';
  const MIN_PASSPHRASE = 6;
  const ZIP_MAGIC = [0x50, 0x4b];

  function tt(key, params, fallback) {
    const out = typeof root.t === 'function' ? root.t(key, params) : '';
    return out && out !== key ? out : (fallback === undefined ? key : fallback);
  }

  // 转义只有一份实现：shared/dom-helpers.js，chat.html 在本模块之前就加载了它，
  // 所以这里直接委托，不再抄一份（tests/test-dom-helpers-escape.js 盯着这件事）。
  function esc(value) { return escapeHtml(value); }

  function size(bytes) {
    const format = root.MultiCCFormat;
    return format && typeof format.formatBytes === 'function' ? format.formatBytes(bytes) : `${bytes} B`;
  }

  function errorApi() { return root.MultiCCApi || null; }

  function errorText(error) {
    const api = errorApi();
    if (api && typeof api.errorText === 'function') {
      try { return api.errorText(error); } catch (_) { /* fall through */ }
    }
    return error && error.message ? error.message : String(error);
  }

  async function bodyErrorText(response) {
    const text = await response.text().catch(() => '');
    try { return JSON.parse(text).error || text || `${response.status}`; } catch (_) { return text || `${response.status}`; }
  }

  function openDialog({ title, desc, html, onMount }) {
    const overlay = root.document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;
    const box = root.document.createElement('div');
    box.style.cssText = BOX_STYLE;
    box.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:4px;">${esc(title)}</div>
      <div style="font-size:12px;${MUTED}line-height:1.6;margin-bottom:12px;">${desc}</div>
      ${html}
      <div data-role="msg" style="font-size:12px;min-height:18px;margin-top:10px;line-height:1.6;white-space:pre-wrap;"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px;"><button data-role="close" style="${BUTTON_STYLE}">${esc(tt('close', null, '关闭'))}</button></div>`;
    overlay.appendChild(box);
    root.document.body.appendChild(overlay);
    const close = () => overlay.remove();
    box.querySelector('[data-role="close"]').onclick = close;
    overlay.onclick = (event) => { if (event.target === overlay) close(); };
    const msg = box.querySelector('[data-role="msg"]');
    const say = (text, style) => { msg.textContent = text; msg.style.cssText = `font-size:12px;min-height:18px;margin-top:10px;line-height:1.6;white-space:pre-wrap;${style || ''}`; };
    onMount({ box, close, say });
    return { box, close };
  }

  function busy(box, isBusy, label) {
    box.querySelectorAll('button').forEach((button) => {
      if (button.dataset.role === 'close') return;
      button.disabled = isBusy;
      if (isBusy && button.dataset.idle === undefined) button.dataset.idle = button.textContent;
      if (isBusy && label) button.textContent = label;
      else if (button.dataset.idle !== undefined) { button.textContent = button.dataset.idle; delete button.dataset.idle; }
    });
  }

  // ── 导出 ──────────────────────────────────────────────────────────────────

  function exportUrl(sessionId, { passphrase, envOnly }) {
    const query = new URLSearchParams({ passphrase, scopes: EXPORT_SCOPES, skillsMode: 'auto' });
    if (envOnly) { query.set('context', '0'); query.set('git', '0'); }
    return `/api/sessions/${encodeURIComponent(sessionId)}/bundle.zip?${query}`;
  }

  // 文件名由服务端给（导出时间戳，故意不含会话 id）；这里只留下安全字符，
  // 不让一个响应头决定落到用户磁盘上的名字。
  function downloadName(response, fallback) {
    const header = (response.headers && response.headers.get('content-disposition')) || '';
    const match = /filename="?([^";]+)"?/i.exec(header);
    const name = match ? decodeURIComponent(match[1]).trim() : '';
    return /^[\w.-]+\.zip$/.test(name) ? name : fallback;
  }

  async function runExport({ sessionId, passphrase, envOnly }) {
    const response = await root.fetch(exportUrl(sessionId, { passphrase, envOnly }), { method: 'GET' });
    if (!response.ok) throw new Error(await bodyErrorText(response));
    const blob = await response.blob();
    const name = downloadName(response, `multicc-handoff-${Date.now()}.zip`);
    const url = URL.createObjectURL(blob);
    const anchor = root.document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    root.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { name, bytes: blob.size };
  }

  function openExportDialog({ sessionId }) {
    if (!sessionId) return;
    openDialog({
      title: tt('handoffExport', null, '导出交接包'),
      desc: esc(tt('handoffExportDesc', null,
        '把这台机器的执行环境（技能 / 各层记忆 / 项目文档）连同会话上下文打成一个加密包。')),
      html: `
        <label style="display:block;font-size:12px;${MUTED}margin-bottom:4px;">${esc(tt('handoffPassphrase', null, '口令（≥6 位）'))}</label>
        <input data-role="pass" type="password" autocomplete="new-password" style="${FIELD_STYLE}margin-bottom:10px;">
        <label style="display:flex;gap:6px;align-items:center;font-size:12px;${MUTED}cursor:pointer;">
          <input data-role="envonly" type="checkbox"> ${esc(tt('handoffEnvOnly', null, '只导执行环境（不带聊天历史与对话附件）'))}
        </label>
        <div style="display:flex;justify-content:flex-end;margin-top:12px;">
          <button data-role="go" style="${PRIMARY_STYLE}">${esc(tt('handoffExportRun', null, '打包并下载'))}</button>
        </div>`,
      onMount({ box, say }) {
        const pass = box.querySelector('[data-role="pass"]');
        const envOnly = box.querySelector('[data-role="envonly"]');
        box.querySelector('[data-role="go"]').onclick = async () => {
          const passphrase = pass.value;
          if (passphrase.length < MIN_PASSPHRASE) {
            say(tt('handoffNeedPassphrase', null, '口令至少 6 位。'), DANGER);
            return;
          }
          busy(box, true, tt('handoffExporting', null, '正在打包…'));
          say(tt('loading', null, '加载中…'), MUTED);
          try {
            const result = await runExport({ sessionId, passphrase, envOnly: envOnly.checked });
            say(tt('handoffExportDone', { name: result.name, size: size(result.bytes) },
              `已下载 ${result.name}（${size(result.bytes)}）。把文件和口令一起交给队友。`), SUCCESS);
          } catch (error) {
            say(errorText(error), DANGER);
          } finally {
            busy(box, false);
          }
        };
      },
    });
  }

  // ── 导入 ──────────────────────────────────────────────────────────────────

  // zip 与 JSON 两种容器都能收：zip 走 import-zip（原始字节），JSON 走 import
  // （解出来再补上落地参数）。按魔数判断，不信文件扩展名。
  function isZip(bytes) {
    return bytes.length > 1 && bytes[0] === ZIP_MAGIC[0] && bytes[1] === ZIP_MAGIC[1];
  }

  function importQuery({ passphrase, target, dirId, targetSessionId }) {
    const query = new URLSearchParams({ passphrase });
    if (target === 'env') query.set('envOnly', '1');
    else if (target === 'merge') query.set('targetSessionId', targetSessionId);
    else query.set('dirId', dirId);
    return query;
  }

  async function readJsonResponse(response) {
    const text = await response.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!response.ok) throw new Error((data && data.error) || text || `${response.status}`);
    return data;
  }

  async function runImport({ file, passphrase, target, dirId, targetSessionId }) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const query = importQuery({ passphrase, target, dirId, targetSessionId });
    if (isZip(bytes)) {
      const response = await root.fetch(`/api/sessions/import-zip?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes,
      });
      return readJsonResponse(response);
    }
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    const body = Object.assign({}, payload, { passphrase });
    if (target === 'env') body.envOnly = true;
    else if (target === 'merge') body.targetSessionId = targetSessionId;
    else body.dirId = dirId;
    const response = await root.fetch('/api/sessions/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return readJsonResponse(response);
  }

  function memoryCounts(scopes) {
    let written = 0;
    let skipped = 0;
    const unresolved = [];
    for (const [scope, entry] of Object.entries(scopes || {})) {
      written += Array.isArray(entry && entry.written) ? entry.written.length : 0;
      const skipList = Array.isArray(entry && entry.skipped) ? entry.skipped : [];
      skipped += skipList.length;
      // name '*' 是「整个 scope 在这台机器上没有落点」，与「同名文件本机已有」
      // 这种逐文件跳过不是一回事：前者用户必须知道。
      for (const item of skipList) {
        if (item && item.name === '*' && item.reason) unresolved.push(`${scope}: ${item.reason}`);
      }
    }
    return { written, skipped, unresolved };
  }

  function reportText(body) {
    const restored = (body && body.restored) || {};
    const memory = memoryCounts(restored.memoryScopes);
    const modeLabel = body.mode === 'env' ? tt('handoffTargetEnv', null, '只装执行环境')
      : body.mode === 'merge' ? tt('handoffTargetMerge', null, '并入当前会话')
        : tt('handoffTargetNew', null, '新建一个会话');
    const lines = [tt('handoffImportDone', { mode: modeLabel }, `导入完成 · ${modeLabel}`)];
    if (body.sessionId) lines.push(tt('handoffReportSession', { id: body.sessionId }, `会话：${body.sessionId}`));
    if (restored.messages) lines.push(tt('handoffReportMessages', { n: restored.messages }, `上下文：${restored.messages} 条历史消息`));
    lines.push(tt('handoffReportMemory', { written: memory.written, skipped: memory.skipped },
      `记忆：写入 ${memory.written}，跳过 ${memory.skipped}`));
    for (const reason of memory.unresolved) lines.push(reason);
    if (Array.isArray(restored.skills) && restored.skills.length) {
      lines.push(tt('handoffReportSkills', { n: restored.skills.length }, `技能：${restored.skills.length}`)
        + ' — ' + restored.skills.map((skill) => `${skill.name} (${skill.status})`).join(', '));
    }
    if (restored.assets && restored.assets.restored) {
      lines.push(tt('handoffReportAssets', { n: restored.assets.restored }, `对话附件：${restored.assets.restored}`));
    }
    if (restored.gitRestored) lines.push(tt('handoffReportGitOk', null, '代码层：源分支独有的提交已 replay 到目标 worktree'));
    else if (restored.gitNote) lines.push(tt('handoffReportGit', { note: restored.gitNote }, `代码层：${restored.gitNote}`));
    return lines.join('\n');
  }

  async function loadDirectories() {
    const response = await root.fetch('/api/directories');
    if (!response.ok) throw new Error(await bodyErrorText(response));
    const data = await response.json();
    return Array.isArray(data) ? data : (data && Array.isArray(data.directories) ? data.directories : []);
  }

  function openImportDialog({ currentSessionId } = {}) {
    openDialog({
      title: tt('handoffImport', null, '导入交接包'),
      desc: esc(tt('handoffImportDesc', null,
        '执行环境按原来的 scope 落回本机（同名文件以本机为准）；上下文与代码层要选一个落点。')),
      html: `
        <label style="display:block;font-size:12px;${MUTED}margin-bottom:4px;">${esc(tt('handoffPickFile', null, '选择文件（.zip 或 .json）'))}</label>
        <input data-role="file" type="file" accept=".zip,.json,application/zip,application/json" style="${FIELD_STYLE}margin-bottom:10px;">
        <label style="display:block;font-size:12px;${MUTED}margin-bottom:4px;">${esc(tt('handoffPassphrase', null, '口令（≥6 位）'))}</label>
        <input data-role="pass" type="password" autocomplete="off" style="${FIELD_STYLE}margin-bottom:10px;">
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;font-size:13px;">
          <label style="display:flex;gap:6px;align-items:center;cursor:pointer;"><input data-role="target" type="radio" name="ho-target" value="env" checked> ${esc(tt('handoffTargetEnv', null, '只装执行环境（技能 + 记忆，不建会话）'))}</label>
          <label style="display:flex;gap:6px;align-items:center;cursor:pointer;"><input data-role="target" type="radio" name="ho-target" value="new"> ${esc(tt('handoffTargetNew', null, '新建一个会话'))}</label>
          ${currentSessionId ? `<label style="display:flex;gap:6px;align-items:center;cursor:pointer;"><input data-role="target" type="radio" name="ho-target" value="merge"> ${esc(tt('handoffTargetMerge', null, '并入当前会话'))}</label>` : ''}
        </div>
        <div data-role="dirrow" hidden style="margin-bottom:4px;">
          <label style="display:block;font-size:12px;${MUTED}margin-bottom:4px;">${esc(tt('handoffTargetDir', null, '目标目录'))}</label>
          <select data-role="dir" style="${FIELD_STYLE}"><option>${esc(tt('loading', null, '加载中…'))}</option></select>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:12px;">
          <button data-role="go" style="${PRIMARY_STYLE}">${esc(tt('handoffImportRun', null, '导入'))}</button>
        </div>`,
      onMount({ box, say }) {
        const file = box.querySelector('[data-role="file"]');
        const pass = box.querySelector('[data-role="pass"]');
        const dirRow = box.querySelector('[data-role="dirrow"]');
        const dirSelect = box.querySelector('[data-role="dir"]');
        const targets = [...box.querySelectorAll('[data-role="target"]')];
        const currentTarget = () => (targets.find((radio) => radio.checked) || {}).value || 'env';
        let directoriesLoaded = false;

        const syncTarget = () => {
          const wantsDir = currentTarget() === 'new';
          dirRow.hidden = !wantsDir;
          // 一选中就去取目录：等到点「导入」才取，用户看到的是「加载中…」占位，
          // 而那一下点击已经用第一个目录提交了 —— 等于没得选。
          if (wantsDir) ensureDirectories().catch((error) => say(errorText(error), DANGER));
        };
        targets.forEach((radio) => { radio.onchange = syncTarget; });
        syncTarget();

        async function ensureDirectories() {
          if (directoriesLoaded) return;
          const list = await loadDirectories();
          dirSelect.innerHTML = list.length
            ? list.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.name || entry.path || entry.id)}</option>`).join('')
            : `<option value="">${esc(tt('none', null, '无'))}</option>`;
          directoriesLoaded = true;
        }

        box.querySelector('[data-role="go"]').onclick = async () => {
          const chosen = file.files && file.files[0];
          const target = currentTarget();
          if (!chosen) { say(tt('handoffNeedFile', null, '先选一个交接包文件。'), DANGER); return; }
          if (pass.value.length < MIN_PASSPHRASE) { say(tt('handoffNeedPassphrase', null, '口令至少 6 位。'), DANGER); return; }
          let dirId = null;
          try {
            if (target === 'new') {
              await ensureDirectories();
              dirId = dirSelect.value || null;
              if (!dirId) { say(tt('handoffNeedDir', null, '选一个目标目录。'), DANGER); return; }
            }
          } catch (error) { say(errorText(error), DANGER); return; }
          busy(box, true, tt('handoffImporting', null, '正在导入…'));
          say(tt('loading', null, '加载中…'), MUTED);
          try {
            const body = await runImport({
              file: chosen, passphrase: pass.value, target, dirId,
              targetSessionId: target === 'merge' ? currentSessionId : null,
            });
            say(reportText(body), SUCCESS);
          } catch (error) {
            say(errorText(error), DANGER);
          } finally {
            busy(box, false);
          }
        };
      },
    });
  }

  const api = Object.freeze({ openExportDialog, openImportDialog, exportUrl, isZip, reportText });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCChatHandoff = api;
})(typeof window !== 'undefined' ? window : globalThis);
