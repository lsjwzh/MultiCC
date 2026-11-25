'use strict';

/* 借道分享/导入（Provider 配置页）：每份分享码拥有独立、可撤销、可统计的
   Provider 范围凭据；服务端仅保存哈希，明文只在创建响应的分享码中出现一次。
   导入端粘贴后走普通 POST /api/providers。依赖 manage.js 的全局 helper（escapeHtml、
   providerApi、showToast、loadProviders、_providerData、providerCatalog），
   点击时才解析，因此脚本顺序只要求在 air.html 里、画按钮的 air-provider-advanced.js 之前加载即可。
   已创建的分享（服务端留有加密副本）和已导入的线路都能再次取出同一份分享码，不必重新生成。 */

function parseRelayShareCode(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('mcrelay1.')) return { error: '不是有效的跨设备分享码（应以 mcrelay1. 开头）' };
  let payload = null;
  try {
    const b64 = text.slice('mcrelay1.'.length).replace(/-/g, '+').replace(/_/g, '/');
    // atob yields a byte string; the payload is UTF-8 JSON (names carry CJK),
    // so re-decode the bytes before parsing.
    const bytes = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const json = decodeURIComponent(bytes.split('').map(ch => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2)).join(''));
    payload = JSON.parse(json);
  } catch (_) { return { error: '分享码无法解码，请检查是否复制完整' }; }
  if (!payload || payload.kind !== 'multicc-relay') return { error: '不是 MultiCC 跨设备分享码' };
  if (payload.appType !== 'claude' && payload.appType !== 'codex' && payload.appType !== 'agy') return { error: '分享码 appType 无效' };
  if (!/^https?:\/\//.test(String(payload.baseUrl || ''))) return { error: '分享码缺少 baseUrl' };
  if (!String(payload.authToken || '').trim()) return { error: '分享码缺少安全凭据' };
  // 分享方式由出借方在生成分享码时选定（v3 起）。agy 没有 HTTP 反代，只能是远程 CLI。
  if (payload.mode !== undefined && payload.mode !== 'proxy' && payload.mode !== 'cli') {
    return { error: '分享码的分享方式无效' };
  }
  let mode;
  if (payload.appType === 'agy') mode = 'cli';
  else if (payload.mode === 'cli' || payload.mode === 'proxy') mode = payload.mode;
  return { payload: mode ? { ...payload, mode } : payload };
}

// 分享方式的中文说明；提示与导入共用一份，避免两处措辞漂移。
function relayModeLabel(mode) {  if (mode === 'cli') return '远程 CLI 分享';
  return '反代分享';
}

function relayModeHint(mode) {
  return mode === 'cli'
    ? '对方免装 Claude / Codex CLI：由出借方运行原装 CLI，文件读写与命令回调到本机真机执行。'
    : '对方本机照常安装 CLI：API 请求经出借方代理转发，只共享这一条 AI 线路。';
}

// 分享码已经写明分享方式；导入端不再自行决定，直接按码建线路。
function relayProviderInput(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const models = (Array.isArray(source.models) ? source.models : [])
    .map(value => String(value || '').trim())
    .filter((value, index, all) => value && value.length <= 256 && all.indexOf(value) === index)
    .slice(0, 100);
  const sharedModel = String(source.model || '').trim();
  const model = sharedModel && sharedModel.length <= 256 ? sharedModel : (models[0] || '');
  if (model && !models.includes(model)) models.unshift(model);
  return {
    appType: source.appType,
    name: source.name || '远程共享线路',
    baseUrl: source.baseUrl,
    authToken: source.authToken,
    ...(model ? { model, models: models.slice(0, 100) } : {}),
    ...(source.mode === 'cli' ? { cliRelay: true } : {}),
  };
}

function _relayOverlay(innerHtml) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
  overlay.innerHTML = innerHtml;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('[data-act="close"]').onclick = close;
  return { overlay, close };
}

// Candidate public base URLs for the relay. The collection itself lives in
// base-url-options.js — the session-share dialog asks the same question, and
// the two must not drift into two different answers. Only the JSON reader
// differs: this page goes through manage.js's providerApi.
async function _relayBaseOptions() {
  return multiccBaseUrlOptions({ json: (url) => providerApi.json(url) });
}

function _relayDate(value) {
  if (!value) return '从未';
  try { return new Date(value).toLocaleString(); } catch (_) { return '未知'; }
}

function _newRelayCredential() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return 'relay_' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// 写剪贴板并返回是否真的成功。navigator.clipboard 只在 https/localhost 下存在，
// 局域网 http 访问时退回 execCommand；两条都失败就如实返回 false，由调用方提示手动复制。
async function _relayCopyText(text, el) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to execCommand */ }
  try {
    el.focus(); el.select(); el.setSelectionRange(0, text.length);
    return !!document.execCommand('copy');
  } catch (_) { return false; }
}

