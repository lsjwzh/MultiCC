'use strict';

/* 借道分享/导入（Provider 配置页）：把本机 provider 通过 CPR 协议代理借给
   另一台 multicc。分享码（mcrelay1.…）内含 MULTICC_PROXY_TOKEN —— 一个只
   解锁 /claude-proxy、/codex-proxy 两个代理挂载的 bearer（见
   src/routes/auth.js）——不含上游 API Key；导入端粘贴后走普通
   POST /api/providers。依赖 manage.js 的全局 helper（escapeHtml、
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

function shareRelayProvider(appType, id) {
  const p = providerCatalog.findProvider(_providerData, appType, id);
  if (!p) return;
  const { overlay } = _relayOverlay(`
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:480px;max-width:92vw;">
      <div style="font-size:14px;color:#c9d1d9;font-weight:600;margin-bottom:10px">借道分享 · ${escapeHtml(p.name)}</div>
      <div style="font-size:12px;color:var(--faint);margin-bottom:10px">生成分享码，另一台 multicc 在「导入借道 Provider」里粘贴即可通过本机代理使用这个 provider。分享码内含借道令牌（只解锁两个代理挂载，不含上游 API Key），只发给你信任的设备。</div>
      <label style="display:block;margin-bottom:10px"><div style="font-size:12px;color:var(--faint);margin-bottom:4px">远端可访问的本机地址</div>
        <input data-k="base" type="text" value="${escapeHtml(location.origin)}" placeholder="https://…" autocomplete="off"
          style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;box-sizing:border-box"></label>
      <textarea data-k="code" rows="4" readonly placeholder="点下方「生成分享码」"
        style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:12px;padding:8px 10px;outline:none;box-sizing:border-box;font-family:ui-monospace,monospace"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button class="btn" data-act="close" style="font-size:13px">关闭</button>
        <button class="btn" data-act="copy" style="font-size:13px" disabled>复制分享码</button>
        <button class="btn btn-green" data-act="gen" style="font-size:13px">生成分享码</button>
      </div>
      <div data-k="status" class="status-text" style="margin-top:8px"></div>
    </div>`);
  const codeEl = overlay.querySelector('[data-k="code"]');
  const st = overlay.querySelector('[data-k="status"]');
  overlay.querySelector('[data-act="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(codeEl.value); }
    catch (_) { codeEl.select(); document.execCommand('copy'); }
    showToast('分享码已复制');
  };
  overlay.querySelector('[data-act="gen"]').onclick = async () => {
    st.textContent = ''; st.className = 'status-text';
    try {
      const d = await providerApi.json(`/api/providers/${encodeURIComponent(appType)}/${encodeURIComponent(id)}/relay-share`, {
        method: 'POST', json: { publicBaseUrl: overlay.querySelector('[data-k="base"]').value.trim() },
      });
      codeEl.value = d.code;
      overlay.querySelector('[data-act="copy"]').disabled = false;
      st.textContent = '远端 provider 的 baseUrl：' + d.baseUrl; st.className = 'status-text ok';
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
        json: { appType: payload.appType, name: payload.name || '借道', baseUrl: payload.baseUrl, authToken: payload.authToken },
      });
      showToast('已导入借道 provider：' + (payload.name || payload.baseUrl));
      close();
      loadProviders();
    } catch (err) { st.textContent = 'Failed: ' + err.message; st.className = 'status-text err'; }
  };
}
