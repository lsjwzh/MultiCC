'use strict';

/* 借道分享/导入（Provider 配置页）：每份分享码拥有独立、可撤销、可统计的
   Provider 范围凭据；服务端仅保存哈希，明文只在创建响应的分享码中出现一次。
   导入端粘贴后走普通 POST /api/providers。依赖 manage.js 的全局 helper（escapeHtml、
   providerApi、showToast、loadProviders、_providerData、providerCatalog），
   点击时才解析，因此脚本顺序只要求在 manage.html 里加载即可。 */

function parseRelayShareCode(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('mcrelay1.')) return { error: '不是有效的借道分享码（应以 mcrelay1. 开头）' };
  let payload = null;
  try {
    const b64 = text.slice('mcrelay1.'.length).replace(/-/g, '+').replace(/_/g, '/');
    // atob yields a byte string; the payload is UTF-8 JSON (names carry CJK),
    // so re-decode the bytes before parsing.
    const bytes = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const json = decodeURIComponent(bytes.split('').map(ch => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2)).join(''));
    payload = JSON.parse(json);
  } catch (_) { return { error: '分享码无法解码，请检查是否复制完整' }; }
  if (!payload || payload.kind !== 'multicc-relay') return { error: '不是 multicc 借道分享码' };
  if (payload.appType !== 'claude' && payload.appType !== 'codex') return { error: '分享码 appType 无效' };
  if (!/^https?:\/\//.test(String(payload.baseUrl || ''))) return { error: '分享码缺少 baseUrl' };
  if (!String(payload.authToken || '').trim()) return { error: '分享码缺少借道令牌' };
  return { payload };
}

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
    name: source.name || '借道',
    baseUrl: source.baseUrl,
    authToken: source.authToken,
    ...(model ? { model, models: models.slice(0, 100) } : {}),
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

// Candidate public base URLs for the relay: the address the page is opened
// on, the LAN address from /api/server-info, and any configured/verified
// tunnel addresses from /api/settings/tunnel. Best-effort — a dead endpoint
// just yields fewer options, never a broken dialog.
async function _relayBaseOptions() {
  const seen = new Set();
  const opts = [];
  const push = (url, label) => {
    const u = String(url || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(u) || seen.has(u)) return;
    seen.add(u);
    opts.push({ url: u, label });
  };
  push(location.origin, '当前页面地址');
  try {
    const info = await providerApi.json('/api/server-info');
    const lanUrls = info && Array.isArray(info.lanUrls) ? info.lanUrls : [];
    if (lanUrls.length) lanUrls.forEach((url, index) => push(url, lanUrls.length > 1 ? `局域网 ${index + 1}` : '局域网'));
    else if (info && info.lanAvailable !== false && info.ip) push(`http://${info.ip}:${info.port || 3000}`, '局域网');
  } catch (_) {}
  try {
    const st = await providerApi.json('/api/settings/tunnel');
    const cfg = (st && st.config) || {};
    const pr = (st && st.providers) || {};
    for (const name of ['tailscale', 'phddns', 'natapp', 'cpolar', 'sakurafrp']) {
      const publicUrl = pr[name] && pr[name].publicUrl;
      if (publicUrl) push(publicUrl, `公网(${name})`);
      const cfgUrl = cfg[name] && cfg[name].url;
      if (cfgUrl) push(cfgUrl, `穿透(${name})`);
    }
  } catch (_) {}
  return opts;
}

function _relayDate(value) {
  if (!value) return '从未';
  try { return new Date(value).toLocaleString(); } catch (_) { return '未知'; }
}