function _relayCopyResult(statusEl, ok) {
  statusEl.textContent = ok
    ? '✓ 已复制到剪贴板，可以直接粘贴发给对方'
    : '没能自动写入剪贴板（浏览器限制）。文本已全选，请按 ⌘C / Ctrl+C 手动复制';
  statusEl.className = ok ? 'status-text ok' : 'status-text err';
}

// 取出的分享码弹层：先尝试写剪贴板，失败（无权限/非安全上下文）时用户仍可在文本框里手动全选复制。
function _relayShowCode(title, hint, code) {
  const { overlay } = _relayOverlay(`
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:560px;max-width:92vw;">
      <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">${escapeHtml(title)}</div>
      <div style="font-size:12px;color:var(--faint);line-height:1.6;margin-bottom:10px">${escapeHtml(hint)}</div>
      <textarea data-k="code" rows="5" readonly style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box;font-family:ui-monospace,monospace"></textarea>
      <p data-k="network-hint" style="font-size:12px;line-height:1.6;color:var(--faint)"></p>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button class="btn" data-act="close" style="font-size:13px">关闭</button>
        <button class="btn btn-green" data-act="copy" style="font-size:13px">复制分享码</button>
      </div>
      <div data-k="status" class="status-text" style="margin-top:8px"></div>
    </div>`);
  const codeEl = overlay.querySelector('[data-k="code"]');
  const statusEl = overlay.querySelector('[data-k="status"]');
  codeEl.value = code;
  multiccMountExternalAccessHint(overlay.querySelector('[data-k="network-hint"]'), parseRelayShareCode(code).payload?.baseUrl);
  // 弹层盖在页面提示之上，showToast 的反馈会被挡住，所以结果直接写在弹层里。
  const copy = async () => _relayCopyResult(statusEl, await _relayCopyText(code, codeEl));
  overlay.querySelector('[data-act="copy"]').onclick = copy;
  codeEl.onclick = () => codeEl.select();
  codeEl.focus(); codeEl.select();
  // 打开时顺手尝试一次；这次不在点击手势内，失败是常态，不报错，等用户点按钮。
  _relayCopyText(code, codeEl).then(ok => { if (ok) _relayCopyResult(statusEl, true); });
}

// 已导入的借道线路：地址指向另一台 MultiCC 的中转端点（…/claude-proxy/<id>/remote 或 …/codex-proxy/<id>）
// 且本机存有凭据。回环地址是本机自己的 CPR 管线，不算导入线路（与服务端 relayRouteFromBaseUrl 同口径）。
function isRelayImportProvider(provider) {
  if (!provider || !provider.hasToken) return false;
  let url;
  try { url = new URL(String(provider.baseUrl || '')); } catch (_) { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase())) return false;
  const seg = url.pathname.split('/').filter(Boolean);
  if (provider.appType === 'claude') return seg[0] === 'claude-proxy' && !!seg[1] && seg[2] === 'remote';
  if (provider.appType === 'codex') return seg[0] === 'codex-proxy' && !!seg[1];
  return false;
}

async function copyRelayImportInfo(appType, id) {
  try {
    const d = await providerApi.json(`/api/providers/${encodeURIComponent(appType)}/${encodeURIComponent(id)}/relay-import-code`);
    _relayShowCode('复制原始导入信息', '这是导入这条线路时用的分享码。把它发给别人，对方导入后会和你共用同一份凭据与额度。', d.code);
  } catch (err) {
    // 失败也要看得见：弹层里给出原因，而不是只靠页面底层的提示（会被挡住，甚至缺失）。
    const { overlay } = _relayOverlay(`
      <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:420px;max-width:92vw;">
        <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">无法复制原始导入信息</div>
        <div data-k="why" class="status-text err" style="line-height:1.6"></div>
        <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn" data-act="close" style="font-size:13px">关闭</button></div>
      </div>`);
    overlay.querySelector('[data-k="why"]').textContent = (err && err.message) || String(err);
  }
}

async function copyRelayShareCode(shareId) {
  const d = await providerApi.json(`/api/provider-relay-shares/${encodeURIComponent(shareId)}/code`);
  _relayShowCode('复制分享码', '与创建时相同的分享码。拿到的人共用这条分享的凭据，撤销这条分享会让他们一起失效。', d.code);
}

