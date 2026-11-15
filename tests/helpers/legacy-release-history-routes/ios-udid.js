'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const express = require('express');
const { absoluteBaseUrl, xmlEscape } = require('./ios-ota');

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const UDID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{8}-[a-f0-9]{16})$/i;
const TTL_MS = 30 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

function buildProfile(baseUrl, token, challenge) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><dict>
<key>URL</key><string>${xmlEscape(baseUrl)}/ios-ota/udid/callback/${token}</string>
<key>DeviceAttributes</key><array><string>UDID</string><string>PRODUCT</string><string>VERSION</string></array>
<key>Challenge</key><string>${challenge}</string>
</dict>
<key>PayloadOrganization</key><string>MultiCC</string>
<key>PayloadDisplayName</key><string>MultiCC 获取设备 UDID</string>
<key>PayloadDescription</key><string>仅向你正在访问的 MultiCC 服务器发送设备 UDID、机型和系统版本，用于登记测试设备。不安装证书、VPN 或远程管理。</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadIdentifier</key><string>com.multicc.udid.${token}</string>
<key>PayloadType</key><string>Profile Service</string>
</dict></plist>`;
}

// 验证 CMS 内容签名，但不把证书链当作苹果硬件身份证明。
// 数据只用于展示/复制；绝不能据此授予设备权限或自动登记开发者账号。
// 输入/输出和运行时间均有上限，不落盘，不记录设备标识或证书。
function decodeSignedResponse(body) {
  return new Promise((resolve, reject) => {
    const child = execFile('openssl', ['cms', '-verify', '-inform', 'DER', '-noverify', '-binary'],
      { timeout: 5000, maxBuffer: MAX_BYTES, encoding: 'utf8', windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  });
}

function parseDevicePlist(xml) {
  // 只支持 Profile Service 返回的扁平字符串字典。无通用 XML 实体、
  // DTD 或嵌套对象解析，避免把设备回传变成 XML/实体展开入口。
  let text = String(xml).trim().replace(/^<\?xml\s[^?]*\?>\s*/, '');
  text = text.replace(/^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*/, '');
  const match = /^<plist\s+version="1\.0">\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>$/.exec(text);
  if (!match) throw new Error('invalid_plist');
  const values = Object.create(null);
  const rest = match[1].replace(/<key>([A-Z_]+)<\/key>\s*<string>([^<]*)<\/string>/g, (_, key, value) => {
    if (Object.hasOwn(values, key) || value.length > 256 || /[&\x00-\x1f]/.test(value)) throw new Error('invalid_field');
    values[key] = value;
    return '';
  });
  if (rest.trim() || !UDID_PATTERN.test(values.UDID || '') || !TOKEN_PATTERN.test(values.CHALLENGE || '')) {
    throw new Error('invalid_device');
  }
  for (const key of ['PRODUCT', 'VERSION']) {
    if (values[key] && !/^[a-z0-9,._ -]{1,80}$/i.test(values[key])) throw new Error('invalid_field');
  }
  return { udid: values.UDID, product: values.PRODUCT || '', version: values.VERSION || '', challenge: values.CHALLENGE };
}

function resultPage(device) {
  const content = device ? `<h1>已获取设备 UDID</h1>
<p>设备信息已读取成功。这不代表设备已登记，也不代表 App 已安装。</p>
<label for="udid-value">设备 UDID</label>
<input id="udid-value" readonly autocomplete="off" spellcheck="false" value="${xmlEscape(device.udid)}">
<p>${xmlEscape([device.product, device.version].filter(Boolean).join(' · '))}</p>
<button id="udid-copy" type="button">复制 UDID</button><p id="udid-copy-status" role="status" aria-live="polite"></p>
<p>请把 UDID 交给 App 发布者，在苹果开发者账号登记后，重新签名并发布包含本机 UDID 的 Ad Hoc 安装包。</p>
<p>此结果链接 30 分钟内有效，仅用于查看本次设备信息，请勿转发。服务器重启后结果会失效。</p>`
    : '<h1>设备信息已过期</h1><p>请返回安装页重新获取 UDID，并安装新下载的描述文件。</p>';
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>MultiCC — 设备 UDID</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#0d1117;color:#e6edf3;font:15px/1.8 -apple-system,BlinkMacSystemFont,sans-serif}
main{max-width:520px;margin:24px auto;padding:24px;background:#161b22;border:1px solid #30363d;border-radius:12px}
h1{font-size:21px}p{color:#b1bac4}input{width:100%;margin-top:8px;padding:12px;background:#0d1117;color:#e6edf3;border:1px solid #484f58;border-radius:6px;font:13px monospace}
button{padding:12px 20px;border:0;border-radius:8px;background:#238636;color:white;font:inherit;cursor:pointer}a{color:#58a6ff}
</style></head><body><main>${content}<a href="/ios-ota">返回安装页</a></main>
<script src="/ios-udid-result.js"></script></body></html>`;
}

