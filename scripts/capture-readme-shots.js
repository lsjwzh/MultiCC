'use strict';

// Regenerate the English-UI screenshots the top-level README.md references.
//
//   node scripts/capture-readme-shots.js            # all six
//   node scripts/capture-readme-shots.js air-tasks  # one, by name
//
// The README.zh.md keeps the Chinese captures under docs/images/; the English
// ones live under docs/images/en/. Both are the same screens, so this script
// renders the Air console against a fixture server (tests/helpers/cdp-harness)
// that mocks every API the page reads, forces the English dictionary, seeds
// English demo data, and captures at 1280x840 @2x (a little taller than the Chinese originals so the sticky composer does not cover the task stats) (or 390x844 @2x for the
// phone shot) — the same geometry as the Chinese originals.
//
// Nothing here talks to a live MultiCC host: no token, no real path, no
// private data. Every value below is invented for the shot.

const fs = require('node:fs');
const path = require('node:path');
const { createCdpHarness, findChromeBinary } = require('../tests/helpers/cdp-harness');

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'images', 'en');
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const DESKTOP = { width: 1280, height: 840, deviceScaleFactor: 2, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

// ── fixture plumbing ──────────────────────────────────────────────────────

const CONTENT_TYPE = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
};

const json = value => ({ headers: { 'content-type': CONTENT_TYPE.json }, body: JSON.stringify(value) });

/** Every file under public/, at the same path the app asks for it. */
function staticRoutes() {
  const routes = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const extension = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase();
      routes['/' + path.relative(PUBLIC_DIR, full).split(path.sep).join('/')] = {
        body: fs.readFileSync(full),
        headers: { 'content-type': CONTENT_TYPE[extension] || 'application/octet-stream' },
      };
    }
  };
  walk(PUBLIC_DIR);
  // The shell is served at /air (and / is the same page on a real host).
  routes['/air'] = routes['/air.html'];
  routes['/'] = routes['/air.html'];
  // The console never signs in: the fixture has no auth, so the client stub
  // returns the same origin without a ticket.
  routes['/auth-client.js'] = {
    headers: { 'content-type': CONTENT_TYPE.js },
    body: 'window.multiccWsUrl = async url => url + (url.includes("?") ? "&" : "?") + "ticket=fixture";',
  };
  // Landing page used only to set localStorage on the fixture origin before the
  // first real navigation, so the very first paint is already English.
  routes['/__lang'] = { headers: { 'content-type': CONTENT_TYPE.html }, body: '<!doctype html><title>lang</title>' };
  return routes;
}

// ── demo data ─────────────────────────────────────────────────────────────
//
// One workspace with three running tasks. The titles are the same three the
// Chinese captures show, in English.

const DEMO_DIR = { id: 'dir-demo', name: 'demo-project', path: '/tmp/demo/demo-project' };

const DEMO_TASKS = [
  { id: 'task-onboarding-docs', title: 'Write onboarding docs for new users', at: '2026-09-16T10:28:00Z' },
  { id: 'task-mobile-history', title: 'Fix mobile chat history failing to load', at: '2026-09-16T10:21:00Z' },
  { id: 'task-login-refactor', title: 'Refactor login module and add integration tests', at: '2026-09-16T10:14:00Z' },
];

function airTask(entry, index) {
  const at = Date.parse(entry.at);
  return {
    id: entry.id,
    dirId: DEMO_DIR.id,
    title: entry.title,
    status: 'active',
    recordType: null,
    workflowStage: null,
    updatedAt: at,
    lastMessageAt: at,
    sessionId: `session-${index + 1}`,
    runState: 'running',
    resource: {
      id: `ws-${index + 1}`,
      residency: 'resident',
      lease: 'idle',
      capacityReason: null,
      reason: null,
      pins: [],
      // Worktree paths are shown only in a tooltip; keep them inside the demo
      // directory so no real path can leak into a shot.
      path: `${DEMO_DIR.path}/.multicc-worktrees/${entry.id}`,
      branch: `multicc/task-${entry.id}`,
    },
  };
}