function manageRelayShares(appType = '', providerId = '') {
  const { overlay } = _relayOverlay(`
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:720px;max-width:94vw;max-height:86vh;overflow:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div><div style="font-size:15px;color:#c9d1d9;font-weight:600">跨设备共享记录</div><div style="font-size:12px;color:var(--faint);margin-top:4px">每条分享可单独撤销；访问次数只统计成功连接。</div></div>
        <button class="btn" data-act="close">关闭</button>
      </div>
      <div data-k="list" style="display:grid;gap:8px"><div class="status-text">读取中…</div></div>
      <p data-k="network-hint" style="font-size:12px;line-height:1.6;color:var(--faint)"></p>
      <div data-k="status" class="status-text" style="margin-top:8px"></div>
    </div>`);
  const listEl = overlay.querySelector('[data-k="list"]');
  multiccMountExternalAccessHint(overlay.querySelector('[data-k="network-hint"]'));
  const statusEl = overlay.querySelector('[data-k="status"]');
  const refresh = async () => {
    const query = new URLSearchParams();
    if (appType) query.set('appType', appType);
    if (providerId) query.set('providerId', providerId);
    try {
      const d = await providerApi.json(`/api/provider-relay-shares?${query}`);
      const shares = Array.isArray(d.shares) ? d.shares : [];
      listEl.innerHTML = shares.length ? shares.map(share => `
        <div style="border:1px solid #30363d;border-radius:8px;padding:10px;background:#0d1117">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
            <div style="font-size:13px;color:#c9d1d9;font-weight:600">${escapeHtml(share.label || share.providerName || share.providerId)}</div>
            <span style="font-size:11px;color:${share.status === 'active' ? '#3fb950' : '#8b949e'}">${share.status === 'active' ? '有效' : '已撤销'}</span>
          </div>
          <div style="font-size:11px;color:var(--faint);line-height:1.65;margin-top:5px;word-break:break-all">
            ${escapeHtml(share.appType)} · ${escapeHtml(share.providerName || share.providerId)} · ${escapeHtml(relayModeLabel(share.mode))}<br>
            地址：${escapeHtml(share.relayBaseUrl)}<br>
            指纹：${escapeHtml(share.tokenFingerprint)} · 创建：${escapeHtml(_relayDate(share.createdAt))}<br>
            访问：${Number(share.accessCount) || 0} 次 · 最后使用：${escapeHtml(_relayDate(share.lastUsedAt))}
          </div>
          ${share.status === 'active' ? `<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:7px">${share.recoverable
            ? `<button class="btn" data-copy="${escapeHtml(share.id)}" style="font-size:11px">复制分享码</button>`
            : '<span style="font-size:11px;color:var(--faint)">旧版创建，无法再复制</span>'}<button class="btn" data-revoke="${escapeHtml(share.id)}" style="font-size:11px;color:#f85149">撤销</button></div>` : ''}
        </div>`).join('') : '<div class="status-text">尚未分享给其他设备</div>';
      listEl.querySelectorAll('[data-copy]').forEach(button => {
        button.onclick = async () => {
          try { await copyRelayShareCode(button.dataset.copy); }
          catch (err) { statusEl.textContent = 'Failed: ' + err.message; statusEl.className = 'status-text err'; }
        };
      });
      listEl.querySelectorAll('[data-revoke]').forEach(button => {
        button.onclick = async () => {
          if (!confirm('撤销后，其他设备将立即无法继续使用这条 AI 线路。继续吗？')) return;
          try {
            await providerApi.json(`/api/provider-relay-shares/${encodeURIComponent(button.dataset.revoke)}`, { method: 'DELETE' });
            showToast('这条跨设备共享已撤销');
            await refresh();
          } catch (err) { statusEl.textContent = 'Failed: ' + err.message; statusEl.className = 'status-text err'; }
        };
      });
    } catch (err) {
      listEl.innerHTML = `<div class="status-text err">Failed: ${escapeHtml(err.message)}</div>`;
    }
  };
  refresh();
}

