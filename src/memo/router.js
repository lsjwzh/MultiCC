'use strict';

const express = require('express');
const { asyncRoute } = require('../http');

function createMemoRouter(controller) {
  if (!controller || typeof controller.read !== 'function'
    || typeof controller.write !== 'function' || typeof controller.send !== 'function') {
    throw new TypeError('memo router requires a controller');
  }

  const router = express.Router();
  router.get('/api/directories/:id/memo', asyncRoute(async (req, res) => {
    res.json(await controller.read({ directoryId: req.params.id }));
  }));
  router.put('/api/directories/:id/memo', asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    res.json(await controller.write({ directoryId: req.params.id, text: body.text }));
  }));
  router.post('/api/directories/:id/memo/send', asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    res.json(await controller.send({
      directoryId: req.params.id,
      text: body.text,
      sessionId: body.sessionId,
    }));
  }));
  return router;
}

module.exports = { createMemoRouter };
