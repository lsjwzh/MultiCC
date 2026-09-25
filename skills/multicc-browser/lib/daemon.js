'use strict';

// One resident daemon per profile.
//
// It holds a single persistent browser-level CDP WebSocket, keeps Chrome alive
// (and re-launches it if it dies while headless), owns the target→owner map so
// two MultiCC sessions never fight over the same tab, and answers newline
// delimited JSON over a 0600 unix socket. Because Chrome is spawned detached,
// restarting the daemon (or upgrading the skill) re-attaches to the same
// browser instead of throwing away the user's logged-in tabs.

const fs = require('fs');
const net = require('net');
const path = require('path');

const P = require('./paths');
const { CDP, fetchVersion } = require('./cdp');
const CH = require('./chrome');
const { renderSnapshot, roleOf, nameOf } = require('./snapshot');
const { COMMANDS } = require('./actions');
const { PageSession, shortId, ATTACH_TIMEOUT_MS } = require('./page-session');
const { VERSION } = require('./version');

const { MbError } = P;

const HEALTH_INTERVAL_MS = 15000;
const BACKOFF_MS = [1000, 2000, 5000, 10000];
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_STARTUP_TIMEOUT_S = 60;

// Note: deliberately NOT unref'd. A detached daemon mid-shutdown (socket closed,
// Chrome stop pending) can briefly hold no other handle; an unref'd timer would
// let Node exit before the stop lands, orphaning Chrome.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------- daemon

class Daemon {
  constructor(name, options = {}) {
    this.name = P.requireName(name);
    this.options = options;
    this.config = P.readJson(P.configPath(this.name), null) || {};
    this.state = P.readJson(P.statePath(this.name), null) || {};
    this.cdp = null;
    this.proc = null;
    this.chromePid = null;
    this.port = null;
    this.userDataDir = this.config.userDataDir || P.profileDir(this.name);
    this.browserPath = null;
    this.owned = false;
    this.headed = Boolean(this.options.headed !== undefined ? this.options.headed : this.config.headed);
    this.attachOnly = Boolean(this.config.attachOnly);
    this.cdpUrl = this.config.cdpUrl || null;
    this.targets = new Map();
    this.pages = new Map();
    this.owners = new Map();
    this.ownerNotices = new Map();
    this.startedAt = Date.now();
    this.restarts = 0;
    this.failures = [];
    this.phase = 'starting';
    this.reason = null;
    this.shuttingDown = false;
    this.healthTimer = null;
    this.server = null;
    this.socketPath = null;
    this.lockFile = null;
    this.browserWsUrl = null;
    this.relaunchPromise = null;
  }

  log(...parts) {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
    try { fs.appendFileSync(this.logFile(), `${line}\n`); } catch (_) { /* logging must never break the daemon */ }
    if (this.options.verbose) process.stderr.write(`${line}\n`);
  }

  logFile() {
    return P.logPath(this.name);
  }

  // ------------------------------------------------------------------ lifecycle

  async boot() {
    P.ensureStateDirs();
    this.acquireLock();
    this.log(`daemon start pid=${process.pid} version=${VERSION} headed=${this.headed} attachOnly=${this.attachOnly}`);
    await this.ensureChrome();
    await this.startIpc();
    await this.restoreOwners();
    this.phase = 'ready';
    this.persist();
    this.healthTimer = setInterval(() => { this.healthTick().catch(() => {}); }, HEALTH_INTERVAL_MS);
    const onSignal = () => { this.shutdown({ keepChrome: false }).catch(() => {}); };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    // Never leave a stale socket + lock behind if something throws out of band.
    process.on('uncaughtException', error => {
      this.log(`uncaught exception: ${error && error.stack ? error.stack : error}`);
      this.shutdown({ keepChrome: true }).catch(() => process.exit(1));
    });
    process.on('unhandledRejection', error => {
      this.log(`unhandled rejection: ${error && error.message ? error.message : error}`);
    });
    this.log('daemon ready');
  }

