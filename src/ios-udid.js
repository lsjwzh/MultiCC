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

function createIosUdid({ now = Date.now, decode = decodeSignedResponse } = {}) {
  const pending = new Map();
  let active = 0;
  function cleanup() {
    for (const [token, item] of pending) if (item.expires <= now()) pending.delete(token);
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
    if (pending.size >= 128) return res.status(429).type('text').send('获取请求过多，请稍后重试。');
    const token = randomBytes(32).toString('hex');
    const challenge = randomBytes(32).toString('hex');
    pending.set(token, { challenge, expires: now() + TTL_MS, busy: false });
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
      // fragment 不会发送给 Web 服务器或随 Referer 泄漏；页面读取后立即清除。
      const fragment = new URLSearchParams({ udid: device.udid, product: device.product, version: device.version });
      return res.redirect(303, `/ios-ota#${fragment}`);
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
  function mountRoutes(app) {
    app.get('/ios-ota/udid.mobileconfig', profile);
    app.post('/ios-ota/udid/callback/:token', validateCallback,
      (req, res, next) => express.raw({ type: () => true, limit: MAX_BYTES, inflate: false })(req, res, error => {
        if (error) return res.status(error.status === 413 ? 413 : 400).type('text').send('设备信息格式无效或超过大小限制。');
        return next();
      }), callback);
  }
  return { mountRoutes };
}

module.exports = { createIosUdid, buildProfile, parseDevicePlist, decodeSignedResponse, UDID_PATTERN, TTL_MS };
