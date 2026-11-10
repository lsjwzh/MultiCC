'use strict';

const { EVENT_TYPES, ALIASES } = require('./catalog');
const { ACTION_KINDS } = require('./rules');
const { SUPPORTED_CHAT_CLIS } = require('../cli-switch');
const { isAlias } = require('../cli/cli-capability');
const CLIENT_CHAT_CLIS = Object.freeze(SUPPORTED_CHAT_CLIS.filter(cli => !isAlias(cli)));

// HTTP surface: catalog, recent events, global rules CRUD, manual test emit.
function mountEventRoutes(app, { hub, engine }) {
  app.get('/api/events/catalog', (req, res) => {
    res.json({ events: EVENT_TYPES, aliases: ALIASES, actions: ACTION_KINDS, clis: CLIENT_CHAT_CLIS });
  });
  app.get('/api/events/recent', (req, res) => {
    const limit = parseInt(req.query.limit, 10);
    res.json({ events: hub.recent(Number.isNaN(limit) ? 50 : limit), runs: engine.recentResults(), chains: engine.pendingChains() });
  });
  app.get('/api/event-triggers', (req, res) => res.json({ items: engine.listAll() }));
  app.get('/api/event-rules', (req, res) => res.json({ rules: engine.listGlobal() }));
  app.post('/api/event-rules', (req, res) => {
    const result = engine.addGlobal(req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    return res.json(result.rule);
  });
  app.put('/api/event-rules/:id', (req, res) => {
    const result = engine.updateGlobal(req.params.id, req.body || {});
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result.rule);
  });
  app.delete('/api/event-rules/:id', (req, res) => {
    if (!engine.removeGlobal(req.params.id)) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true });
  });
  // Emit a synthetic event so a rule can be dry-run end to end.
  app.post('/api/events/test', (req, res) => {
    const body = req.body || {};
    if (!EVENT_TYPES.includes(body.type)) return res.status(400).json({ error: 'unknown event type' });
    const event = hub.emit(body.type, body.sessionId ? String(body.sessionId) : null,
      { goal: String(body.goal || 'test event').slice(0, 80), goalState: body.goalState || null }, { origin: 'manual-test' });
    return res.json({ ok: true, eventId: event && event.eventId });
  });
}

module.exports = { mountEventRoutes };