function manageRelayShares(appType = '', providerId = '') {
  const { overlay } = _relayOverlay(`
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:720px;max-width:94vw;max-height:86vh;overflow:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div><div style="font-size:15px;color:#c9d1d9;font-weight:600">借道链接记录</div><div style="font-size:12px;color:var(--faint);margin-top:4px">凭据仅保存哈希；“访问次数”统计通过鉴权的中转请求。</div></div>
        <button class="btn" data-act="close">关闭</button>
      </div>
      <div data-k="list" style="display:grid;gap:8px"><div class="status-text">读取中…</div></div>
      <div data-k="status" class="status-text" style="margin-top:8px"></div>
    </div>`);
  const listEl = overlay.querySelector('[data-k="list"]');
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
            ${escapeHtml(share.appType)} · ${escapeHtml(share.providerName || share.providerId)}<br>
            地址：${escapeHtml(share.relayBaseUrl)}<br>
            指纹：${escapeHtml(share.tokenFingerprint)} · 创建：${escapeHtml(_relayDate(share.createdAt))}<br>
            访问：${Number(share.accessCount) || 0} 次 · 最后使用：${escapeHtml(_relayDate(share.lastUsedAt))}
          </div>
          ${share.status === 'active' ? `<div style="text-align:right;margin-top:7px"><button class="btn" data-revoke="${escapeHtml(share.id)}" style="font-size:11px;color:#f85149">撤销</button></div>` : ''}
        </div>`).join('') : '<div class="status-text">尚未生成借道链接</div>';
      listEl.querySelectorAll('[data-revoke]').forEach(button => {
        button.onclick = async () => {
          if (!confirm('撤销后，使用这条分享码的远端 Provider 将立即失效。继续吗？')) return;
          try {
            await providerApi.json(`/api/provider-relay-shares/${encodeURIComponent(button.dataset.revoke)}`, { method: 'DELETE' });
            showToast('借道链接已撤销');
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
      <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">借道分享 · ${escapeHtml(p.name)}</div>
      <div style="font-size:12px;color:var(--faint);line-height:1.6;margin-bottom:10px">每次生成都必须设置独立令牌。令牌只写入本次分享码，服务端仅保存加盐哈希；以后可单独查看使用次数或撤销。</div>
      <label style="display:block;margin-bottom:10px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">链接备注（建议填写接收设备或用途）</div>
        <input data-k="label" type="text" maxlength="100" placeholder="例如：办公室 Mac" autocomplete="off" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box"></label>
      <label style="display:block;margin-bottom:10px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">独立借道令牌（8–128 位，无空格）</div>
        <div style="display:flex;gap:8px"><input data-k="token" type="password" placeholder="手工设置或随机生成" autocomplete="new-password" style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:7px 10px;outline:none;box-sizing:border-box;font-family:ui-monospace,monospace"><button class="btn" data-act="tokengen" style="font-size:12px">随机生成</button></div></label>
      <label style="display:block;margin-bottom:10px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">远端可访问的本机地址</div>
        <select data-k="basesel" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box"><option value="">读取可用地址…</option></select></label>
      <input data-k="basecustom" type="text" placeholder="https://…（自定义地址）" autocomplete="off" style="display:none;width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box;margin-bottom:10px">
      <textarea data-k="code" rows="4" readonly placeholder="生成后分享码只在这里显示一次" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box;font-family:ui-monospace,monospace"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">
        <button class="btn" data-act="records" style="font-size:13px">借道记录</button><button class="btn" data-act="close" style="font-size:13px">关闭</button><button class="btn" data-act="copy" style="font-size:13px" disabled>复制分享码</button><button class="btn btn-green" data-act="gen" style="font-size:13px">生成分享码</button>
      </div>
      <div data-k="status" class="status-text" style="margin-top:8px"></div>
    </div>`);
  const sel = overlay.querySelector('[data-k="basesel"]');
  const customEl = overlay.querySelector('[data-k="basecustom"]');
  const tokenInput = overlay.querySelector('[data-k="token"]');
  const labelInput = overlay.querySelector('[data-k="label"]');
  const codeEl = overlay.querySelector('[data-k="code"]');
  const st = overlay.querySelector('[data-k="status"]');

  _relayBaseOptions().then((opts) => {
    sel.innerHTML = '';
    for (const o of opts) {
      const op = document.createElement('option'); op.value = o.url; op.textContent = `${o.label} · ${o.url}`; sel.appendChild(op);
    }
    const custom = document.createElement('option'); custom.value = '__custom'; custom.textContent = '自定义地址…'; sel.appendChild(custom);
  });
  sel.onchange = () => { customEl.style.display = sel.value === '__custom' ? 'block' : 'none'; };
  overlay.querySelector('[data-act="tokengen"]').onclick = () => {
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
    tokenInput.value = 'relay_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  };
  overlay.querySelector('[data-act="records"]').onclick = () => manageRelayShares(appType, id);
  overlay.querySelector('[data-act="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(codeEl.value); }
    catch (_) { codeEl.select(); document.execCommand('copy'); }
    showToast('分享码已复制');
  };
  overlay.querySelector('[data-act="gen"]').onclick = async () => {
    st.textContent = ''; st.className = 'status-text';
    const base = sel.value === '__custom' ? customEl.value : sel.value;
    if (!tokenInput.value.trim()) { st.textContent = '请为这条链接设置独立令牌'; st.className = 'status-text err'; return; }
    try {
      const d = await providerApi.json(`/api/providers/${encodeURIComponent(appType)}/${encodeURIComponent(id)}/relay-share`, {
        method: 'POST', json: { publicBaseUrl: String(base || '').trim(), token: tokenInput.value, label: labelInput.value.trim() },
      });
      tokenInput.value = '';
      codeEl.value = d.code;
      overlay.querySelector('[data-act="copy"]').disabled = false;
      st.textContent = `已记录链接 ${d.share.tokenFingerprint}；请立即复制分享码。`; st.className = 'status-text ok';
    } catch (err) { st.textContent = 'Failed: ' + err.message; st.className = 'status-text err'; }
  };
}

function importRelayProvider() {
  const { overlay, close } = _relayOverlay(`
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:480px;max-width:92vw;">
      <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">导入借道 Provider</div>
      <div style="font-size:12px;color:var(--faint);margin-bottom:10px">粘贴另一台 multicc 生成的借道分享码，导入后本机会话即可通过对方的 CPR 代理使用其 provider。分享码内含令牌，请妥善保管。</div>
      <textarea data-k="code" rows="5" placeholder="mcrelay1.…"
        style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box;font-family:ui-monospace,monospace"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button class="btn" data-act="close" style="font-size:13px">取消</button>
        <button class="btn btn-green" data-act="import" style="font-size:13px">导入</button>
      </div>
      <div data-k="status" class="status-text" style="margin-top:8px"></div>
    </div>`);
  const st = overlay.querySelector('[data-k="status"]');
  overlay.querySelector('[data-act="import"]').onclick = async () => {
    st.textContent = ''; st.className = 'status-text';
    const { payload, error } = parseRelayShareCode(overlay.querySelector('[data-k="code"]').value);
    if (error) { st.textContent = error; st.className = 'status-text err'; return; }
    try {
      await providerApi.json('/api/providers', {
        method: 'POST',
        json: relayProviderInput(payload),
      });
      showToast('已导入借道 provider：' + (payload.name || payload.baseUrl));
      close();
      loadProviders();
    } catch (err) { st.textContent = 'Failed: ' + err.message; st.className = 'status-text err'; }
  };
}
