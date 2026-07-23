'use strict';

function normalized(value) {
  return value == null ? '' : String(value).trim().toLocaleLowerCase();
}

// Terminal work is executed by a chat gateway because a raw terminal session
// has no model turn/history channel. New records carry gatewayFor explicitly.
// The exact "<terminal-id>-gw-chat" relation is retained only for gateways
// created before that metadata existed; labels are deliberately never used.
function terminalForRecord(records, record) {
  if (!record || !records || typeof records.get !== 'function') return null;
  if (record.kind === 'terminal') return record;

  const explicitId = record.gatewayFor == null ? '' : String(record.gatewayFor).trim();
  const legacyId = record.kind === 'chat' && record.ephemeral === true
    && String(record.id || '').endsWith('-gw-chat')
    ? String(record.id).slice(0, -'-gw-chat'.length)
    : '';
  const terminalId = explicitId || legacyId;
  if (!terminalId) return null;
  const terminal = records.get(terminalId);
  if (!terminal || terminal.kind !== 'terminal' || terminal.dirId !== record.dirId) return null;
  return terminal;
}

function isTerminalGateway(records, record) {
  return !!record && record.kind === 'chat' && !!terminalForRecord(records, record);
}

// "Install/configure a terminal" describes the task, not the destination.
// Terminal routing is explicit only when the originating user text names the
// exact stable session id or its complete non-empty label.
function explicitlyNamesTerminal(userText, terminal) {
  const text = normalized(userText);
  if (!text || !terminal) return false;
  const id = normalized(terminal.id);
  const label = normalized(terminal.label);
  return !!((id && text.includes(id)) || (label && text.includes(label)));
}

module.exports = {
  explicitlyNamesTerminal,
  isTerminalGateway,
  terminalForRecord,
};