function shareRelayProvider(appType, id) {
  const p = providerCatalog.findProvider(_providerData, appType, id);
  if (!p) return;
  const { overlay } = _relayOverlay(`
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:560px;max-width:92vw;">
      <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">共享到其他设备 · ${escapeHtml(p.name)}</div>
      <div style="font-size:12px;color:var(--faint);line-height:1.6;margin-bottom:10px">系统会自动生成这次分享专用的安全凭据。对方只能使用这条 AI 线路，不能看到你的上游密钥；以后可单独查看使用次数或撤销。</div>
      <div style="margin-bottom:10px">
        <div style="font-size:12px;color:var(--faint);margin-bottom:4px">分享方式（写进分享码，接收方导入时不用再选）</div>
        <label style="display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid #30363d;border-radius:6px;margin-bottom:6px;cursor:pointer">
          <input type="radio" name="relay-mode" value="proxy" style="margin-top:2px">
          <span style="font-size:12px;color:#c9d1d9"><strong>反代分享</strong><br><span style="color:var(--faint)">接收方本机照常安装 CLI；API 请求经本机代理转发，只共享这一条 AI 线路。</span></span>
        </label>
        <label style="display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid #30363d;border-radius:6px;cursor:pointer">
          <input type="radio" name="relay-mode" value="cli" style="margin-top:2px">
          <span style="font-size:12px;color:#c9d1d9"><strong>远程 CLI 分享</strong><br><span style="color:var(--faint)">接收方免装 CLI：由本机运行原装 CLI，文件读写与命令回调到接收方真机执行。</span></span>
        </label>
      </div>
      <label style="display:block;margin-bottom:10px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">链接备注（建议填写接收设备或用途）</div>
        <input data-k="label" type="text" maxlength="100" placeholder="例如：办公室 Mac" autocomplete="off" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box"></label>
      <label style="display:block;margin-bottom:10px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">其他设备访问本机时使用的地址</div>
        <select data-k="basesel" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box"><option value="">读取可用地址…</option></select></label>
      <input data-k="basecustom" type="text" placeholder="https://…（自定义地址）" autocomplete="off" style="display:none;width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box;margin-bottom:10px">
      <p data-k="network-hint" style="font-size:12px;line-height:1.6;color:var(--faint)"></p>
      <textarea data-k="code" rows="4" readonly placeholder="生成后分享码只在这里显示一次" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box;font-family:ui-monospace,monospace"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">
        <button class="btn" data-act="records" style="font-size:13px">共享记录</button><button class="btn" data-act="close" style="font-size:13px">关闭</button><button class="btn" data-act="copy" style="font-size:13px" disabled>复制分享码</button><button class="btn btn-green" data-act="gen" style="font-size:13px">生成分享码</button>
      </div>
      <div data-k="status" class="status-text" style="margin-top:8px"></div>
    </div>`);
  const sel = overlay.querySelector('[data-k="basesel"]');
  const customEl = overlay.querySelector('[data-k="basecustom"]');
  const labelInput = overlay.querySelector('[data-k="label"]');
  const codeEl = overlay.querySelector('[data-k="code"]');
  const st = overlay.querySelector('[data-k="status"]');
  let shareCredential = _newRelayCredential();
  // 默认跟这条线路当前的用法一致：已经是远程 CLI 线路就默认远程 CLI 分享。
  const initialMode = p.cliRelay === true ? 'cli' : 'proxy';
  overlay.querySelectorAll('input[name="relay-mode"]').forEach(el => { el.checked = el.value === initialMode; });
  const selectedMode = () => {
    const picked = overlay.querySelector('input[name="relay-mode"]:checked');
    return picked && picked.value === 'cli' ? 'cli' : 'proxy';
  };
  const hint = overlay.querySelector('[data-k="network-hint"]');
  const updateHint = () => multiccMountExternalAccessHint(hint, sel.value === '__custom' ? customEl.value : sel.value);
  updateHint();
  const generate = overlay.querySelector('[data-act="gen"]');
  generate.disabled = true;

  _relayBaseOptions().then((opts) => {
    sel.innerHTML = '';
    for (const o of opts) {
      const op = document.createElement('option'); op.value = o.url; op.textContent = `${o.label} · ${o.url}`; sel.appendChild(op);
    }
    const custom = document.createElement('option'); custom.value = '__custom'; custom.textContent = '自定义地址…'; sel.appendChild(custom);
    sel.value = multiccPreferredBaseUrl(opts)?.url || '__custom';
    sel.onchange();
    generate.disabled = false;
  });
  sel.onchange = () => { customEl.style.display = sel.value === '__custom' ? 'block' : 'none'; updateHint(); };
  customEl.oninput = updateHint;
  overlay.querySelector('[data-act="records"]').onclick = () => manageRelayShares(appType, id);
  overlay.querySelector('[data-act="copy"]').onclick = async () => {
    _relayCopyResult(st, await _relayCopyText(codeEl.value, codeEl));
  };
  overlay.querySelector('[data-act="gen"]').onclick = async () => {
    st.textContent = ''; st.className = 'status-text';
    const base = sel.value === '__custom' ? customEl.value : sel.value;
    try {
      const d = await providerApi.json(`/api/providers/${encodeURIComponent(appType)}/${encodeURIComponent(id)}/relay-share`, {
        method: 'POST', json: { publicBaseUrl: String(base || '').trim(), token: shareCredential, label: labelInput.value.trim(), mode: selectedMode() },
      });
      shareCredential = _newRelayCredential();
      codeEl.value = d.code;
      overlay.querySelector('[data-act="copy"]').disabled = false;
      st.textContent = `已记录链接 ${d.share.tokenFingerprint}；请立即复制分享码。`; st.className = 'status-text ok';
    } catch (err) { st.textContent = 'Failed: ' + err.message; st.className = 'status-text err'; }
  };
}

