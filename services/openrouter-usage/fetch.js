// OpenRouter Token 用量抓取脚本（供 cron 与 POST /refresh 调用）
// 流程: 专用 Chrome + CDP 打开 MacroMicro 图表页, 等待页面自身发起 /charts/data/148532,
//       抓响应体 -> 校验 -> 转换为 slim data.json -> 原子写盘 -> 退出。
// 无头会被 Cloudflare 质询卡住时自动换有头重试一次。
'use strict';
const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHART_URL = 'https://en.macromicro.me/charts/148532/world-openrouter-token-usage';
const DATA_API_MARK = '/charts/data/148532';
const PROFILE = path.join(process.env.HOME, 'Library/Application Support/openrouter-usage/chrome-profile');
const OUT = path.join(__dirname, 'public', 'data.json');
const RAW = path.join(__dirname, 'public', 'raw.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.8059.40 Safari/537.36';
const PORT = Number(process.env.FETCH_CDP_PORT || 3313);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function jget(p) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2000 }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej).on('timeout', function () { this.destroy(); rej(new Error('timeout')); }));
}
function jput(p) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'PUT', timeout: 3000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on('error', rej); req.end();
  });
}

function launchChrome(headless) {
  const args = [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', `--user-agent=${UA}`,
    '--window-size=1280,900', 'about:blank'
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function killAndWaitPortFree() {
  spawn('pkill', ['-f', `remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    await sleep(700);
    const busy = await jget('/json/version').then(() => true, () => false);
    const lock = fs.existsSync(path.join(PROFILE, 'SingletonLock'));
    if (!busy && !lock) return;
  }
  log('警告: 旧 Chrome 未在 20s 内退净, 继续尝试');
}

async function grabOnce(headless) {
  const chrome = launchChrome(headless);
  try {
    // 等 CDP 就绪（有头首次 Rosetta/冷启可能慢，给 60 拍）
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(500);
      const list = await jget('/json').catch(() => null);
      if (!list) continue;
      page = list.find(t => t.type === 'page' && !t.url.startsWith('devtools'));
      if (!page) await jput('/json/new?' + encodeURIComponent('about:blank')).catch(() => {});
    }
    if (!page) throw new Error('CDP 未就绪');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    let id = 0; const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    let dataReq = null; const finished = new Set();
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      } else if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes(DATA_API_MARK)) {
        dataReq = m.params.requestId;
      } else if (m.method === 'Network.loadingFinished' && m.params.requestId === dataReq) {
        finished.add(dataReq);
      }
    });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    await send('Network.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: CHART_URL });
    // 等页面自己发出数据请求并完成（无头卡质询时这里超时）
    const t0 = Date.now();
    while (Date.now() - t0 < (headless ? 30000 : 60000) && !finished.has(dataReq)) await sleep(1500);
    if (!dataReq) throw new Error(headless ? 'HEADCHECK_BLOCKED' : '页面未发起数据请求');
    const body = await send('Network.getResponseBody', { requestId: dataReq });
    ws.close();
    return String(body.body);
  } finally {
    try { chrome.kill(); } catch (_) {}
    await killAndWaitPortFree();
  }
}

function transform(raw) {
  const j = JSON.parse(raw);
  if (j.success !== 1 || !j.data || !j.data['c:148532']) throw new Error('接口返回异常: ' + raw.slice(0, 120));
  const c = j.data['c:148532'];
  const cfgs = c.info.chart_config.seriesConfigs;
  const dateSet = new Set();
  c.series.forEach(arr => arr.forEach(p => dateSet.add(p[0])));
  const dates = [...dateSet].sort();
  const series = cfgs.map((g, i) => {
    const m = Object.fromEntries(c.series[i].map(p => [p[0], +p[1]]));
    return { name: g.name_en, values: dates.map(d => m[d] !== undefined ? m[d] : null) };
  });
  return {
    updated: new Date().toISOString().slice(0, 10),
    source: 'MacroMicro chart 148532 (https://en.macromicro.me/charts/148532/world-openrouter-token-usage)',
    unit: 'b', unitLabel: '十亿 token/日 (b)',
    dates, series
  };
}

async function main() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  let raw;
  try {
    log('尝试无头…');
    raw = await grabOnce(true);
    log('无头成功');
  } catch (e) {
    if (e.message !== 'HEADCHECK_BLOCKED' && e.message !== 'CDP 未就绪' && !/页面未发起数据请求/.test(e.message)) {
      // 非质询类错误，先看有头能否救
      log('无头异常:', e.message);
    } else {
      log('无头被 Cloudflare 拦，换有头…');
    }
    raw = await grabOnce(false);
    log('有头成功');
  }
  const slim = transform(raw);
  // 与上次比：日期不得倒退
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (slim.dates.length && slim.dates[slim.dates.length - 1] < prev.dates[prev.dates.length - 1]) {
      throw new Error('新数据日期倒退，拒绝写盘');
    }
  } catch (e) { if (e.code !== 'ENOENT' && /倒退/.test(e.message)) throw e; }
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(slim));
  fs.renameSync(tmp, OUT);
  fs.writeFileSync(RAW + '.tmp', raw); fs.renameSync(RAW + '.tmp', RAW);
  const last = slim.dates[slim.dates.length - 1];
  log(`完成: ${slim.dates.length} 天 × ${slim.series.length} 家, 最新 ${last}`);
}

main().then(() => process.exit(0)).catch(e => { console.error('FETCH_FAILED:', e.message); process.exit(1); });
