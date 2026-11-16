'use strict';

// 冻结基线：`src/providers/references.js` 在规则迁入 Rust 之前的实现
// （取自提交 0860ed62，与 `git show 0860ed62:src/providers/references.js` 逐字一致）。
// 对拍脚本用它作为 oracle；它刻意不再随生产代码变化，所以 Rust 侧的任何
// 行为漂移都会在对比里暴露，而不是跟着一起漂走。
function appTypeForCli(cli) {
  if (cli === 'codex' || cli === 'codex-exp') return 'codex';
  if (cli === 'claude' || cli === 'claude-exp' || cli === 'opencode') return 'claude';
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
