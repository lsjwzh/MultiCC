'use strict';
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { createPaths } = require('./paths');
const { atomicWriteJson } = require('./runtime-security');
const PREFIX = '/services/';
const WARNING = '免密码会让任何能访问 MultiCC 入口的人访问此服务的全部页面、接口及 WebSocket，包括写入和删除操作。路由与 MultiCC 同域，只能接入你信任的服务：其页面脚本可使用当前登录身份访问 MultiCC。鉴权仅保护此入口，不保护上游原始端口。';

function validate(input) {
  if (!input || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(input.name)) throw new Error('名称限 1–48 位小写字母、数字、连字符');
  let url;
  try { url = new URL(input.target); } catch { throw new Error('请输入有效的 HTTP(S) 上游地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('上游只支持 HTTP(S)，不能包含凭据、查询或片段');
  if (!['private', 'public'].includes(input.access ?? 'private')) throw new Error('无效访问模式');
  return { name: input.name, target: url.href.replace(/\/$/, ''), access: input.access ?? 'private', enabled: input.enabled !== false };
}

function cleanHeaders(source) {
  const headers = { ...source };
  const connection = String(headers.connection || '').split(',').map(x => x.trim().toLowerCase());
  for (const key of [...connection, 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete headers[key];
  for (const key of Object.keys(headers)) {
    if (key.startsWith('x-multicc-') || key.startsWith('x-forwarded-') || ['x-access-token', 'forwarded'].includes(key)) delete headers[key];
  }
  if (headers.cookie) {
    headers.cookie = headers.cookie.split(';').filter(x => !/^\s*multicc_/i.test(x)).join(';');
    if (!headers.cookie) delete headers.cookie;
  }
  return headers;
}

function createServiceRoutes({ file = createPaths().serviceRoutesFile, authenticate, peerAllowed = () => true } = {}) {
  let routes = [];
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(stored)) throw new Error('Invalid service routes store');
    routes = stored.map(validate);
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const save = next => { atomicWriteJson(file, next); routes = next; };
  function match(raw) {
    const path = String(raw || '').split('?')[0];
    if (path !== '/services' && !path.startsWith(PREFIX)) return null;
    const name = path.slice(PREFIX.length).split('/')[0];
    return { route: routes.find(r => r.name === name && r.enabled), prefix: PREFIX + name };
  }
  function allowed(req, route) {
    if (route.access === 'private' && req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return false; }
      catch { return false; }
    }
    return peerAllowed(req) && (route.access === 'public' || authenticate(req));
  }
  function forward(req, output, hit, head) {
    const ws = head !== undefined;
    const fail = code => {
      if (ws) { if (!output.destroyed) output.end(`HTTP/1.1 ${code} Error\r\nConnection: close\r\n\r\n`); }
      else if (!output.headersSent) output.status(code).json({ error: code === 508 ? 'service_route_loop' : 'upstream_unavailable' });
      else output.destroy();
    };
    if (req.headers['x-multicc-service-hop']) return fail(508);
    const target = new URL(hit.route.target);
    let suffix = req.url.slice(hit.prefix.length);
    if (!suffix || suffix.startsWith('?')) suffix = '/' + suffix;
    const queryIndex = suffix.indexOf('?');
    if (queryIndex >= 0) {
      const query = new URLSearchParams(suffix.slice(queryIndex + 1));
      if (query.has('token')) { query.delete('token'); suffix = suffix.slice(0, queryIndex) + (query.size ? '?' + query : ''); }
    }
    const headers = cleanHeaders(req.headers);
    headers.host = target.host;
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
    headers['x-forwarded-prefix'] = hit.prefix;
    headers['x-multicc-service-hop'] = '1';
    if (ws) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    const upstream = (target.protocol === 'https:' ? https : http).request({
      hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || undefined,
      method: req.method, path: target.pathname.replace(/\/$/, '') + suffix, headers,
    });
    upstream.setTimeout(120000, () => upstream.destroy());
    upstream.on('error', () => fail(502));
    upstream.on('response', response => {
      if (ws) { response.resume(); fail(502); return; }
      const result = cleanHeaders(response.headers);
      result['cache-control'] = 'no-store';
      if (result['set-cookie']) result['set-cookie'] = result['set-cookie']
        .filter(cookie => !/^\s*multicc_/i.test(cookie))
        .map(cookie => cookie.replace(/;\s*(path|domain)=[^;]*/gi, '') + `; Path=${hit.prefix}/`);
      if (result.location) {
        try {
          const location = new URL(result.location, target.origin + target.pathname.replace(/\/$/, '') + suffix);
          const base = target.pathname.replace(/\/$/, '');
          if (location.origin === target.origin && (location.pathname === base || location.pathname.startsWith(base + '/'))) {
            result.location = hit.prefix + (location.pathname.slice(base.length) || '/') + location.search + location.hash;
          }
        } catch { delete result.location; }
      }
      output.writeHead(response.statusCode, result);
      response.on('error', () => output.destroy());
      output.on('close', () => response.destroy());
      response.pipe(output);
    });
    if (ws) {
      output.on('error', () => upstream.destroy());
      upstream.on('upgrade', (response, socket, upstreamHead) => {
        socket.setTimeout(0);
        const result = cleanHeaders(response.headers);
        delete result['set-cookie'];
        result.connection = 'Upgrade'; result.upgrade = 'websocket';
        output.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(result).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
        if (upstreamHead.length) output.write(upstreamHead);
        if (head.length) socket.write(head);
        socket.on('error', () => output.destroy());
        output.on('error', () => socket.destroy());
        output.on('close', () => socket.destroy());
        socket.on('close', () => output.destroy());
        socket.pipe(output); output.pipe(socket);
      });
      output.on('close', () => upstream.destroy());
      upstream.end();
    } else {
      req.on('aborted', () => upstream.destroy());
      output.on('close', () => upstream.destroy());
      req.pipe(upstream);
    }
  }
  function handleHttp(req, res) {
    const hit = match(req.url);
    if (!hit) return false;
    res.setHeader('Cache-Control', 'no-store');
    if (!hit.route) res.status(404).json({ error: 'service_route_not_found' });
    else if (!allowed(req, hit.route)) {
      if (req.method === 'GET' && req.accepts('html')) res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
      else res.status(401).json({ error: 'authentication_required' });
    } else if (req.url.split('?')[0] === hit.prefix) res.redirect(308, hit.prefix + '/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
    else forward(req, res, hit);
    return true;
  }
  function handleUpgrade(req, socket, head) {
    const hit = match(req.url);
    if (!hit) return false;
    req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    if (!hit.route || !allowed(req, hit.route)) socket.end(`HTTP/1.1 ${hit.route ? 401 : 404} Rejected\r\nConnection: close\r\n\r\n`);
    else forward(req, socket, hit, head);
    return true;
  }
  function mountManagement(app) {
    app.use('/api/service-routes', (req, res, next) => {
      if (!authenticate(req)) return res.status(401).json({ error: 'authentication_required' });
      // Never accept cross-origin writes, including from localhost callers.
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'origin_mismatch' }); }
        catch { return res.status(403).json({ error: 'origin_mismatch' }); }
      }
      next();
    });
    app.get('/api/service-routes', (req, res) => res.json({ routes, warning: WARNING }));
    app.put('/api/service-routes/:name', (req, res) => {
      let route;
      try {
        route = validate({ ...req.body, name: req.params.name });
        if (route.access === 'public' && req.body?.acknowledgePublicRisk !== true) throw new Error('启用免密码模式必须确认公开访问风险');
      } catch (err) { return res.status(400).json({ error: err.message }); }
      try { save([...routes.filter(r => r.name !== route.name), route]); res.json(route); }
      catch { res.status(500).json({ error: 'service_routes_save_failed' }); }
    });
    app.delete('/api/service-routes/:name', (req, res) => {
      try { save(routes.filter(r => r.name !== req.params.name)); res.json({ ok: true }); }
      catch { res.status(500).json({ error: 'service_routes_save_failed' }); }
    });
  }
  return { handleHttp, handleUpgrade, mountManagement };
}
module.exports = { createServiceRoutes, validate, WARNING };
