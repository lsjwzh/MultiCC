'use strict';

function requirePort(port, name, methods) {
  if (!port || typeof port !== 'object') {
    throw new TypeError(`[session] ${name} port is required`);
  }
  for (const method of methods) {
    if (typeof port[method] !== 'function') {
      throw new TypeError(`[session] ${name}.${method} must be a function`);
    }
  }
  return port;
}

function assertSessionRecordsPort(port) {
  return requirePort(port, 'records', ['list', 'get']);
}

function assertSessionRuntimePort(port) {
  return requirePort(port, 'runtime', ['read']);
}

function assertWorkspaceFactsPort(port) {
  return requirePort(port, 'workspaceFacts', ['read']);
}

function assertDirectoryRecordsPort(port) {
  return requirePort(port, 'directories', ['list', 'get']);
}

function assertChatHistoryPort(port) {
  return requirePort(port, 'history', ['read', 'write']);
}

module.exports = {
  assertChatHistoryPort,
  assertDirectoryRecordsPort,
  assertSessionRecordsPort,
  assertSessionRuntimePort,
  assertWorkspaceFactsPort,
};
