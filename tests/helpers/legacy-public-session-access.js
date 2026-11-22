'use strict';

// Task execution slots are an internal transport detail. They deliberately
// reuse session records so the existing runners can execute work, but must
// never become addressable through user-facing session APIs.
function isInternalExecutionSlot(record) {
  return !!(record && record.taskExecutionSlot === true);
}

function createPublicSessionAccessGuard({ records, logger = null, v1NotFound = null } = {}) {
  if (!records || typeof records.get !== 'function') {
    throw new TypeError('[public-session-access] records map is required');
  }

  return function publicSessionAccessGuard(req, res, next) {
    const record = records.get(String(req.params?.id || ''));
    if (!isInternalExecutionSlot(record)) return next();

    // Use the same response as a missing session. Revealing that a guessed ID
    // is an internal worker would make the guard itself an enumeration oracle.
    logger?.warn?.('internal_execution_slot_public_access_denied', {
      method: req.method || null,
    });
    if (String(req.originalUrl || req.url || '').startsWith('/api/v1/')
        && typeof v1NotFound === 'function') {
      return v1NotFound(req, res);
    }
    return res.status(404).json({ error: 'session not found' });
  };
}

function mountPublicSessionAccessGuard(app, options) {
  if (!app || typeof app.use !== 'function') {
    throw new TypeError('[public-session-access] express app is required');
  }
  const guard = createPublicSessionAccessGuard(options);
  app.use('/api/sessions/:id', guard);
  app.use('/api/v1/sessions/:id', guard);
}

module.exports = {
  createPublicSessionAccessGuard,
  isInternalExecutionSlot,
  mountPublicSessionAccessGuard,
};
