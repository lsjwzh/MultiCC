'use strict';
// Directory-domain controller — express Router mapping HTTP ↔ service results.
// Zero business logic here: parse request inputs, call the service, translate
// its {ok, code, message, extra} results to status codes + JSON bodies. Mounted
// by server.js at the same middleware position the inline routes occupied.
const express = require('express');

const STATUS = { not_found: 404, invalid: 400, internal: 500 };

function send(res, r) {
  if (r.ok) return res.json(r.data);
  const status = STATUS[r.code] || 500;
  const body = { code: r.code || 'internal', error: r.message, ...(r.extra || {}) };
  if (status >= 500 && res.locals && res.locals.requestId) body.requestId = res.locals.requestId;
  return res.status(status).json(body);
}

// Wrap async handlers so a rejected promise becomes a JSON 500 instead of a
// hanging request (express 4 does not catch async throws).
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res))
  .catch(() => {
    if (!res.headersSent) {
      res.status(500).json({
        code: 'internal',
        error: 'internal_error',
        ...(res.locals && res.locals.requestId ? { requestId: res.locals.requestId } : {}),
      });
    }
  });

function createDirectoryRouter(service) {
  const router = express.Router();

  router.get('/api/fs/list', wrap((req, res) => send(res, service.browseFs(req.query.path))));

  router.get('/api/directories', wrap(async (req, res) => send(res, await service.listAnnotated())));

  router.post('/api/directories', wrap(async (req, res) => send(res, await service.register({
    name: req.body.name, path: req.body.path, create: req.body.create,
  }))));

  router.post('/api/onboarding/sample-workspace', wrap(async (_req, res) => send(res, await service.createSample())));

  router.patch('/api/directories/:id', wrap(async (req, res) => send(res, await service.update(req.params.id, req.body || {}))));

  router.delete('/api/directories/:id', wrap(async (req, res) =>
    send(res, await service.remove(req.params.id, { force: req.query.force === '1' }))));

  router.post('/api/directories/:id/push', wrap(async (req, res) => send(res, await service.push(req.params.id))));

  router.get('/api/directories/:id/uncommitted', wrap(async (req, res) =>
    send(res, await service.uncommitted(req.params.id))));

  router.post('/api/directories/:id/commit', wrap(async (req, res) =>
    send(res, await service.commitAll(req.params.id, req.body && req.body.message))));

  return router;
}

module.exports = { createDirectoryRouter };
