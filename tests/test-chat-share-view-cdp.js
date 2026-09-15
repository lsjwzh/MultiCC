'use strict';

// 分享出去的页面必须就是聊天页本身，只是按权限收掉一些东西。
//
// 这是一个端到端断言，不是一个面向前端模块的断言：真实 express 实例上挂着
//   · 真实的 src/routes/static-assets.js（公开目录 + 带 ?v=<mtime> 的 HTML 写入器）
//   · 真实的 src/routes/share.js（页面路由、entry、history、auth）
//   · 真实的 public/chat.html 及其全部脚本
// 只有分享存储和 WebSocket 服务是假的。真 Chrome 打开 /share/<token>，看它渲染出
// 来的到底是不是管理员那一套界面。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { createStaticAssetsRoutes } = require('../src/routes/static-assets');
const { mountShareRoutes } = require('../src/routes/share');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const SESSION = 's1';
const MESSAGES = [
  { role: 'user', content: '快照里第一条', ts: 1 },
  { role: 'assistant', content: '快照里第二条', ts: 2 },
];

// 预设的记录直接用 token 当键：测试要的是一个确定的链接，不是走一遍创建流程。
function createFakeShare() {
  const records = new Map([
    ['view-live', { token: 'view-live', sessionId: SESSION, access: 'view', label: '只读分享' }],
    ['operate-live', { token: 'operate-live', sessionId: SESSION, access: 'operate', password: 'pw', label: '协作分享' }],
    ['locked-live', { token: 'locked-live', sessionId: SESSION, access: 'view', password: 'pw', label: '加密分享' }],
    ['snapshot-live', { token: 'snapshot-live', sessionId: SESSION, access: 'view', type: 'messages', messages: MESSAGES, label: '消息快照' }],
  ]);
  return {
    records,
    create: () => { throw new Error('not used'); },
    createMessageShare: () => { throw new Error('not used'); },
    get: (token) => records.get(token) || null,
    listForSession: () => [],
    remove: () => false,
    verifyPassword: (token, password) => {
      const record = records.get(token);
      return !!record && !!record.password && record.password === password;
    },
    authCookieValue: (record) => `proof-${record.token}`,
    cookieName: (token) => `multicc_share_${token}`,
    access: (token, { cookies }) => {
      const record = records.get(token);
      if (!record) return null;
      if (!record.password || cookies[`multicc_share_${token}`] === `proof-${token}`) {
        return { access: record.access, sessionId: record.sessionId };
      }
      return null;
    },
  };
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}

