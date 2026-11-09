'use strict';

// Frozen oracle for the pre-migration live chat-session table:
//
//   const chatSessions = new Map();                       // server.js
//   cs = { clients: new Set(), claudeProc: null, ... };   // turn-engine.js
//   chatSessions.set(sessionName, cs);
//
// Both construction sites in src/chat/turn-engine.js use this exact field
// order. The native owner keeps these objects as opaque host references, so
// tests use this helper to build the same literal shape and compare membership,
// order and object identity against the `src/chat/sessions.js` facade.

function createLegacyChatSession(fields = {}) {
  return {
    clients: new Set(),
    claudeProc: fields.claudeProc === undefined ? null : fields.claudeProc,
    lineBuf: '',
    cli: fields.cli || 'claude',
    chatTurnCount: fields.chatTurnCount || 0,
    cwd: fields.cwd || '/tmp/session',
    currentAssistantText: '',
    currentToolCalls: [],
    currentCost: null,
    isStreaming: false,
    streamReplay: [],
    _classifyTimer: null,
    _classifyTaskId: null,
    _currentTaskId: fields.currentTaskId === undefined ? null : fields.currentTaskId,
  };
}

function createLegacyChatSessions() {
  return new Map();
}

module.exports = { createLegacyChatSession, createLegacyChatSessions };
