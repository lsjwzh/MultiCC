'use strict';

function appTypeForCli(cli) {
  return cli === 'codex' ? 'codex' : 'claude';
}

function findProviderReferences({ appType, providerId, sessions, defaults, aux } = {}) {
  const type = String(appType || '').trim();
  const id = String(providerId || '').trim();
  if (!['claude', 'codex'].includes(type) || !id) return [];
  const references = [];
  const values = sessions instanceof Map
    ? sessions.values()
    : (Array.isArray(sessions) ? sessions : []);

  for (const session of values) {
    if (!session || appTypeForCli(session.cli) !== type) continue;
    if (session.provider === id) {
      references.push(Object.freeze({
        kind: 'main',
        sessionId: String(session.id || ''),
        sessionName: String(session.name || session.label || session.id || ''),
      }));
    }
    if (session.subagent && session.subagent.providerId === id) {
      references.push(Object.freeze({
        kind: 'subagent',
        sessionId: String(session.id || ''),
        sessionName: String(session.name || session.label || session.id || ''),
      }));
    }
  }

  if (defaults && defaults[type] === id) {
    references.push(Object.freeze({ kind: 'default', cli: type }));
  }
  const auxType = aux && String(aux.protocol || '').toLowerCase() === 'openai' ? 'codex' : 'claude';
  if (aux && aux.providerId === id && auxType === type) {
    references.push(Object.freeze({ kind: 'aux', protocol: aux.protocol || 'anthropic' }));
  }
  return Object.freeze(references);
}

module.exports = { findProviderReferences };