function airSnapshot(overrides = {}) {
  return {
    ok: true,
    directories: [{
      id: DEMO_DIR.id,
      name: DEMO_DIR.name,
      path: DEMO_DIR.path,
      worktreeCount: DEMO_TASKS.length,
      worktreeLifecycle: { resident: 2, retained: 1, hibernated: 0, planned: 0, leased: 0, onDisk: 3, total: 3 },
    }],
    tasks: DEMO_TASKS.map(airTask),
    taskPins: [],
    budgets: {},
    clis: ['claude', 'codex'],
    migration: { errors: [] },
    // "The last configuration actually used" — what the new-task pill shows.
    lastRuntime: { cli: 'claude', provider: 'claude-official', providerName: 'Claude 官方', model: null, effort: null, subagent: null, providerSelection: null },
    worktreePolicy: null,
    sessions: [],
    ...overrides,
  };
}

/** The provider catalog behind the CLIs & Providers page. */
function providerCatalog() {
  return {
    available: true,
    ccSwitchAvailable: true,
    ccSwitchStatus: { available: true },
    providers: [
      {
        id: 'claude-official', appType: 'claude', name: 'Claude 官方', source: 'builtin',
        apiFormat: 'anthropic', isOfficial: true, hasToken: false, model: '',
        modelOptions: [], compatibleClis: ['claude', 'claude-exp', 'opencode'], limit: null,
      },
      {
        id: 'codex-official', appType: 'codex', name: 'Codex 官方', source: 'builtin',
        apiFormat: 'openai_responses', isOfficial: true, hasToken: false, model: '',
        modelOptions: [], compatibleClis: ['codex', 'codex-exp', 'opencode'], limit: null,
      },
    ],
    defaults: { claude: 'claude-official', codex: 'codex-official' },
    stats: [],
    limitCacheStaleMs: 300000,
  };
}

/** /api/aux/config, both states: unconfigured (the setup card) and configured. */
function auxConfig(configured) {
  return {
    protocol: 'anthropic',
    providerId: configured ? 'claude-official' : null,
    model: configured ? 'haiku' : null,
    cliAvailability: { claude: true, codex: false },
    protocols: [
      { id: 'anthropic', name: 'Anthropic Messages' },
      { id: 'openai', name: 'OpenAI Responses / Chat Completions' },
    ],
    providersByProtocol: {
      anthropic: configured ? [{
        id: 'claude-official', name: 'Claude Official', modelOptions: ['haiku', 'sonnet', 'opus'],
        wireApi: 'messages', available: true, unavailableReason: null, limit: null,
      }] : [],
      openai: [],
    },
  };
}

const AUX_STATUS = {
  processing: false,
  queueDepth: 0,
  active: 0,
  capacity: 2,
  lanes: { serial: { active: 0, queueDepth: 0 } },
  totalProcessed: 0,
  lastTaskTime: null,
  currentTask: null,
  health: { unhealthy: false, consecutiveFails: 0, lastFailMsg: null },
};

/**
 * Every read the Air shell makes, answered from the fixture. Anything a page
 * does not ask for is simply never routed; unknown paths 404 and the page's own
 * error handling reports it, which is what makes a missing mock obvious.
 */
