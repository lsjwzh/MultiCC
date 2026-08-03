'use strict';

// Provider balance (余量) queries for the manage page — explicit per-provider
// and all-at-once lookups against /api/providers/:appType/:id/balance and
// /api/providers/balances. Kept separate from the auto quota badges in
// provider-catalog.js: those are cached per vendor KIND, this one answers
// "what does THIS provider's account have left, right now". Loaded before
// manage.js so renderProviderList can call paintProviderBalances().

(function () {
  const api = window.MultiCCApi;
  let results = {};

  function formatProviderBalance(r) {
    if (!r) return null;
    if (!r.ok) {
      const reasons = { unsupported: '无余量接口', not_found: 'provider 不存在', fetch_failed: '查询失败' };
      return { text: '余量：' + (reasons[r.reason] || '查询失败'), color: '#8b949e', title: r.reason || '查询失败' };
    }
    const dto = r.dto || {};
    const fmt2 = (n) => String(Number(Number(n).toFixed(2)));
    const moneyView = (value, title) => {
      const color = value <= 0 ? '#f85149' : value <= 5 ? '#d29922' : '#58a6ff';
      return { text: `余量 ¥${fmt2(value)}`, color, title };
    };
    if (dto.kind === 'balance') {
      if (typeof dto.available === 'number') {
        const title = '预付余额' + (typeof dto.voucher === 'number' ? `（含代金券 ¥${fmt2(dto.voucher)}）` : '');
        return moneyView(dto.available, title);
      }
      if (typeof dto.total === 'number') return moneyView(dto.total, '预付余额');
      return {
        text: dto.available === true ? '余量：可用' : '余量：不可用',
        color: dto.available === true ? '#58a6ff' : '#f85149',
        title: '上游未返回金额',
      };
    }
    if (dto.kind === 'window') {
      const pct = (v) => Math.round((v || 0) * 10000) / 100;
      const used = pct(dto.utilization);
      const parts = [`${dto.rateLimitType === 'weekly' ? '周' : '5h'} 已用 ${fmt2(used)}%`];
      let maxPct = used;
      if (typeof dto.weeklyUtilization === 'number') {
        const w = pct(dto.weeklyUtilization);
        maxPct = Math.max(maxPct, w);
        parts.push(`周 已用 ${fmt2(w)}%`);
      }
      const color = maxPct >= 90 ? '#f85149' : maxPct >= 70 ? '#d29922' : '#58a6ff';
      return { text: '余量 ' + parts.join(' · '), color, title: '窗口用量' + (dto.tier ? ` · ${dto.tier}` : '') };
    }
    return null;
  }

  // Exposed for manage.js renderProviderList: paints cached results into the
  // per-card [data-balance-id] rows after each re-render.
  window.paintProviderBalances = function paintProviderBalances() {
    document.querySelectorAll('[data-balance-id]').forEach((el) => {
      const view = formatProviderBalance(results[el.getAttribute('data-balance-id')]);
      if (!view) { el.style.display = 'none'; el.textContent = ''; el.title = ''; return; }
      el.style.display = '';
      el.textContent = view.text;
      el.style.color = view.color;
      el.title = view.title;
    });
  };

  window.balanceProvider = async function balanceProvider(appType, id, btn) {
    if (btn) { btn.textContent = '查询中…'; btn.disabled = true; }
    try {
      results[id] = await api.json(
        '/api/providers/' + encodeURIComponent(appType) + '/' + encodeURIComponent(id) + '/balance',
      );
    } catch (e) {
      results[id] = { ok: false, reason: 'fetch_failed' };
    }
    if (btn) { btn.textContent = '余量'; btn.disabled = false; }
    window.paintProviderBalances();
  };

  window.balanceGroup = async function balanceGroup(btn) {
    if (btn) { btn.textContent = '查询中…'; btn.disabled = true; }
    try {
      const data = await api.json('/api/providers/balances');
      for (const r of (data && data.results) || []) {
        if (r && r.providerId) results[r.providerId] = r;
      }
    } catch (_) { /* keep prior results on failure */ }
    if (btn) { btn.textContent = '全部查余量'; btn.disabled = false; }
    window.paintProviderBalances();
  };
})();
