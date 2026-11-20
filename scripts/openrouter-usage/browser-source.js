'use strict';

// Compatibility bridge to MultiCC's browser CLI. The service's existing data
// pipeline stays unchanged. Replace this Node adapter when refresh moves to Rust.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const execute = promisify(execFile);
const CHART_URL = 'https://en.macromicro.me/charts/148532/world-openrouter-token-usage';

// Runs inside the site's page: wait for its own completed data request. Never
// read authentication fields or manufacture an alternate request to the site.
function readChart() {
  if (typeof App === 'undefined' || !App.data || !App.data['c:148532']) return null;
  const completed = performance.getEntriesByType('resource').some(entry => {
    const url = new URL(entry.name, location.href);
    return url.origin === location.origin && /^\/charts\/data\//.test(url.pathname) &&
      url.pathname.split('/').pop().split(',').includes('148532') && entry.responseEnd > 0;
  });
  if (!completed) return null;
  const chart = App.data['c:148532'];
  if (!Array.isArray(chart.series) || !chart.series.length) return null;
  const summary = chart.series.every(points => Array.isArray(points) && points.length <= 2);
  return { success: 1, historyCoverage: summary ? 'latest-two' : 'history',
    data: { 'c:148532': { info: chart.info, series: chart.series } } };
}

async function capture(browser, { now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let target;
  try {
    const opened = await browser(['open', CHART_URL, '--new-tab']);
    // The first --new-tab for an owner can return a navigation result without
    // targetId. Resolve it from the owner's current tab in that case.
    if (opened.targetId && opened.newTab) target = opened.targetId;
    else {
      const listed = await browser(['tabs']);
      const own = (listed.tabs || []).filter(tab => browser.owner && tab.current && tab.owner === browser.owner);
      if (own.length !== 1 || !own[0].id) throw new Error('浏览器没有创建独立的取数标签');
      target = own[0].id;
    }
    const deadline = now() + 45000;
    let previous = null;
    while (now() < deadline) {
      let response;
      try {
        response = await browser(['eval', '(' + readChart.toString() + ')()', '--tab', target]);
      } catch (error) {
        // A newly opened background tab can navigate between open and eval.
        // Retry only the browser's transient navigation errors.
        if (!/context was destroyed|Cannot find context|Inspected target navigated|frame was detached/i.test(String(error.stderr || error.message))) throw error;
        previous = null;
        await pause(500);
        continue;
      }
      const value = response.value;
      if (value && value.success === 1) {
        const raw = JSON.stringify(value);
        if (raw === previous) return raw;
        previous = raw;
      } else previous = null;
      await pause(500);
    }
    throw new Error('等待上游页面原生数据请求超时，已有数据保留');
  } finally {
    if (target) await browser(['close', target]).catch(() => {});
  }
}

async function main() {
  const binary = process.env.MULTICC_BROWSER_BIN || path.join(os.homedir(), '.agents/skills/multicc-browser/bin/mbrowser');
  const profile = process.env.OPENROUTER_BROWSER_PROFILE || 'iso:tokyo-222-219';
  if (!/^iso:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profile)) throw new Error('必须指定隔离浏览器环境');
  // A private owner prevents a scheduled refresh from navigating or closing
  // tabs belonging to an interactive session or another concurrent refresh.
  const owner = 'openrouter-fetch-' + randomUUID();
  const browser = async args => {
    const result = await execute(process.execPath, [binary, ...args, '-p', profile, '--json'],
      { timeout: 40000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, MULTICC_SESSION_ID: owner } });
    return JSON.parse(result.stdout);
  };
  browser.owner = owner;
  process.stdout.write(await capture(browser));
}

if (require.main === module) main().catch(() => {
  console.error('隔离浏览器取数失败或超时，请检查隔离环境是否运行及上游页面；已有数据保留');
  process.exitCode = 1;
});
module.exports = { capture, readChart };