  acquireLock() {
    const file = P.lockPath(this.name);
    const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: VERSION });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, payload);
        fs.closeSync(fd);
        this.lockFile = file;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = P.readJson(file, null);
        const pid = existing && Number(existing.pid);
        if (pid && CH.processAlive(pid)) {
          throw new MbError('daemon_running', `another daemon (pid ${pid}) already serves profile ${this.name}`);
        }
        P.removeFile(file);
      }
    }
    throw new MbError('lock_failed', `could not take ${file}`);
  }

  async ensureChrome() {
    if (this.attachOnly) return this.attachExternal();
    const active = CH.readsDevToolsActivePort(this.userDataDir);
    const savedPid = Number(this.state.chromePid) || null;
    if (active && savedPid && CH.processAlive(savedPid) && CH.isOurChrome(savedPid, this.userDataDir)) {
      try {
        await this.connectBrowser(`ws://127.0.0.1:${active.port}${active.wsPath}`);
        this.chromePid = savedPid;
        this.port = active.port;
        this.owned = Boolean(this.state.owned) && CH.isOurChrome(savedPid, this.userDataDir);
        this.browserPath = this.state.browser || null;
        this.phase = 'ready';
        this.log(`re-attached to chrome pid=${savedPid} port=${active.port}`);
        return;
      } catch (error) {
        this.log(`re-attach failed: ${error.message}`);
      }
    }
    await this.launchChrome();
  }

  async attachExternal() {
    if (!this.cdpUrl) throw new MbError('attach', `profile ${this.name} is attach-only but has no cdpUrl`);
    const url = new URL(this.cdpUrl);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const data = await fetchVersion(port, { host: url.hostname, timeout: 5000 });
    await this.connectBrowser(data.webSocketDebuggerUrl);
    this.port = port;
    this.owned = false;
    this.phase = 'ready';
    this.log(`attached to external chrome at ${this.cdpUrl} (${data.Browser || 'unknown'})`);
  }

  async launchChrome() {
    const holder = CH.singletonLockHolder(this.userDataDir);
    if (holder) {
      const active = CH.readsDevToolsActivePort(this.userDataDir);
      if (active) {
        try {
          await this.connectBrowser(`ws://127.0.0.1:${active.port}${active.wsPath}`);
          this.chromePid = holder;
          this.port = active.port;
          this.owned = false;
          this.phase = 'ready';
          this.log(`profile held by pid ${holder}; attached without owning it`);
          return;
        } catch (_) { /* fall through to the error below */ }
      }
      throw new MbError('profile_in_use',
        `profile in use by pid ${holder}; quit that Chrome or use another profile`);
    }
    const choice = CH.chooseBrowser({
      explicit: this.options.browser,
      configured: this.config.browser,
      env: process.env.MBROWSER_CHROME,
    });
    const keychain = CH.resolveMockKeychain(this.userDataDir,
      Boolean(this.options.mockKeychain !== undefined ? this.options.mockKeychain : this.config.mockKeychain));
    if (keychain.note) this.log(keychain.note);
    if (keychain.mockKeychain) {
      const pinned = CH.pinMockKeychain(this.userDataDir);
      if (pinned) this.log(`pinned --use-mock-keychain for ${this.userDataDir}`);
    }
    this.browserPath = choice.path;
    const logFd = fs.openSync(this.logFile(), 'a');
    let spawned;
    try {
      spawned = CH.spawnChrome({
        exe: choice.path,
        userDataDir: this.userDataDir,
        headless: !this.headed,
        mockKeychain: keychain.mockKeychain,
        logFd,
      });
    } finally {
      try { fs.closeSync(logFd); } catch (_) { /* ignore */ }
    }
    this.proc = spawned.proc;
    this.chromePid = spawned.proc.pid;
    this.owned = true;
    this.log(`launched ${choice.path} (${choice.source}) pid=${spawned.proc.pid} headless=${!this.headed}`);
    // Persist before waiting for readiness: a daemon that starts during the
    // startup window must not mistake our fresh Chrome for a stranger's and
    // attach to it as an unowned browser it will then never stop.
    this.persist();
    spawned.proc.on('exit', code => {
      this.log(`chrome pid=${this.chromePid} exited (code ${code})`);
      if (!this.shuttingDown) this.onChromeLost(`chrome exited (code ${code})`);
    });
    const timeoutMs = (Number(this.options.startupTimeout) || Number(this.config.startupTimeout)
      || DEFAULT_STARTUP_TIMEOUT_S) * 1000;
    const ready = await CH.waitForReady({ userDataDir: this.userDataDir, timeoutMs, proc: spawned.proc });
    this.port = ready.port;
    await this.connectBrowser(ready.webSocketDebuggerUrl);
    this.phase = 'ready';
  }

  async connectBrowser(wsUrl) {
    if (this.cdp) {
      // Detach the loss hook first: this teardown is deliberate (a reconnect),
      // and letting it fire would start a keep-alive relaunch that races — and
      // can duplicate — the browser we are about to attach to.
      const previous = this.cdp;
      this.cdp = null;
      previous.onClose = null;
      try { previous.close(); } catch (_) { /* ignore */ }
    }
    for (const session of this.pages.values()) session.detach();
    this.pages.clear();
    const client = await CDP.connect(wsUrl, { timeout: ATTACH_TIMEOUT_MS, label: this.name });
    client.onClose = reason => {
      if (!this.shuttingDown) this.onChromeLost(reason.message);
    };
    this.cdp = client;
    this.browserWsUrl = wsUrl;
    this.targets.clear();
    await client.send('Target.setDiscoverTargets', { discover: true }, undefined, { timeout: 10000 });
    client.on('Target.targetCreated', params => this.onTargetCreated(params.targetInfo));
    client.on('Target.targetInfoChanged', params => this.onTargetInfoChanged(params.targetInfo));
    client.on('Target.targetDestroyed', params => this.onTargetDestroyed(params.targetId));
    client.on('Target.detachedFromTarget', params => {
      const session = this.pages.get(params.targetId);
      if (session) session.detach();
    });
    const existing = await client.send('Target.getTargets', {}, undefined, { timeout: 10000 });
    for (const info of existing.targetInfos || []) this.trackTarget(info);
  }

  onTargetCreated(info) {
    if (!info) return;
    this.trackTarget(info);
    if (info.type !== 'page' || !info.openerId) return;
    const owner = this.ownerByTarget(info.openerId);
    if (!owner) return;
    this.claim(owner, info.targetId);
    this.notify(owner, `new tab opened (${info.url}) ${shortId(info.targetId)} — now current`);
    this.persist();
  }

  onTargetInfoChanged(info) {
    if (!info) return;
    const known = this.targets.get(info.targetId);
    if (known) Object.assign(known, info);
    else this.trackTarget(info);
  }

  onTargetDestroyed(targetId) {
    this.targets.delete(targetId);
    const session = this.pages.get(targetId);
    if (session) {
      session.detach();
      this.pages.delete(targetId);
    }
    for (const [owner, record] of this.owners) {
      if (!record.tabs.includes(targetId)) continue;
      record.tabs = record.tabs.filter(id => id !== targetId);
      if (record.current === targetId) record.current = record.tabs[record.tabs.length - 1] || null;
      this.notify(owner, `tab ${shortId(targetId)} closed`);
    }
    this.persist();
  }

  trackTarget(info) {
    if (!info || !info.targetId) return;
    const existing = this.targets.get(info.targetId);
    if (existing) Object.assign(existing, info);
    else this.targets.set(info.targetId, { ...info });
  }

  ownerByTarget(targetId) {
    for (const [owner, record] of this.owners) {
      if (record.tabs.includes(targetId)) return owner;
    }
    return null;
  }

  ownerRecord(owner) {
    if (!this.owners.has(owner)) this.owners.set(owner, { tabs: [], current: null });
    return this.owners.get(owner);
  }

  claim(owner, targetId) {
    const record = this.ownerRecord(owner);
    if (!record.tabs.includes(targetId)) record.tabs.push(targetId);
    record.current = targetId;
    const other = this.ownerByTarget(targetId);
    if (other && other !== owner) {
      const otherRecord = this.ownerRecord(other);
      otherRecord.tabs = otherRecord.tabs.filter(id => id !== targetId);
      if (otherRecord.current === targetId) otherRecord.current = otherRecord.tabs[0] || null;
    }
    return record;
  }

  notify(owner, message) {
    if (!this.ownerNotices.has(owner)) this.ownerNotices.set(owner, []);
    this.ownerNotices.get(owner).push(message);
  }

  takeNotices(owner) {
    const list = this.ownerNotices.get(owner) || [];
    this.ownerNotices.set(owner, []);
    return list;
  }

  async restoreOwners() {
    const saved = this.state.owners || {};
    for (const [owner, record] of Object.entries(saved)) {
      const tabs = (record.tabs || []).filter(id => this.targets.has(id));
      const current = tabs.includes(record.current) ? record.current : (tabs[tabs.length - 1] || null);
      this.owners.set(owner, { tabs, current });
    }
  }

  // ----------------------------------------------------------------- keep-alive

  async healthTick() {
    if (this.shuttingDown) return;
    if (!this.cdp || this.cdp.closed) {
      await this.onChromeLost('cdp connection is closed');
      return;
    }
    try {
      await this.cdp.send('Browser.getVersion', {}, undefined, { timeout: 5000 });
    } catch (error) {
      await this.onChromeLost(error.message);
    }
  }

  async onChromeLost(reason) {
    if (this.shuttingDown || this.phase === 'chrome-down' || this.phase === 'relaunching') return;
    this.log(`chrome lost: ${reason}`);
    this.phase = 'chrome-down';
    this.reason = reason;
    if (this.cdp) {
      try { this.cdp.close(); } catch (_) { /* ignore */ }
      this.cdp = null;
    }
    for (const session of this.pages.values()) session.detach();
    this.pages.clear();
    this.targets.clear();
    if (this.attachOnly) {
      this.log('attach-only profile: not relaunching');
      return;
    }
    if (!this.headed) await this.relaunch('headless keep-alive');
  }

  async relaunch(why) {
    if (this.shuttingDown) return false;
    // An attach-only profile never owns its browser: relaunching would silently
    // spawn a private Chrome under the same profile directory.
    if (this.attachOnly) {
      this.phase = 'chrome-down';
      this.reason = this.reason || 'the attached browser is gone';
      return false;
    }
    if (this.relaunchPromise) return this.relaunchPromise;
    this.relaunchPromise = this.relaunchInner(why).finally(() => { this.relaunchPromise = null; });
    return this.relaunchPromise;
  }

  async relaunchInner(why) {
    const now = Date.now();
    this.failures = this.failures.filter(stamp => now - stamp < FAILURE_WINDOW_MS);
    if (this.failures.length >= MAX_FAILURES) {
      this.phase = 'chrome-down';
      this.reason = `${MAX_FAILURES} failed relaunches within 10 minutes; giving up until the next command`;
      this.log(this.reason);
      return false;
    }
    this.phase = 'relaunching';
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt += 1) {
      await sleep(BACKOFF_MS[attempt]);
      if (this.shuttingDown) return false;
      try {
        await this.launchChrome();
        this.restarts += 1;
        this.phase = 'ready';
        this.reason = null;
        this.persist();
        this.log(`relaunched chrome (${why}) pid=${this.chromePid} restarts=${this.restarts}`);
        return true;
      } catch (error) {
        this.failures.push(Date.now());
        this.log(`relaunch attempt ${attempt + 1} failed: ${error.message}`);
      }
    }
    this.phase = 'chrome-down';
    this.reason = `relaunch failed after ${BACKOFF_MS.length} backoff steps`;
    return false;
  }

  async ensureReady() {
    if (this.cdp && !this.cdp.closed && this.phase === 'ready') return;
    if (this.cdp && !this.cdp.closed && this.phase !== 'chrome-down') return;
    const launched = await this.relaunch('lazy (next command)');
    if (!launched) {
      throw new MbError('chrome_down',
        `profile ${this.name} has no browser: ${this.reason || 'chrome is not running'}`);
    }
    this.phase = 'ready';
    await this.restoreOwners();
  }

  // -------------------------------------------------------------------- targets

  sessionFor(targetId) {
    if (!this.pages.has(targetId)) this.pages.set(targetId, new PageSession(this, targetId));
    return this.pages.get(targetId);
  }

  currentTab(owner) {
    const record = this.owners.get(owner);
    if (!record) return null;
    record.tabs = record.tabs.filter(id => this.targets.has(id));
    if (record.current && !record.tabs.includes(record.current)) record.current = null;
    return record.current || record.tabs[record.tabs.length - 1] || null;
  }

  async createTab({ url = 'about:blank', background = true } = {}) {
    const result = await this.cdp.send('Target.createTarget',
      { url, background: Boolean(background) }, undefined, { timeout: 15000 });
    if (!result.targetId) throw new MbError('new_tab_failed', 'Target.createTarget returned no targetId');
    this.targets.set(result.targetId, {
      targetId: result.targetId, type: 'page', url, title: '', attached: false,
    });
    return result.targetId;
  }

  async ensureOwnTab(owner) {
    const record = this.ownerRecord(owner);
    record.tabs = record.tabs.filter(id => this.targets.has(id));
    if (record.current && !record.tabs.includes(record.current)) record.current = null;
    if (!record.current && record.tabs.length) record.current = record.tabs[record.tabs.length - 1];
    if (record.current) return record.current;
    const targetId = await this.createTab({ url: 'about:blank', background: true });
    this.claim(owner, targetId);
    this.persist();
    this.notify(owner, `opened a dedicated background tab ${shortId(targetId)}`);
    return targetId;
  }

  findTarget(selector) {
    const wanted = String(selector || '');
    if (!wanted) return null;
    for (const info of this.targets.values()) {
      if (info.type !== 'page') continue;
      if (info.targetId === wanted) return info;
      if (info.targetId.startsWith(wanted)) return info;
      if (shortId(info.targetId).toLowerCase() === wanted.toLowerCase()) return info;
    }
    return null;
  }

  async resolveTargetFor(owner, selector, { create = true } = {}) {
    await this.ensureReady();
    if (selector) {
      const info = this.findTarget(selector);
      if (!info) {
        throw new MbError('no_target', `no tab matches ${JSON.stringify(selector)}; run \`mbrowser tabs\` for the list`);
      }
      const ownerOfTarget = this.ownerByTarget(info.targetId);
      const foreign = Boolean(ownerOfTarget && ownerOfTarget !== owner);
      if (foreign) {
        this.log(`operating on tab ${shortId(info.targetId)} owned by ${ownerOfTarget} (explicit --tab)`);
      }
      return { targetId: info.targetId, foreign, owner: ownerOfTarget };
    }
    if (!create) {
      const current = this.currentTab(owner);
      if (!current) throw new MbError('no_target', 'this session has no tab to act on yet');
      return { targetId: current, foreign: false, owner };
    }
    return { targetId: await this.ensureOwnTab(owner), foreign: false, owner };
  }

  async listTabs(owner) {
    await this.ensureReady();
    const out = [];
    for (const info of this.targets.values()) {
      if (info.type !== 'page') continue;
      const targetOwner = this.ownerByTarget(info.targetId);
      const record = targetOwner ? this.owners.get(targetOwner) : null;
      const current = Boolean(record && record.current === info.targetId && targetOwner === owner);
      out.push({
        id: info.targetId,
        shortId: shortId(info.targetId),
        title: info.title || '',
        url: info.url || '',
        owner: targetOwner,
        current,
        mark: current ? '*' : (targetOwner === owner ? 'mine' : 'other'),
      });
    }
    out.sort((a, b) => Number(b.current) - Number(a.current));
    return out;
  }

  async tabView(targetId, owner) {
    const info = this.targets.get(targetId) || { targetId, url: '', title: '' };
    const session = this.sessionFor(targetId);
    const pageInfo = await session.pageInfo().catch(() => ({ title: info.title, url: info.url }));
    return { targetId, shortId: shortId(targetId), url: pageInfo.url || info.url, title: pageInfo.title || info.title, owner };
  }

  async switchTab(owner, selector) {
    const target = await this.resolveTargetFor(owner, selector);
    const record = this.ownerRecord(owner);
    if (!record.tabs.includes(target.targetId)) record.tabs.push(target.targetId);
    record.current = target.targetId;
    this.persist();
    const view = await this.tabView(target.targetId, owner);
    return { ...view, foreign: target.foreign };
  }

  async closeTab(owner, selector) {
    if (!selector && !this.currentTab(owner)) {
      throw new MbError('no_target', 'this session has no tab to close');
    }
    const target = await this.resolveTargetFor(owner, selector, { create: false });
    const targetOwner = this.ownerByTarget(target.targetId);
    if (targetOwner !== owner) {
      throw new MbError('foreign_tab',
        `tab ${shortId(target.targetId)} belongs to ${targetOwner || 'nobody'}; this session only closes its own tabs`);
    }
    const info = await this.tabView(target.targetId, owner);
    await this.cdp.send('Target.closeTarget', { targetId: target.targetId }, undefined, { timeout: 10000 });
    this.onTargetDestroyed(target.targetId);
    return { ...info, closed: true };
  }

  // ------------------------------------------------------------------ snapshots

  async snapshot(session, { interactive = false, maxChars } = {}) {
    const { main, children } = await session.collectFrames();
    const info = await session.pageInfo();
    const rendered = renderSnapshot(main, {
      page: info.title,
      url: info.url,
      tab: shortId(session.targetId),
      maxChars: Number(maxChars) || undefined,
      interactive,
      frames: children,
    });
    session.registry = {
      loaderId: session.loaderId,
      refs: rendered.refs,
      interactive: Boolean(interactive),
      createdAt: Date.now(),
    };
    return {
      text: rendered.text,
      refs: Object.keys(rendered.refs).length,
      lines: rendered.lines,
      truncated: rendered.truncated,
      url: info.url,
      title: info.title,
    };
  }

  async resolveRef(session, ref) {
    const registry = session.registry;
    if (!registry || !registry.refs) {
      throw new MbError('stale_ref', 'No snapshot yet — run `mbrowser snapshot` first');
    }
    const entry = registry.refs[ref];
    if (!entry) throw new MbError('stale_ref', `Unknown ref ${ref}. Take a new snapshot`);
    const navigated = registry.stale
      || (registry.loaderId && session.loaderId && registry.loaderId !== session.loaderId);
    if (!navigated) {
      try {
        await session.send('DOM.resolveNode', { backendNodeId: entry.backendDOMNodeId }, { timeout: 8000 });
        return entry;
      } catch (_) { /* node is gone; re-find it below */ }
    }
    let nodes = [];
    try {
      nodes = await session.axNodes(entry.frameId);
    } catch (_) {
      nodes = [];
    }
    const candidates = nodes.filter(node =>
      typeof node.backendDOMNodeId === 'number'
      && roleOf(node) === entry.role
      && nameOf(node) === entry.name);
    const match = candidates[entry.nth];
    if (match) {
      entry.backendDOMNodeId = match.backendDOMNodeId;
      registry.stale = false;
      registry.loaderId = session.loaderId;
      return entry;
    }
    throw new MbError('stale_ref', `Unknown or stale ref ${ref} — take a new snapshot`);
  }

  async handleDialog(session, accept, text) {
    if (!session.dialog) throw new MbError('no_dialog', 'no JavaScript dialog is open in this tab');
    const pending = session.dialog;
    await session.send('Page.handleJavaScriptDialog',
      { accept: Boolean(accept), ...(text ? { promptText: String(text) } : {}) }, { timeout: 10000 });
    session.dialog = null;
    return pending;
  }

  // ----------------------------------------------------------------------- IPC

  contextFor(session, owner) {
    return {
      targetId: session.targetId,
      owner,
      profile: this.name,
      send: (method, params, options) => session.send(method, params, options || {}),
      browser: (method, params, options) => this.cdp.send(method, params, undefined, options || {}),
      ensure: (...domains) => session.ensure(...domains),
      on: (method, handler) => session.on(method, handler),
      pageInfo: () => session.pageInfo(),
      resolveRef: ref => this.resolveRef(session, ref),
      snapshot: options => this.snapshot(session, options),
      newTab: async ({ url, background }) => {
        const targetId = await this.createTab({ url, background });
        this.claim(owner, targetId);
        this.persist();
        return this.tabView(targetId, owner);
      },
      listTabs: () => this.listTabs(owner),
      switchTab: selector => this.switchTab(owner, selector),
      closeTab: selector => this.closeTab(owner, selector),
      handleDialog: (accept, text) => this.handleDialog(session, accept, text),
    };
  }

  enqueue(session, task) {
    const run = session.queue.then(() => task(), () => task());
    session.queue = run.then(() => {}, () => {});
    return run;
  }

  async handleRequest(request) {
    const id = request && request.id;
    const cmd = request && request.cmd;
    const args = (request && request.args) || {};
    const owner = (request && request.owner) || 'cli';
    try {
      if (cmd === 'ping') return { id, ok: true, result: this.describe() };
      if (cmd === 'status') return { id, ok: true, result: this.status(owner) };
      if (cmd === 'shutdown') {
        const keepChrome = Boolean(args.keepChrome);
        setTimeout(() => { this.shutdown({ keepChrome }).catch(() => {}); }, 10);
        return { id, ok: true, result: { stopping: true, keepChrome } };
      }
      if (cmd === 'set-mode') return { id, ok: true, result: await this.setMode(args) };
      if (cmd === 'ensure-tabs') {
        await this.ensureReady();
        const targetId = await this.ensureOwnTab(owner);
        return { id, ok: true, result: this.tabView(targetId, owner) };
      }
      const action = COMMANDS[cmd];
      if (!action) throw new MbError('unknown_command', `unknown command "${cmd}"`);
      // `close [TARGET]` names its target positionally and must never create one.
      const selector = request.tab || args.tab || (cmd === 'close' ? args.target : null);
      const target = await this.resolveTargetFor(owner, selector, { create: cmd !== 'close' });
      const session = this.sessionFor(target.targetId);
      const result = await this.enqueue(session, async () => {
        const ctx = this.contextFor(session, owner);
        const value = await action(ctx, args);
        if (target.foreign) {
          value.foreign = true;
          value.text = `${value.text || ''}\n[note: tab ${shortId(target.targetId)} belongs to ${target.owner}; you asked for it explicitly]`.trim();
        }
        return value || {};
      });
      const notices = this.takeNotices(owner);
      if (notices.length) {
        result.notice = notices.join('; ');
        result.text = `${notices.join('\n')}\n${result.text || ''}`.trim();
      }
      if (session.dialog) {
        result.dialog = { ...session.dialog };
        result.text = `${result.text || ''}\n[dialog open: ${session.dialog.type} — ` +
          `${JSON.stringify(session.dialog.message)}; use \`mbrowser dialog accept|dismiss\`]`.trim();
      }
      this.persist();
      return { id, ok: true, result };
    } catch (error) {
      const code = error instanceof MbError ? error.code : (error.code || 'internal');
      return { id, ok: false, error: { code, message: error.message } };
    }
  }

  async setMode(args) {
    const headed = Boolean(args.headed);
    const mode = headed ? 'headed' : 'headless';
    if (this.attachOnly) {
      throw new MbError('attach',
        `profile ${this.name} is attach-only (${this.cdpUrl}); mbrowser never restarts a browser it did not launch`);
    }
    if (headed === this.headed) return { mode, changed: false, headed: this.headed };
    const heldByOthers = [...this.owners.entries()]
      .filter(([owner, record]) => owner !== (args.owner || 'cli') && record.tabs.some(id => this.targets.has(id)));
    if (heldByOthers.length && !args.force) {
      throw new MbError('owners_active',
        `other sessions hold tabs (${heldByOthers.map(([owner]) => owner).join(', ')}); ` +
        'pass --force to restart Chrome in the new mode');
    }
    await CH.stopChrome({
      pid: this.chromePid, userDataDir: this.userDataDir, port: this.port, wsUrl: this.browserWsUrl,
    });
    this.headed = headed;
    if (this.cdp) {
      // Detach the close hook first: this teardown is deliberate, and letting it
      // fire would kick off a keep-alive relaunch racing the one below.
      const client = this.cdp;
      this.cdp = null;
      this.browserWsUrl = null;
      client.onClose = null;
      try { client.close(); } catch (_) { /* ignore */ }
    }
    for (const session of this.pages.values()) session.detach();
    this.pages.clear();
    this.targets.clear();
    this.chromePid = null;
    this.owned = false;
    this.phase = 'starting';
    await this.launchChrome();
    this.restarts += 1;
    this.phase = 'ready';
    this.persist();
    return { mode, changed: true, headed: this.headed, pid: this.chromePid };
  }

  async startIpc() {
    const socketPath = P.socketPath(this.name);
    P.ensureDir(path.dirname(socketPath), 0o700);
    P.removeFile(socketPath);
    const server = net.createServer(socket => this.onConnection(socket));
    const previous = process.umask(0o077);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          try { fs.chmodSync(socketPath, 0o600); } catch (_) { /* best effort */ }
          resolve();
        });
      });
    } finally {
      process.umask(previous);
    }
    this.server = server;
    this.socketPath = socketPath;
  }

  onConnection(socket) {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch (_) {
          continue;
        }
        this.handleRequest(request).then(response => {
          try { socket.write(`${JSON.stringify(response)}\n`); } catch (_) { /* peer went away */ }
        }, () => {});
      }
    });
  }

  // ------------------------------------------------------------------ reporting

  describe() {
    return {
      pong: true,
      pid: process.pid,
      version: VERSION,
      profile: this.name,
      chromePid: this.chromePid,
      port: this.port,
      headed: this.headed,
      owned: this.owned,
      attachOnly: this.attachOnly,
      cdpUrl: this.cdpUrl,
      userDataDir: this.userDataDir,
      browser: this.browserPath,
      uptime: Date.now() - this.startedAt,
      restarts: this.restarts,
      state: this.phase,
      reason: this.reason,
      socket: this.socketPath,
      owners: [...this.owners.keys()],
      tabs: [...this.targets.values()].filter(info => info.type === 'page').length,
    };
  }

  status(owner) {
    const describe = this.describe();
    const tabEntries = [...this.targets.values()]
      .filter(info => info.type === 'page')
      .map(info => ({
        id: info.targetId,
        shortId: shortId(info.targetId),
        title: info.title || '',
        url: info.url || '',
        owner: this.ownerByTarget(info.targetId),
      }));
    return {
      ...describe,
      config: this.config,
      tabs: tabEntries,
      current: this.owners.has(owner) ? this.owners.get(owner).current : null,
      snapshotRefs: (() => {
        const current = this.owners.has(owner) ? this.owners.get(owner).current : null;
        const session = current ? this.pages.get(current) : null;
        return session && session.registry ? Object.keys(session.registry.refs).length : 0;
      })(),
    };
  }

  persist() {
    const owners = {};
    for (const [owner, record] of this.owners) {
      owners[owner] = { tabs: [...record.tabs], current: record.current };
    }
    const payload = {
      profile: this.name,
      version: VERSION,
      chromePid: this.chromePid,
      port: this.port,
      userDataDir: this.userDataDir,
      headed: this.headed,
      owned: this.owned,
      browser: this.browserPath,
      owners,
      updatedAt: Date.now(),
    };
    this.state = payload;
    try { P.writeJson(P.statePath(this.name), payload); } catch (error) { this.log(`persist failed: ${error.message}`); }
    return payload;
  }

  async shutdown({ keepChrome = false } = {}) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log(`shutdown keepChrome=${keepChrome} pid=${this.chromePid}`);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    if (this.socketPath) P.removeFile(this.socketPath);
    if (this.cdp) {
      try { this.cdp.close(); } catch (_) { /* ignore */ }
      this.cdp = null;
    }
    if (!keepChrome) {
      const result = await CH.stopChrome({
        pid: this.chromePid, userDataDir: this.userDataDir, port: this.port, wsUrl: this.browserWsUrl,
      });
      this.log(`chrome stop: ${JSON.stringify(result)}`);
      // Whatever happened above, the user asked for a stopped profile: drop the
      // state so the next `start` boots clean. (Chrome we never owned is still
      // discoverable through SingletonLock.)
      P.removeFile(P.statePath(this.name));
    }
    if (this.lockFile) P.removeFile(this.lockFile);
    process.exit(0);
  }
}

async function main() {
  const name = process.argv[2];
  if (!name) { process.stderr.write('usage: daemon.js <profile>\n'); process.exit(2); }
  let options = {};
  try { options = JSON.parse(process.env.MBROWSER_DAEMON_OPTIONS || '{}'); } catch (_) { options = {}; }
  const daemon = new Daemon(name, options);
  try {
    await daemon.boot();
  } catch (error) {
    daemon.log(`boot failed: ${error.code || 'error'}: ${error.message}`);
    process.stderr.write(`mbrowser daemon: ${error.code || 'error'}: ${error.message}\n`);
    if (daemon.lockFile) P.removeFile(daemon.lockFile);
    process.exit(1);
  }
}

module.exports = { Daemon, PageSession, shortId, BACKOFF_MS, MAX_FAILURES, HEALTH_INTERVAL_MS };

if (require.main === module) main();