function apiRoutes(options = {}) {
  const snapshot = options.snapshot || airSnapshot();
  return {
    'GET /api/air': json(snapshot),
    'GET /api/air/pins': json({ ok: true, taskIds: [] }),
    'GET /api/cron': json([]),
    'GET /api/docs-registry': json([]),
    'GET /api/aux/status': json(options.auxStatus || AUX_STATUS),
    'GET /api/aux/config': json(options.auxConfig || auxConfig(false)),
    'GET /api/aux/history': json([]),
    'GET /api/cli/install-specs': json({
      ok: true,
      specs: {
        claude: { command: 'npm install -g @anthropic-ai/claude-code', display: 'npm install -g @anthropic-ai/claude-code' },
        codex: { command: 'npm install -g @openai/codex', display: 'npm install -g @openai/codex' },
      },
    }),
    'GET /api/cli/versions': json({ ok: true, clis: {} }),
    'GET /api/providers': json(options.providers || providerCatalog()),
    'GET /api/provider-defaults': json({ claude: 'claude-official', codex: 'codex-official' }),
    'GET /api/token-usage/global': json({ ok: true, usage: null, stats: [] }),
    'GET /api/token-usage/by-role': json({ ok: true, roles: [] }),
    'GET /api/version-check': json({ current: '2.1.1', channel: 'release', latest: 'v2.1.1', latestVersion: '2.1.1', updateAvailable: false }),
    'GET /api/server-info': json({ url: 'http://127.0.0.1:3000', uptimeMs: 3 * 3600 * 1000 + 25 * 60 * 1000 }),
    'GET /api/apk-info': json({ exists: false }),
    'GET /api/ios-ota-info': json({ exists: false }),
    'GET /api/settings/notify': json({ ok: true }),
    'GET /api/push/health': json({ ok: true }),
    'GET /api/settings/power': json({ ok: true }),
    'GET /api/settings/goal': json({ ok: true }),
    'GET /api/settings/voice': json({ ok: true }),
    'GET /api/settings/tunnel': json({ ok: true }),
    'GET /api/agent-presets': json({ ok: true, presets: [] }),
    'GET /api/git/directory-status': json({ ok: true, status: null }),
    'GET /api/workspaces/overview': json({ ok: true, workspaces: [] }),
    'GET /api/uploads/stats': json({ ok: true, total: 0 }),
    'GET /api/skill-sync/status': json({ ok: true, skills: [] }),
    'GET /api/settings/official-oauth': json({ ok: true }),
    'GET /api/system/privileged-helper': json({ ok: false }),
  };
}

// ── page driving ──────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// harness 的 waitFor 超时只回 null；截图场景里那等于悄悄拍下一张错的画面。
// 这里统一包一层：等不到就带着表达式报错。
function strict(page) {
  const waitFor = page.waitFor.bind(page);
  page.waitFor = async (expression, options) => {
    const value = await waitFor(expression, { timeoutMs: 10000, ...(options || {}) });
    if (!value) throw new Error(`timed out waiting for: ${expression}`);
    return value;
  };
  return page;
}

// Demo state that lives in the browser rather than on the host: the language,
// and the list of tasks this browser has opened (the sidebar's "Recent tasks"
// is exactly that list plus unread results — see air-task-notify.js).
const BROWSER_STATE = {
  multicc_lang: 'en',
  'air:recent-tasks': DEMO_TASKS.map(task => task.id),
};

async function openEnglish(page, query = '', metrics = DESKTOP) {
  await page.send('Emulation.setDeviceMetricsOverride', metrics);
  await page.navigate('/__lang');
  await page.evaluate(`(() => {
    ${Object.entries(BROWSER_STATE).map(([key, value]) => `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))});`).join('\n    ')}
    return document.documentElement.lang;
  })()`);
  await page.navigate(`/air${query}`);
  await page.waitFor('window.t && getLang() === "en" && document.body.innerText.length > 0');
  // The shell paints from the first /api/air snapshot; wait for the task rows it
  // builds rather than for a fixed delay.
  await page.waitFor(`document.querySelectorAll('#tasks button').length > 0`, { timeoutMs: 10000 });
  await sleep(400);
}

/** Freeze animations so a shot never lands mid-transition or mid-marquee. */
async function settle(page) {
  await page.evaluate(`(() => {
    if (document.getElementById('__shot-freeze')) return;
    const style = document.createElement('style');
    style.id = '__shot-freeze';
    style.textContent = '*,*::before,*::after{animation:none !important;transition:none !important;}';
    document.head.append(style);
    document.activeElement?.blur?.();
  })()`);
  await sleep(250);
}

async function shoot(page, file) {
  const captured = await page.screenshot(file);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(captured, path.join(OUT_DIR, file));
  return path.join(OUT_DIR, file);
}

// ── the six shots ─────────────────────────────────────────────────────────

