'use strict';

// Express/ws SDK adaptation only. Identity, persistence, endpoint validation,
// credential handling and remote HTTP transport live in native/core/machines.
const { getNative } = require('./native/runtime');

function createMachineRuntime({ root, authSecurity, getWss = () => null }) {
  function native() {
    const addon = getNative('machines', 'rust');
    if (typeof addon?.machineOperation !== 'function') throw new Error('machine_native_unavailable');
    return addon;
  }
  async function operate(operation, input = {}) {
    try { return JSON.parse(await native().machineOperation(root, operation, JSON.stringify(input))); }
    catch (_) { return { status: 503, data: { code: 'machine_native_unavailable', error: '多电脑组件尚未就绪，请更新后手动重启服务' } }; }
  }
  function authorize(req) {
    const credential = req.headers['x-multicc-machine-grant'];
    if (!credential) return false;
    try {
      req.machineGrantId = native().authorizeMachineRequest(root, credential, req.method, req.originalUrl);
      return !!req.machineGrantId;
    } catch (_) { return false; }
  }
  function active(id) {
    try { return native().machineGrantActive(root, id); } catch (_) { return false; }
  }
  function closeRevoked() {
    for (const ws of getWss()?.clients || []) {
      if (ws._machineGrantId && !active(ws._machineGrantId)) ws.close(4003, '电脑授权已撤销');
    }
  }
  function send(res, response) {
    res.set('Cache-Control', 'no-store');
    if (response.body !== undefined) {
      for (const [name, value] of Object.entries(response.headers || {})) res.set(name, value);
      return res.status(response.status).send(Buffer.from(response.body, 'base64'));
    }
    return res.status(response.status).json(response.data);
  }
  function mount(app, express) {
    const json = express.json({ limit: '16kb' });
    const route = (method, path, operation, input = req => req.body || {}) => app[method](path, json, async (req, res) => send(res, await operate(operation, input(req))));
    // Mounted before the global JSON parser: preserve multipart and binary bodies.
    app.use('/api/machines/:machineId/proxy', express.raw({ type: () => true, limit: '48mb' }), async (req, res) => {
      if (req.method === 'GET' && req.headers.accept?.includes('text/event-stream')) {
        try {
          const result = await native().machineEventStream(root, JSON.stringify({ id: req.params.machineId, path: req.url }), (error, raw) => {
            if (error || res.destroyed || res.writableEnded) return false;
            const event = JSON.parse(raw);
            if (event.status) { res.status(event.status).set(event.headers).set('Cache-Control', 'no-store'); res.flushHeaders(); }
            if (event.body) res.write(Buffer.from(event.body, 'base64'));
            return res.writableLength < 1024 * 1024;
          });
          if (!res.headersSent) send(res, JSON.parse(result)); else res.end();
        } catch (_) { if (!res.headersSent) send(res, { status: 503, data: { error: '电脑实时连接不可用' } }); else res.end(); }
        return;
      }
      const response = await operate('proxy', {
        id: req.params.machineId, path: req.url, method: req.method,
        headers: req.headers, body: Buffer.isBuffer(req.body) ? req.body.toString('base64') : undefined,
      });
      send(res, response);
    });
    route('get', '/api/machines', 'list');
    route('get', '/api/machines/self', 'self');
    route('get', '/api/machines/grants', 'grants');
    app.post('/api/machines/pair', json, async (req, res) => {
      if (!authSecurity.verifyAccessToken(req.headers['x-access-token'])) return res.status(403).json({ error: '目标电脑访问密码不正确，或尚未设置访问密码' });
      const result = await operate('pair', req.body);
      closeRevoked();
      send(res, result);
    });
    app.delete('/api/machines/connection', async (req, res) => {
      if (!req.machineGrantId) return res.status(403).json({ error: '缺少电脑授权' });
      const result = await operate('revoke', { id: req.machineGrantId });
      closeRevoked(); send(res, result);
    });
    app.delete('/api/machines/grants/:grantId', async (req, res) => {
      const result = await operate('revoke', { id: req.params.grantId });
      closeRevoked(); send(res, result);
    });
    route('post', '/api/machines', 'add');
    route('patch', '/api/machines/:machineId', 'rename', req => ({ ...req.body, id: req.params.machineId }));
    route('delete', '/api/machines/:machineId', 'remove', req => ({ id: req.params.machineId }));
    app.post('/api/machines/:machineId/ws-ticket', json, async (req, res) => {
      const result = await operate('websocket', { id: req.params.machineId, path: req.body?.path });
      if (result.status !== 200) return send(res, result);
      const proxyPath = `/ws/machines/${req.params.machineId}`;
      const issued = authSecurity.issueWsTicket(proxyPath, { machineId: req.params.machineId, upstream: result.data });
      send(res, { status: 200, data: { ...issued, path: result.data.path, proxyPath } });
    });
  }
  return { operate, authorize, active, mount, closeRevoked };
}
module.exports = { createMachineRuntime };