function shareAgyAccount(accountId, accountLabel) {
  const displayName = String(accountLabel || accountId || '反重力账号');
  const { overlay, close } = _relayOverlay(`
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:560px;max-width:92vw;">
      <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">反重力借道分享 · ${escapeHtml(displayName)}</div>
      <div style="font-size:12px;color:var(--faint);line-height:1.6;margin-bottom:10px">生成独立可撤销的反重力分享码。对方免装 agy、免配 SSH 即可直接使用此账号，流量自动锁定本 Host 绑定的出口 IP；命令与文件读写仍在对方真机执行，绝不暴露你的 VPS 权限或 OAuth 凭据。</div>
      <div style="font-size:12px;color:#c9d1d9;padding:8px 10px;border:1px solid #30363d;border-radius:6px;margin-bottom:10px">分享方式：<strong>远程 CLI 分享</strong><br><span style="color:var(--faint)">反重力没有 HTTP 反代通道，只能以远程 CLI 方式借道；分享码里已写定，对方导入即生效。</span></div>
      <label style="display:block;margin-bottom:10px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">链接备注（建议填写接收设备或用途）</div>
        <input data-k="label" type="text" maxlength="100" placeholder="例如：办公室 Mac / 同事试用" autocomplete="off" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box"></label>
      <label style="display:block;margin-bottom:10px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">其他设备访问本机时使用的地址</div>
        <select data-k="basesel" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box"><option value="">读取可用地址…</option></select></label>
      <input data-k="basecustom" type="text" placeholder="https://…（自定义地址）" autocomplete="off" style="display:none;width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box;margin-bottom:10px">
      <p data-k="network-hint" style="font-size:12px;line-height:1.6;color:var(--faint)"></p>
      <textarea data-k="code" rows="4" readonly placeholder="生成后分享码显示在这里，可随时在共享记录中重新复制或撤销" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box;font-family:ui-monospace,monospace"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">
        <button class="btn" data-act="ssh" style="font-size:13px">改用 SSH 借用码…</button><button class="btn" data-act="records" style="font-size:13px">共享记录</button><button class="btn" data-act="close" style="font-size:13px">关闭</button><button class="btn" data-act="copy" style="font-size:13px" disabled>复制分享码</button><button class="btn btn-green" data-act="gen" style="font-size:13px">生成分享码</button>
      </div>
      <div data-k="status" class="status-text" style="margin-top:8px"></div>
    </div>`);
  const sel = overlay.querySelector('[data-k="basesel"]');
  const customEl = overlay.querySelector('[data-k="basecustom"]');
  const labelInput = overlay.querySelector('[data-k="label"]');
  const codeEl = overlay.querySelector('[data-k="code"]');
  const st = overlay.querySelector('[data-k="status"]');
  let shareCredential = _newRelayCredential();
  const hint = overlay.querySelector('[data-k="network-hint"]');
  const updateHint = () => multiccMountExternalAccessHint(hint, sel.value === '__custom' ? customEl.value : sel.value);
  updateHint();
  const generate = overlay.querySelector('[data-act="gen"]');
  generate.disabled = true;

  _relayBaseOptions().then((opts) => {
    sel.innerHTML = '';
    for (const o of opts) {
      const op = document.createElement('option'); op.value = o.url; op.textContent = `${o.label} · ${o.url}`; sel.appendChild(op);
    }
    const custom = document.createElement('option'); custom.value = '__custom'; custom.textContent = '自定义地址…'; sel.appendChild(custom);
    sel.value = multiccPreferredBaseUrl(opts)?.url || '__custom';
    sel.onchange();
    generate.disabled = false;
  });
  sel.onchange = () => { customEl.style.display = sel.value === '__custom' ? 'block' : 'none'; updateHint(); };
  customEl.oninput = updateHint;
  overlay.querySelector('[data-act="records"]').onclick = () => manageRelayShares('agy', accountId);
  overlay.querySelector('[data-act="ssh"]').onclick = () => { close(); shareAgySshAccount(accountId, displayName); };
  overlay.querySelector('[data-act="copy"]').onclick = async () => {
    _relayCopyResult(st, await _relayCopyText(codeEl.value, codeEl));
  };
  overlay.querySelector('[data-act="gen"]').onclick = async () => {
    st.textContent = ''; st.className = 'status-text';
    const base = sel.value === '__custom' ? customEl.value : sel.value;
    try {
      const d = await providerApi.json(`/api/agy/accounts/${encodeURIComponent(accountId)}/relay-share`, {
        method: 'POST', json: { publicBaseUrl: String(base || '').trim(), token: shareCredential, label: labelInput.value.trim(), mode: 'cli' },
      });
      shareCredential = _newRelayCredential();
      codeEl.value = d.code;
      overlay.querySelector('[data-act="copy"]').disabled = false;
      st.textContent = `已记录链接 ${d.share.tokenFingerprint}；请立即复制分享码。`; st.className = 'status-text ok';
    } catch (err) { st.textContent = 'Failed: ' + err.message; st.className = 'status-text err'; }
  };
}

