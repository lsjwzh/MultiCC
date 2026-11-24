'use strict';

// 额度归一化、文案/国际化片段、窗口合并和颜色全部由 Rust 生成。
// Node 只保留原调用接口与结果冻结；直接值桥保留 undefined/UTF-16。
const { getNative } = require('../native/runtime');
function frozen(value) {
  if (!value || typeof value !== 'object') return value;
  for (const key of ['textParts', 'titleParts']) {
    if (Array.isArray(value[key])) Object.freeze(value[key]);
  }
  if (value.states) {
    for (const state of Object.values(value.states)) frozen(state);
    Object.freeze(value.states);
  }
  return Object.freeze(value);
}
const call = (op, input) => frozen(getNative().quotaBarViewRequest(op, input));
const renderQuotaBar = (kind, value, opts = {}) => call('renderQuotaBar', { kind, value, opts });
const idleQuotaBars = () => {
  const bars = getNative().quotaBarViewRequest('idleQuotaBars', {});
  for (const bar of Object.values(bars)) frozen(bar);
  return bars;
};
const balanceBar = value => call('balanceBar', { value });
const normalizeBalance = info => call('normalizeBalance', { info });
const windowEventBar = (info, nowMs = Date.now()) => call('windowEventBar', { info, nowMs });
const normalizeWindowEvent = (info, nowMs) => {
  const value = getNative().quotaBarViewRequest('normalizeWindowEvent', { info, nowMs });
  if (value && info?.provider && info.provider !== 'claude' && Array.isArray(value.windows)) {
    for (const row of value.windows) Object.freeze(row);
    Object.freeze(value.windows);
  }
  return frozen(value);
};
const claudeBar = (usage, live, nowMs = Date.now()) => call('claudeBar', { usage, live, nowMs });
const labelRoutedProvider = (bar, provider) => call('labelRoutedProvider', { bar, provider });
const labelRoutedBalance = bar => call('labelRoutedBalance', { bar });
const arkPlanFromBaseUrl = baseUrl => call('arkPlanFromBaseUrl', { baseUrl });
const arkWindowLabel = label => call('arkWindowLabel', { label });
const compactBarText = text => call('compactBarText', { text });
const providerLimitBar = (entry, nowMs = Date.now()) => call('providerLimitBar', { entry, nowMs });
const providerBalanceBar = (strategy, dto, fetchedAt) => call('providerBalanceBar', { strategy, dto, fetchedAt });
const COLOR = call('colors', {});
module.exports = { renderQuotaBar, idleQuotaBars, balanceBar, normalizeBalance, windowEventBar,
  normalizeWindowEvent, claudeBar, labelRoutedProvider, labelRoutedBalance, arkPlanFromBaseUrl,
  arkWindowLabel, compactBarText, providerLimitBar, providerBalanceBar, COLOR };
