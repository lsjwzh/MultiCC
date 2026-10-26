'use strict';

// Node 侧转发层（src/remote-screen.js）的测试工具。
//
// 1. installFakeRemote()：把 MULTICC_REMOTE_BIN 指向 tests/helpers/remote-screen-fake-bin.js
//    的 shell 包装（免去仓库文件的可执行位），每次测试独立的事件文件。
// 2. fakeClientWs / fakeUpstreamWs：不碰真 socket 的 WS 替身，用来钉背压、关闭码和排队。
// 3. readEvents / waitFor：读假进程的事件流、等条件成立。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { JPEG, CAPABILITIES } = require('./remote-screen-fake-bin');

const FAKE_BIN = path.join(__dirname, 'remote-screen-fake-bin.js');
const FLAGS = [
  'FAKE_REMOTE_EVENTS_FILE', 'FAKE_REMOTE_PID_FILE', 'FAKE_REMOTE_NO_READY',
  'FAKE_REMOTE_READY_DELAY_MS', 'FAKE_REMOTE_EXIT_AFTER_MS', 'FAKE_REMOTE_WS_DELAY_MS',
  'FAKE_REMOTE_PIPE_SOCK', 'FAKE_REMOTE_FAIL_START',
];

function readEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return { type: 'unparsable', line }; }
    });
  } catch { return []; }
}

async function waitFor(fn, timeoutMs = 5000, what = 'condition') {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function installFakeRemote(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-remote-fake-'));
  const bin = path.join(dir, 'multicc-remote');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_BIN}" "$@"\n`, { mode: 0o755 });
  for (const key of FLAGS) delete process.env[key];
  process.env.MULTICC_REMOTE_BIN = bin;
  process.env.FAKE_REMOTE_EVENTS_FILE = path.join(dir, 'events.jsonl');
  process.env.FAKE_REMOTE_PID_FILE = path.join(dir, 'remote.pid');
  for (const [key, value] of Object.entries(env)) if (value != null) process.env[key] = String(value);
  return {
    dir,
    bin,
    eventsFile: process.env.FAKE_REMOTE_EVENTS_FILE,
    pidFile: process.env.FAKE_REMOTE_PID_FILE,
    events: () => readEvents(process.env.FAKE_REMOTE_EVENTS_FILE),
    cleanup() {
      for (const key of FLAGS) delete process.env[key];
      delete process.env.MULTICC_REMOTE_BIN;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// 客户端 WS 替身：send 记录原样消息与 binary 标志，close 记录关闭码。
function fakeClientWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.closed = null;
  ws.send = (data, options) => {
    ws.sent.push({ data, binary: options?.binary === true });
  };
  ws.close = (code, reason) => {
    ws.closed = { code, reason };
    ws.readyState = 3;
    ws.emit('close', code, reason);
  };
  return ws;
}

// 上游 WS 替身：readyState 1 = 已连上；emit('open'/'message'/'close') 由测试驱动。
function fakeUpstreamWs() {
  const up = new EventEmitter();
  up.readyState = 1;
  up.sent = [];
  up.closed = null;
  up.pauses = 0;
  up.resumes = 0;
  up.send = (data, options) => { up.sent.push({ data, binary: options?.binary === true }); };
  up.pause = () => { up.pauses += 1; };
  up.resume = () => { up.resumes += 1; };
  up.close = (code, reason) => { up.closed = { code, reason }; up.readyState = 3; };
  up.terminate = () => { up.readyState = 3; };
  return up;
}

module.exports = {
  installFakeRemote, readEvents, waitFor, fakeClientWs, fakeUpstreamWs,
  JPEG, CAPABILITIES, FAKE_BIN,
};
