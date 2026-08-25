'use strict';

function appTypeForCli(cli) {
  if (cli === 'codex') return 'codex';
  if (cli === 'claude' || cli === 'opencode') return 'claude';
  return null;
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
    if (!session) continue;
    const sessionType = appTypeForCli(session.cli);
    // OpenCode and ZCode can bind providers from either stored pool. Provider
    // ids are globally unique, so an exact id match is sufficient for them.
    if (session.cli !== 'opencode' && session.cli !== 'zcode' && sessionType !== type) continue;
    if (session.provider === id) {
      references.push(Object.freeze({
        kind: 'main',
        sessionId: String(session.id || ''),
        sessionName: String(session.name || session.label || session.id || ''),
      }));
    }
    if (session.providerSelection?.mode === 'auto'
        && session.providerSelection.candidates?.some(candidate => candidate.providerId === id)) {
      references.push(Object.freeze({
        kind: 'auto_candidate',
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