// SSH 借用码：和借道码不是一回事。码里是 Host 一次性生成的私钥，接收方用它
// 直接 SSH 登录 Host，才能跑 Mutagen 的对端 agent；借道码走 WSS，永远拿不到
// 真实文件副本。因为等于交出登录权，生成前必须让分享人看见这句话再看一次。
function parseSshShareCode(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('mcssh1.')) return { error: '不是 SSH 借用码（应以 mcssh1. 开头）' };
  let payload = null;
  try {
    const b64 = text.slice('mcssh1.'.length).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const json = decodeURIComponent(bytes.split('').map(ch => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2)).join(''));
    payload = JSON.parse(json);
  } catch (_) { return { error: '借用码无法解码，请检查是否复制完整' }; }
  if (!payload || payload.kind !== 'multicc-ssh') return { error: '不是 MultiCC SSH 借用码' };
  if (payload.appType !== 'agy') return { error: 'SSH 借用码目前只支持反重力 agy' };
  if (!String(payload.sshTarget || '').trim()) return { error: '借用码缺少 SSH 目标' };
  if (!String(payload.identityKey || '').includes('BEGIN OPENSSH PRIVATE KEY')) return { error: '借用码缺少借用的私钥' };
  if (payload.fileMode && payload.fileMode !== 'mutagen' && payload.fileMode !== 'remote_mcp') {
    return { error: '借用码的同步方式无效' };
  }
  return { payload: { ...payload, fileMode: payload.fileMode || 'mutagen' } };
}

function shareAgySshAccount(accountId, accountLabel) {
  const displayName = String(accountLabel || accountId || '反重力账号');
  const { overlay, close } = _relayOverlay(`
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:600px;max-width:94vw;">
      <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">反重力 SSH 借用码 · ${escapeHtml(displayName)}</div>
      <div style="border:1px solid #f85149;background:rgba(248,81,73,.08);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;line-height:1.7;color:#ffb3ae">
        <strong>这会把你在这台机器上的登录权交出去。</strong><br>
        借用码里是一次性生成的私钥；谁拿到码，谁就能以你的用户身份 SSH 登录。只发给你自己的设备，或完全信任的人。用完请在下面的「已借出」里撤销，密钥会立刻从 authorized_keys 删除。
      </div>
      <div style="font-size:12px;color:var(--faint);line-height:1.7;margin-bottom:12px">
        SSH 借用是唯一能跑 Mutagen 双向同步的方式（借道码固定走 remote_mcp，文件读写回调到接收方本机）。代价是接收方需要能连上本机的 SSH 端口。
      </div>
      <label style="display:block;margin-bottom:8px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">对方连接时使用的 SSH 目标</div>
        <input data-k="sshTarget" type="text" placeholder="用户名@地址，例如 me@192.168.1.20" autocomplete="off" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box"></label>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <label style="flex:1"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">端口</div>
          <input data-k="sshPort" type="number" min="1" max="65535" value="22" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box"></label>
        <label style="flex:2"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">文件同步方式</div>
          <select data-k="fileMode" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box">
            <option value="mutagen">Mutagen 双向同步（借用码的意义所在）</option>
            <option value="remote_mcp">remote_mcp（不落盘到本机）</option>
          </select></label>
      </div>
      <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:10px;font-size:12px;color:#c9d1d9;line-height:1.6;cursor:pointer">
        <input data-k="install" type="checkbox" checked style="margin-top:2px">
        <span>自动写入 <code>~/.ssh/authorized_keys</code>（带 <code>restrict</code>：禁端口转发、禁 agent 转发、禁 pty），并记入「已借出」。不勾选则只生成码，由你自己粘贴那一行。</span>
      </label>
      <div data-k="preflight" style="font-size:12px;line-height:1.7;color:var(--faint);margin-bottom:10px">正在检查本机 SSH 状态…</div>
      <div data-k="egress" style="font-size:12px;line-height:1.7;color:var(--faint);margin-bottom:10px"></div>
      <textarea data-k="code" rows="3" readonly placeholder="生成后借用码只在这里显示一次" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box;font-family:ui-monospace,monospace"></textarea>
      <pre data-k="aks" style="display:none;white-space:pre-wrap;word-break:break-all;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:11px;padding:8px 10px;margin:8px 0 0"></pre>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">
        <button class="btn" data-act="close" style="font-size:13px">关闭</button>
        <button class="btn" data-act="copy" style="font-size:13px" disabled>复制借用码</button>
        <button class="btn btn-green" data-act="gen" style="font-size:13px">生成借用码</button>
      </div>
      <div data-k="status" class="status-text" style="margin-top:8px"></div>
    </div>`);
  const el = k => overlay.querySelector(`[data-k="${k}"]`);
  const st = el('status');
  const codeEl = el('code');
  const preflightEl = el('preflight');
  const copyBtn = overlay.querySelector('[data-act="copy"]');
  overlay.querySelector('[data-act="close"]').onclick = () => close();
  copyBtn.onclick = async () => { _relayCopyResult(st, await _relayCopyText(codeEl.value, codeEl)); };

  // 出口提示是静态的：SSH 不是 http，没有可探测的 base URL，只能把事实讲清楚。
  el('egress').innerHTML = '对方要能直接连到这台机器的 SSH 端口：同一局域网填内网地址即可；跨公网需要把端口映射出去（「隧道」面板加一条 TCP 映射到本机 22），或等 SSH over WSS 上线。';

  const renderPreflight = (d) => {
    const rows = [];
    const sshd = d && d.sshd ? d.sshd : {};
    if (sshd.listening) {
      rows.push('<span style="color:#3fb950">本机 SSH 正在监听 22 端口</span>');
    } else {
      rows.push('<span style="color:#f85149">本机 22 端口没有在监听：先在「系统设置 → 通用 → 共享 → 远程登录」打开（macOS），或 <code>systemctl enable --now ssh</code>（Linux）。</span>');
    }
    const aks = d && d.authorizedKeys ? d.authorizedKeys : {};
    if (aks.writable === false) {
      rows.push(`<span style="color:#f85149">${escapeHtml(aks.path || '~/.ssh/authorized_keys')} 不可写，请检查权限后再试。</span>`);
    } else {
      rows.push(`写入位置：<code>${escapeHtml(aks.path || '~/.ssh/authorized_keys')}</code>`);
    }
    const shares = (Array.isArray(d && d.shares) ? d.shares : []).filter(s => s && s.accountId === accountId);
    if (shares.length) {
      rows.push('<div style="margin-top:6px;color:#c9d1d9">已借出：</div>');
      for (const s of shares) {
        const when = s.createdAt ? new Date(s.createdAt).toLocaleString() : '';
        rows.push(`<div style="display:flex;gap:8px;align-items:center;margin-top:4px"><span style="flex:1;word-break:break-all">${escapeHtml(s.label || 'SSH 借用')} · ${escapeHtml(s.sshTarget || '')} · ${escapeHtml(when)}</span><button class="btn" data-revoke="${escapeHtml(s.id || '')}" style="font-size:12px;padding:2px 8px">撤销</button></div>`);
      }
    }
    preflightEl.innerHTML = rows.join('<br>');
  };
  const loadPreflight = () => providerApi.json(`/api/agy/accounts/${encodeURIComponent(accountId)}/ssh-share/preflight`)
    .then(renderPreflight)
    .catch(err => { preflightEl.textContent = '无法检查本机 SSH 状态：' + err.message; });
  overlay.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-revoke]');
    if (!btn) return;
    try {
      await providerApi.json(`/api/agy/accounts/${encodeURIComponent(accountId)}/ssh-shares/${encodeURIComponent(btn.dataset.revoke)}`, { method: 'DELETE' });
      st.textContent = '已撤销，并从 authorized_keys 删除该密钥。'; st.className = 'status-text ok';
      loadPreflight();
    } catch (err) { st.textContent = '撤销失败：' + err.message; st.className = 'status-text err'; }
  });
  loadPreflight();

  overlay.querySelector('[data-act="gen"]').onclick = async () => {
    st.textContent = ''; st.className = 'status-text';
    const sshTarget = el('sshTarget').value.trim();
    if (!sshTarget) { st.textContent = '请填写对方连接使用的 SSH 目标（形如 用户名@地址）'; st.className = 'status-text err'; return; }
    const port = Number(el('sshPort').value) || 22;
    try {
      const d = await providerApi.json(`/api/agy/accounts/${encodeURIComponent(accountId)}/ssh-share`, {
        method: 'POST',
        json: { sshTarget, sshPort: port, fileMode: el('fileMode').value || 'mutagen', install: el('install').checked, label: '' },
      });
      codeEl.value = d.code;
      copyBtn.disabled = false;
      if (d.share && d.share.installed) {
        st.textContent = `已写入 authorized_keys（指纹 ${d.share.fingerprint}）。把借用码发给对方，用完记得撤销。`;
        st.className = 'status-text ok';
      } else {
        st.textContent = '未写入本机：请把下面这行手动加到 ~/.ssh/authorized_keys。';
        st.className = 'status-text';
        el('aks').style.display = 'block';
        el('aks').textContent = d.authorizedKeysLine || '';
      }
      loadPreflight();
    } catch (err) { st.textContent = '生成失败：' + err.message; st.className = 'status-text err'; }
  };
}