const SHOTS = {
  // The workspace home: directory card, three running tasks, task stats and the
  // new-task composer. Same screen as the Chinese air-tasks.png.
  // The AI Assistant is configured here, so the first-run card is gone and the
  // shot is about the tasks (air-first-run.png is the unconfigured twin).
  'air-tasks': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes({ auxConfig: auxConfig(true) }) }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
      await openEnglish(page, `?dir=${DEMO_DIR.id}`);
      await page.waitFor(`document.querySelector('#task-title').textContent === 'demo-project'`);
      await settle(page);
      return shoot(page, 'air-tasks.png');
    },
  },

  // The first-run setup card. It only exists while the AI Assistant has no
  // provider configured, so this scene answers /api/aux/config with a null
  // providerId — which is exactly the state the card is for.
  'air-first-run': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes() }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
      await openEnglish(page, `?dir=${DEMO_DIR.id}`);
      await page.waitFor(`!document.getElementById('setup-card').hidden`);
      await settle(page);
      return shoot(page, 'air-first-run.png');
    },
  },

  // The new-task composer with its AI configuration pill, and the dialog the
  // pill opens (CLI / Provider / model / reasoning effort).
  'air-new-task': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes() }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
      await openEnglish(page, `?dir=${DEMO_DIR.id}`);
      await page.waitFor(`document.querySelector('#quick-ai-pill').textContent.trim().length > 0`);
      await page.evaluate(`document.getElementById('quick-ai-pill').click()`);
      await page.waitFor(`[...document.querySelectorAll('dialog')].some(d => d.open)`);
      await settle(page);
      return shoot(page, 'air-new-task.png');
    },
  },

  // The same three things on a phone-width screen, where the sidebar is a
  // drawer and the composer folds to a bar at the foot of the page.
  'air-mobile': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes() }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', PHONE);
      await openEnglish(page, `?dir=${DEMO_DIR.id}`, PHONE);
      await page.waitFor(`document.querySelector('#task-title').textContent === 'demo-project'`);
      await settle(page);
      // Scroll past the header so the setup card, the task stats and the recent
      // tasks all sit in one screen — the composition the Chinese shot uses.
      await page.evaluate(`(() => {
        const main = document.querySelector('main');
        const card = document.getElementById('setup-card');
        main.scrollTop = card.getBoundingClientRect().top - 8;
      })()`);
      await sleep(300);
      return shoot(page, 'air-mobile.png');
    },
  },

  // CLI & provider settings: the routing catalog, the per-CLI default route
  // selects and the provider cards.
  'air-provider': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes() }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
      await openEnglish(page, `?dir=${DEMO_DIR.id}&view=provider`);
      await page.waitFor(`document.querySelector('#task-title').textContent === 'CLIs & Providers'`);
      await page.waitFor(`document.querySelectorAll('#air-provider-cards .air-provider-card').length === 2`);
      await settle(page);
      return shoot(page, 'air-provider.png');
    },
  },

  // The AI Assistant page: run status, model settings, run history. The history
  // is empty on purpose — a configured-but-idle host, which is also the only
  // state whose heading does not print a missing dictionary key.
  'aux-console': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes({ auxConfig: auxConfig(true) }) }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
      await openEnglish(page, `?dir=${DEMO_DIR.id}&view=aux`);
      await page.waitFor(`document.querySelector('#task-title').textContent === 'AI Assistant'`);
      await page.waitFor(`document.querySelector('#air-aux-status .air-aux-row')`);
      await page.waitFor(`document.querySelector('#air-aux-records')`);
      await settle(page);
      return shoot(page, 'aux-console.png');
    },
  },
};

// ── entry point ───────────────────────────────────────────────────────────

async function main() {
  if (!findChromeBinary()) {
    console.error('Chrome/Chromium not found; set MULTICC_CHROME_BIN to capture the shots.');
    process.exit(1);
  }
  const wanted = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
  const names = wanted.length ? wanted.map(name => name.replace(/\.png$/, '')) : Object.keys(SHOTS);
  for (const name of names) {
    const shot = SHOTS[name];
    if (!shot) {
      console.error(`unknown shot: ${name} (known: ${Object.keys(SHOTS).join(', ')})`);
      process.exit(1);
    }
    const harness = await createCdpHarness({
      timeoutMs: 30000,
      routes: shot.routes(),
      screenshotDir: path.join(require('node:os').tmpdir(), 'multicc-readme-shots'),
    });
    try {
      const file = await shot.capture(strict(harness));
      console.log(`${name}: ${file}`);
    } finally {
      await harness.close();
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  BROWSER_STATE,
  DEMO_DIR,
  DEMO_TASKS,
  DESKTOP,
  OUT_DIR,
  PHONE,
  SHOTS,
  airSnapshot,
  apiRoutes,
  auxConfig,
  openEnglish,
  settle,
  shoot,
  staticRoutes,
};