function createIosUdid({ now = Date.now, decode = decodeSignedResponse } = {}) {
  const pending = new Map();
  const results = new Map();
  let active = 0;
  function cleanup() {
    for (const [token, item] of pending) if (item.expires <= now()) pending.delete(token);
    for (const [token, item] of results) if (item.expires <= now()) results.delete(token);
  }
  function privateResponse(res) {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
  }
  function profile(req, res) {
    privateResponse(res);
    const base = absoluteBaseUrl(req);
    if (!base.startsWith('https://')) return res.status(400).type('text').send('请使用 HTTPS 地址获取 UDID。');
    if (req.get('Sec-Fetch-Site') === 'cross-site') return res.sendStatus(403);
    cleanup();
    if (pending.size + results.size >= 128) return res.status(429).type('text').send('获取请求过多，请稍后重试。');
    const token = randomBytes(32).toString('hex');
    const challenge = randomBytes(32).toString('hex');
    pending.set(token, { challenge, base, expires: now() + TTL_MS, busy: false });
    res.set('Content-Disposition', 'attachment; filename="multicc-udid.mobileconfig"');
    return res.type('application/x-apple-aspen-config').send(buildProfile(base, token, challenge));
  }
  function validateCallback(req, res, next) {
    privateResponse(res);
    cleanup();
    const item = TOKEN_PATTERN.test(req.params.token) && pending.get(req.params.token);
    if (!item) return res.status(410).type('text').send('此请求已过期或已使用，请回到安装页重新获取 UDID。');
    if (item.busy || active >= 4) return res.status(429).type('text').send('正在处理设备信息，请稍后重试。');
    return next();
  }
  async function callback(req, res) {
    const item = pending.get(req.params.token);
    if (!item || item.expires <= now()) return res.sendStatus(410);
    if (item.busy || active >= 4) return res.sendStatus(429);
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.sendStatus(400);
    item.busy = true;
    active++;
    try {
      const device = parseDevicePlist(await decode(req.body));
      if (device.challenge !== item.challenge) return res.status(400).type('text').send('设备信息校验失败，请重新获取。');
      pending.delete(req.params.token);
      const resultToken = randomBytes(32).toString('hex');
      results.set(resultToken, { device, expires: now() + TTL_MS });
      // Profile Service 用 301 交回浏览器；目标必须不依赖 Safari cookie。
      // 基址取本次描述文件的下载入口，不取回传头，更不能写死某台机器的域名。
      // URL 只携带短期结果能力令牌，不含 UDID；no-store 防止缓存 301。
      return res.status(301).set('Location', `${item.base}/ios-ota/udid/result/${resultToken}`).end();
    } catch (error) {
      const unavailable = error.code === 'ENOENT';
      return res.status(unavailable ? 503 : 400).type('text').send(unavailable
        ? '服务器需要安装 OpenSSL 才能读取设备回传，请联系管理员。'
        : '无法读取设备信息，请回到安装页重新获取 UDID。');
    } finally {
      item.busy = false;
      active--;
    }
  }
  function result(req, res) {
    privateResponse(res);
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    cleanup();
    const item = TOKEN_PATTERN.test(req.params.token) && results.get(req.params.token);
    return res.status(item ? 200 : 410).type('html').send(resultPage(item?.device));
  }
  function mountRoutes(app) {
    app.get('/ios-ota/udid.mobileconfig', profile);
    app.get('/ios-ota/udid/result/:token', result);
    app.post('/ios-ota/udid/callback/:token', validateCallback,
      (req, res, next) => express.raw({ type: () => true, limit: MAX_BYTES, inflate: false })(req, res, error => {
        if (error) return res.status(error.status === 413 ? 413 : 400).type('text').send('设备信息格式无效或超过大小限制。');
        return next();
      }), callback);
  }
  return { mountRoutes };
}

module.exports = { createIosUdid, buildProfile, parseDevicePlist, decodeSignedResponse, resultPage, UDID_PATTERN, TTL_MS };