async function copyAgyRelayImportCode(accountId) {
  try {
    const d = await providerApi.json(`/api/agy/accounts/${encodeURIComponent(accountId)}/relay-import-code`);
    _relayShowCode('复制反重力分享码', '这是导入该反重力借道账号时使用的分享码。发给其他设备导入后会共用同一份借道凭据；出借方撤销后全部失效。', d.code);
  } catch (err) {
    const { overlay } = _relayOverlay(`
      <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:420px;max-width:92vw;">
        <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">无法复制分享码</div>
        <div data-k="why" class="status-text err" style="line-height:1.6"></div>
        <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn" data-act="close" style="font-size:13px">关闭</button></div>
      </div>`);
    overlay.querySelector('[data-k="why"]').textContent = (err && err.message) || String(err);
  }
}

function importRelayProvider() {
  const { overlay, close } = _relayOverlay(`
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:480px;max-width:92vw;">
      <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">使用其他设备的线路</div>
      <div style="font-size:12px;color:var(--faint);margin-bottom:10px">粘贴另一台 MultiCC 生成的分享码（Claude / Codex / 反重力 agy 借道码，或反重力 SSH 借用码）。分享码里已经写明对方的分享方式与传输方式，导入即可直接使用。</div>
      <textarea data-k="code" rows="5" placeholder="mcrelay1.… 或 mcssh1.…"
        style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box;font-family:ui-monospace,monospace"></textarea>
      <div data-k="mode-line" style="display:none;margin-top:10px;padding:8px 10px;border:1px solid #30363d;border-radius:6px;font-size:12px;color:#c9d1d9;line-height:1.6"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button class="btn" data-act="close" style="font-size:13px">取消</button>
        <button class="btn btn-green" data-act="import" style="font-size:13px">导入</button>
      </div>
      <div data-k="status" class="status-text" style="margin-top:8px"></div>
    </div>`);
  const st = overlay.querySelector('[data-k="status"]');
  const codeEl = overlay.querySelector('[data-k="code"]');
  const modeLine = overlay.querySelector('[data-k="mode-line"]');
  // SSH 借用码和借道码是两种码：前缀不同，导入后的传输方式也不同。
  const parseAnyShareCode = (raw) => {
    const text = String(raw || '').trim();
    return text.startsWith('mcssh1.') ? parseSshShareCode(text) : parseRelayShareCode(text);
  };
  // 分享方式随分享码下发，导入端只负责展示，不再让人二次猜测。
  const syncRelayHint = () => {
    const { payload } = parseAnyShareCode(codeEl.value);
    if (!payload) { modeLine.style.display = 'none'; return; }
    modeLine.style.display = 'block';
    if (payload.kind === 'multicc-ssh') {
      modeLine.innerHTML = `<strong>方式：SSH 借用（${escapeHtml(payload.fileMode === 'remote_mcp' ? 'remote_mcp' : 'Mutagen 双向同步')}）</strong><br><span style="color:var(--faint)">借用码里带着对方借给你的私钥，会存到本机 0600 文件；连不上对方 SSH 时会导入失败。</span>`;
      return;
    }
    modeLine.innerHTML = payload.mode
      ? `<strong>分享方式：${escapeHtml(relayModeLabel(payload.mode))}</strong><br><span style="color:var(--faint)">${escapeHtml(relayModeHint(payload.mode))}</span>`
      : '<strong>分享方式：未标注（旧版分享码）</strong><br><span style="color:var(--faint)">旧版分享码没有记录分享方式，将按反代分享导入；需要远程 CLI 可在导入后于卡片上开启。</span>';
  };
  codeEl.oninput = syncRelayHint;
  overlay.querySelector('[data-act="import"]').onclick = async () => {
    st.textContent = ''; st.className = 'status-text';
    const { payload, error } = parseAnyShareCode(codeEl.value);
    if (error) { st.textContent = error; st.className = 'status-text err'; return; }
    try {
      if (payload.kind === 'multicc-ssh') {
        await providerApi.json('/api/agy/accounts/remote', {
          method: 'POST',
          json: {
            label: payload.name || '反重力 SSH 借用账号',
            remote: {
              transport: 'ssh',
              sshTarget: payload.sshTarget,
              ...(payload.sshPort ? { sshPort: payload.sshPort } : {}),
              fileMode: payload.fileMode || 'mutagen',
              identityKey: payload.identityKey,
            },
          },
        });
        showToast('已导入反重力 SSH 借用账号：' + (payload.sshTarget || ''));
        close();
        if (window.MultiCCOfficialAccounts && typeof window.MultiCCOfficialAccounts.load === 'function') {
          window.MultiCCOfficialAccounts.load();
        }
        if (typeof window.MultiCCAgyAccountsReload === 'function') {
          window.MultiCCAgyAccountsReload();
        }
        loadProviders();
        return;
      }
      if (payload.appType === 'agy') {
        await providerApi.json('/api/agy/accounts/remote', {
          method: 'POST',
          json: {
            label: payload.name || '反重力共享账号',
            remote: {
              transport: 'relay',
              relayBaseUrl: payload.baseUrl,
              relayAuthToken: payload.authToken,
              ...(payload.relayShareId ? { relayShareId: payload.relayShareId } : {}),
            },
          },
        });
        showToast('已导入反重力借道账号：' + (payload.name || payload.baseUrl));
        close();
        if (window.MultiCCOfficialAccounts && typeof window.MultiCCOfficialAccounts.load === 'function') {
          window.MultiCCOfficialAccounts.load();
        }
        if (typeof window.MultiCCAgyAccountsReload === 'function') {
          window.MultiCCAgyAccountsReload();
        }
        loadProviders();
        return;
      }
      await providerApi.json('/api/providers', {
        method: 'POST',
        json: relayProviderInput(payload),
      });
      showToast('已连接其他设备的线路：' + (payload.name || payload.baseUrl));
      close();
      loadProviders();
    } catch (err) { st.textContent = 'Failed: ' + err.message; st.className = 'status-text err'; }
  };
}
