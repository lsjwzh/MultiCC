'use strict';

// GET /api/quota/bars/idle — every quota bar's before-anything-happened render.
//
// A client opening a chat has no quota data: its cache may be empty or expired,
// and the fetches behind these bars are expensive enough (a 30-40s CDP browser
// drive, for several of them) that firing them all on page load would be worse
// than useless. So the bars start as click targets — "OpenCode Go 余量 · ⟳ 刷新"
// — and the words for that state come from the same place as every other bar
// state rather than being duplicated into each client as a hardcoded default.
//
// One request, at load, no vendor work: this handler renders from constants.

const { idleQuotaBars } = require('../quota/quota-bar-view');

function mountQuotaBarRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/quota/bars/idle', (req, res) => {
    res.json({ status: 'ok', bars: idleQuotaBars() });
  });
}

module.exports = { mountQuotaBarRoutes };