// 服务器上的接线跟 server.js 一致，包括次序：分享路由先挂，静态资源写入器先创建、
// 后挂载。请求记录让我们能从服务端确认页面到底问了哪些接口。
async function startShareServer() {
  const requests = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { requests.push(`${req.method} ${req.path}`); next(); });

  const staticAssetsRuntime = createStaticAssetsRoutes({
    express, fs, path, publicDir: PUBLIC_DIR,
  });
  const share = createFakeShare();
  const persistedSessions = new Map([[SESSION, { id: SESSION, label: '主会话', cli: 'claude', type: 'chat' }]]);
  mountShareRoutes(app, {
    share,
    persistedSessions,
    loadChatHistory: () => MESSAGES.map((message, index) => ({ id: `m${index}`, ...message })),
    paginateChatHistory: () => ({ messages: [], hasMore: false }),
    parseCookies,
    chatPageFile: path.join(PUBLIC_DIR, 'chat.html'),
    serveHtml: staticAssetsRuntime.serveHtml,
  });
  staticAssetsRuntime.mountRoutes(app);

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    setCookie(token) {
      share.records.get(token).__issued = true;
      return `multicc_share_${token}=proof-${token}`;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

// 页面侧记录每一次 WebSocket 尝试。分享连接的凭证是 token 而不是 ws-ticket，
// 这里是最接近真相的观测点：URL 里到底带了什么。
const RECORD_SOCKETS = `(() => {
  const Native = window.WebSocket;
  window.__wsUrls = [];
  window.WebSocket = class extends Native {
    constructor(url, protocols) { window.__wsUrls.push(String(url)); super(url, protocols); }
  };
})()`;

async function openShare(page, server, token) {
  await page.navigate(`${server.origin}/share/${token}`);
  return page.waitFor('window.MultiCCShareMode && window.MultiCCShareMode.isReady && window.MultiCCShareMode.isReady()');
}

// 触发页面自己那条真实的重连路径（chat-transport 的 online/focus 监听），
// 而不是等 5 秒心跳：连接该不该发生，由分享自己决定，这里只是让它发生。
async function wakeTransport(page) {
  await page.evaluate(`dispatchEvent(new Event('online')); dispatchEvent(new Event('focus'))`);
  await page.waitFor('window.__wsUrls.length > 0', { timeoutMs: 5_000 });
}

async function settle(ms = 500) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function visibility(page, selector) {
  return page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    return {
      total: nodes.length,
      visible: nodes.filter(node => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
      }).length,
    };
  })()`);
}

test('a shared link opens the real chat page, narrowed by the share authority', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const server = await startShareServer();
  try {
    await withCdpHarness({ screenshotDir: path.join(require('node:os').tmpdir(), 'multicc-share-qa') }, async page => {
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_SOCKETS });
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

      // ── 只读会话分享 ────────────────────────────────────────────────────────
      assert.ok(await openShare(page, server, 'view-live'));
      const chrome = await page.evaluate(`({
        path: location.pathname,
        title: document.title,
        shareMode: window.MultiCCShareMode.active(),
        canOperate: window.MultiCCShareMode.canOperate(),
        html: document.documentElement.className,
        renderer: ['input-bar', 'pre-input-bar', 'pending-user-input-card', 'messages', 'header', 'dbg-btn']
          .every(id => !!document.getElementById(id)),
        sessionOnly: document.querySelectorAll('.session-only').length,
        overlay: !!document.getElementById('share-gate'),
      })`);
      // 页面就是 /share/<token> 自己，没有被换成另一份界面。
      assert.equal(chrome.path, '/share/view-live');
      assert.equal(chrome.shareMode, true);
      assert.equal(chrome.canOperate, false);
      assert.equal(chrome.renderer, true, 'the real chat renderer must be present');
      assert.ok(chrome.sessionOnly > 1, 'the page must actually carry administrator controls to hide');
      assert.equal(chrome.overlay, false, 'a share that works shows no gate');
      assert.equal(chrome.title, '只读分享 — MultiCC');
      assert.match(chrome.html, /share-mode/);
      assert.match(chrome.html, /share-view-only/);

      // 只读：输入区消失，管理员按钮一件不剩。
      const composer = await visibility(page, '#input-bar, #pre-input-bar, #pending-user-input-card');
      assert.ok(composer.total > 0, 'the composer must exist in the document — it is hidden, not deleted');
      assert.equal(composer.visible, 0);
      const admin = await visibility(page, '.session-only');
      assert.ok(admin.total > 1);
      assert.equal(admin.visible, 0, 'no administrator control may remain visible on a share');

      // 连接带的是分享 token，不是它拿不到的 ws-ticket。
      await wakeTransport(page);
      const sockets = await page.evaluate('window.__wsUrls');
      const shareSocket = sockets.find(url => url.includes('share=view-live'));
      assert.ok(shareSocket, `a share connection must carry the token: ${JSON.stringify(sockets)}`);
      assert.equal(new URL(shareSocket).searchParams.get('session'), SESSION);
      assert.equal(new URL(shareSocket).searchParams.get('ticket'), null);
      assert.equal(server.requests.filter(r => r.startsWith('POST /api/auth/ws-ticket')).length, 0,
        'a recipient never calls the administrator ticket endpoint');
      assert.equal(server.requests.filter(r => r === 'GET /api/share/view-live/entry').length, 1,
        'the page asks its authority exactly once');

      // ── 可协作的会话分享 ────────────────────────────────────────────────────
      // operate 链接带密码，接收方通过 /auth 拿到 cookie 之后才连得上。
      await page.send('Network.enable');
      await page.send('Network.setCookie', {
        name: 'multicc_share_operate-live', value: 'proof-operate-live',
        domain: '127.0.0.1', path: '/', url: `${server.origin}/share/operate-live`,
      });
      await page.evaluate('window.__wsUrls.length = 0');
      assert.ok(await openShare(page, server, 'operate-live'));
      const writable = await page.evaluate(`({
        canOperate: window.MultiCCShareMode.canOperate(),
        html: document.documentElement.className,
      })`);
      assert.equal(writable.canOperate, true);
      assert.doesNotMatch(writable.html, /share-view-only/);
      // 同一个页面，只有权限在变：输入区回来了，管理员按钮仍然不在。
      assert.equal((await visibility(page, '#input-bar')).visible, 1);
      assert.equal((await visibility(page, '.session-only')).visible, 0);

      // ── 消息快照 ────────────────────────────────────────────────────────────
      await page.evaluate('window.__wsUrls.length = 0');
      assert.ok(await openShare(page, server, 'snapshot-live'));
      const snapshot = await page.evaluate(`({
        text: document.getElementById('messages').textContent,
        composerVisible: getComputedStyle(document.getElementById('input-bar')).display !== 'none',
        title: document.title,
      })`);
      assert.match(snapshot.text, /快照里第一条/);
      assert.match(snapshot.text, /快照里第二条/);
      assert.equal(snapshot.composerVisible, false, 'a snapshot is read-only');
      // 快照没有活会话：页面连一条连接都不该为它开。
      await page.evaluate(`dispatchEvent(new Event('online')); dispatchEvent(new Event('focus'))`);
      await settle();
      assert.deepEqual(await page.evaluate('window.__wsUrls'), []);

      // ── 加密分享 ────────────────────────────────────────────────────────────
      await page.navigate(`${server.origin}/share/locked-live`);
      assert.ok(await page.waitFor(`!!document.getElementById('share-pw')`));
      const gate = await page.evaluate(`({
        text: document.getElementById('share-gate').textContent,
        focused: document.activeElement && document.activeElement.id,
        html: document.documentElement.className,
        renderer: !!document.getElementById('messages'),
      })`);
      assert.match(gate.text, /需要访问密码/);
      assert.equal(gate.focused, 'share-pw');
      // 门后仍是同一个渲染器，只是还没拿到权限。
      assert.equal(gate.renderer, true);
      assert.match(gate.html, /share-view-only/);
      // 密码还没给，页面就不该为这条链接建立任何连接。
      await page.evaluate(`dispatchEvent(new Event('online')); dispatchEvent(new Event('focus'))`);
      await settle();
      assert.equal((await page.evaluate('window.__wsUrls')).length, 0, 'no connection before the password is accepted');

      // ── 失效链接 ────────────────────────────────────────────────────────────
      await page.navigate(`${server.origin}/share/does-not-exist`);
      assert.ok(await page.waitFor(`!!document.getElementById('share-gate')`));
      assert.match(await page.evaluate(`document.getElementById('share-gate').textContent`), /链接无效/);
    });
  } finally {
    await server.close();
  }
});
