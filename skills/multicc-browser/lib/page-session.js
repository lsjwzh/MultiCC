'use strict';

// One CDP session bound to a single tab.
//
// The daemon keeps a browser-level WebSocket; everything a page command needs
// (attach, enable the domains a command touches, translate a session-scoped
// protocol error into a re-attach) lives here so the daemon file stays about
// process/lifecycle policy.

const { isSessionGone } = require('./cdp');
const P = require('./paths');

const { MbError } = P;

const ATTACH_TIMEOUT_MS = 15000;
const AX_TIMEOUT_MS = 20000;

// The domains every page command may rely on. Accessibility is enabled lazily
// because a snapshot is the only thing that needs it.
const BASE_DOMAINS = ['Page', 'Runtime', 'DOM'];

function shortId(targetId) {
  return String(targetId || '').slice(0, 8);
}

class PageSession {
  constructor(daemon, targetId) {
    this.daemon = daemon;
    this.targetId = targetId;
    this.sessionId = null;
    this.queue = Promise.resolve();
    this.enabled = new Set();
    this.dialog = null;
    this.registry = null;
    this.loaderId = null;
    this.unsubs = [];
  }

  get client() {
    return this.daemon.cdp;
  }

  detach() {
    for (const off of this.unsubs) {
      try { off(); } catch (_) { /* ignore */ }
    }
    this.unsubs = [];
    this.sessionId = null;
    this.enabled = new Set();
    this.dialog = null;
  }

  async ensureAttached() {
    if (this.sessionId) return this.sessionId;
    const result = await this.client.send('Target.attachToTarget',
      { targetId: this.targetId, flatten: true }, undefined, { timeout: ATTACH_TIMEOUT_MS });
    this.sessionId = result.sessionId;
    if (!this.sessionId) throw new MbError('attach_failed', `could not attach to tab ${shortId(this.targetId)}`);
    await this.onAttached();
    return this.sessionId;
  }

  // Both helpers compare against the *current* sessionId at dispatch time rather
  // than capturing it: a listener is often registered before the first command
  // attaches the session, and a re-attach (renderer swap) must not silently
  // orphan Page.javascriptDialogOpening / Network listeners.
  subscribe(method, handler) {
    const off = this.client.on(method, (params, eventSession) => {
      if (!this.sessionId || eventSession !== this.sessionId) return;
      handler(params);
    });
    this.unsubs.push(off);
  }

  async onAttached() {
    this.subscribe('Page.javascriptDialogOpening', params => {
      this.dialog = {
        type: params.type,
        message: params.message,
        url: params.url,
        defaultPrompt: params.defaultPrompt,
      };
      // A beforeunload prompt blocks navigation the model already asked for.
      if (params.type === 'beforeunload') {
        this.client.send('Page.handleJavaScriptDialog', { accept: true }, this.sessionId).catch(() => {});
      }
    });
    this.subscribe('Page.javascriptDialogClosed', () => { this.dialog = null; });
    this.subscribe('Page.frameNavigated', params => {
      if (params.frame && !params.frame.parentId) {
        this.loaderId = params.frame.loaderId || this.loaderId;
        // Refs are backend-node ids; a navigation invalidates them wholesale.
        if (this.registry) this.registry.stale = true;
      }
    });
    await this.ensure(...BASE_DOMAINS);
    await this.client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, this.sessionId)
      .catch(() => {});
    await this.client.send('Page.setLifecycleEventsEnabled', { enabled: true }, this.sessionId)
      .catch(() => {});
    const tree = await this.client.send('Page.getFrameTree', {}, this.sessionId).catch(() => null);
    if (tree && tree.frameTree && tree.frameTree.frame) {
      this.loaderId = tree.frameTree.frame.loaderId || this.loaderId;
    }
  }

  async send(method, params = {}, options = {}) {
    const sessionId = await this.ensureAttached();
    try {
      return await this.client.send(method, params, sessionId, options);
    } catch (error) {
      if (!isSessionGone(error.message)) throw error;
      // Chrome dropped the session (tab swap, process swap). Re-attach once and
      // retry: the caller should not have to know a renderer was recycled.
      this.detach();
      const fresh = await this.ensureAttached();
      return this.client.send(method, params, fresh, options);
    }
  }

  async ensure(...domains) {
    for (const domain of domains) {
      if (this.enabled.has(domain)) continue;
      await this.send(`${domain}.enable`, {}, { timeout: 15000 });
      this.enabled.add(domain);
    }
  }

  on(method, handler) {
    return this.client.on(method, (params, eventSession) => {
      if (!this.sessionId || eventSession !== this.sessionId) return;
      handler(params);
    });
  }

  async pageInfo() {
    const target = this.daemon.targets.get(this.targetId);
    const evaluated = await this.send('Runtime.evaluate',
      { expression: '({title: document.title, href: location.href})', returnByValue: true },
      { timeout: 8000 }).catch(() => null);
    const value = evaluated && evaluated.result ? evaluated.result.value : null;
    const info = {
      title: (value && value.title) || (target && target.title) || '',
      url: (value && value.href) || (target && target.url) || '',
    };
    if (target) {
      if (info.title) target.title = info.title;
      if (info.url) target.url = info.url;
    }
    return info;
  }

  async collectFrames() {
    await this.ensure('Accessibility');
    const mainResult = await this.send('Accessibility.getFullAXTree', {}, { timeout: AX_TIMEOUT_MS });
    const main = mainResult.nodes || [];
    const presentFrames = new Set(main.map(node => node.frameId).filter(Boolean));
    const tree = await this.send('Page.getFrameTree', {}, { timeout: 10000 }).catch(() => null);
    const childFrames = [];
    const walk = frame => {
      for (const child of frame.childFrames || []) {
        childFrames.push(child);
        walk(child);
      }
    };
    if (tree && tree.frameTree) walk(tree.frameTree);
    const children = [];
    for (const child of childFrames) {
      const frame = child.frame || {};
      // Same-process frames are already merged into the main tree; expanding
      // them again would duplicate every node.
      if (presentFrames.has(frame.id)) continue;
      try {
        const result = await this.send('Accessibility.getFullAXTree', { frameId: frame.id },
          { timeout: AX_TIMEOUT_MS });
        const nodes = result.nodes || [];
        if (nodes.length) children.push({ name: frame.name || '', url: frame.url || '', nodes });
        else children.push({ name: frame.name || '', crossOrigin: true });
      } catch (_) {
        children.push({ name: frame.name || '', crossOrigin: true });
      }
    }
    return { main, children };
  }

  async axNodes(frameId) {
    const params = frameId ? { frameId } : {};
    const result = await this.send('Accessibility.getFullAXTree', params, { timeout: AX_TIMEOUT_MS });
    return result.nodes || [];
  }
}

module.exports = { PageSession, shortId, ATTACH_TIMEOUT_MS, AX_TIMEOUT_MS, BASE_DOMAINS };
