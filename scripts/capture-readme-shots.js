'use strict';

// Capture the current, unmodified web UI with isolated, synthetic API data.
// This is a UI illustration, never evidence of an agent run or account activity.
//   node scripts/capture-readme-shots.js                     # both languages
//   node scripts/capture-readme-shots.js --lang=en air-tasks # one capture
// No live host, credentials, model requests or personal browser profile are used.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCdpHarness, findChromeBinary } = require('../tests/helpers/cdp-harness');

const IMAGE_DIR = path.resolve(__dirname, '..', 'docs', 'images');
let language = 'en';
const outputDir = () => language === 'en' ? path.join(IMAGE_DIR, 'en') : IMAGE_DIR;
const demoText = (en, zh) => language === 'en' ? en : zh;
const CLIS = ['claude', 'codex', 'opencode', 'zcode', 'kimi', 'qoder', 'codebuddy', 'dsh', 'gemini', 'commandcode', 'grok', 'pi'];
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const DESKTOP = { width: 1440, height: 960, deviceScaleFactor: 2, mobile: false };
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
// Synthetic workspace and tasks, shared by both language variants.

const DEMO_DIR = { id: 'dir-demo', name: 'demo-project', path: '/projects/demo-project' };

const DEMO_TASKS = [
  { id: 'task-onboarding-docs', title: 'Write onboarding docs for new users', zh: '编写新用户上手文档', state: 'running', at: '2026-10-24T08:28:00Z' },
  { id: 'task-mobile-history', title: 'Fix mobile chat history failing to load', zh: '修复手机端聊天历史加载', state: 'waiting', at: '2026-10-24T08:21:00Z' },
  { id: 'task-login-refactor', title: 'Refactor login module and add integration tests', zh: '重构登录模块并补充集成测试', state: 'idle', at: '2026-10-24T08:14:00Z' },
];

function airTask(entry, index) {
  const at = Date.parse(entry.at);
  return {
    id: entry.id,
    dirId: DEMO_DIR.id,
    title: demoText(entry.title, entry.zh),
    status: 'active',
    recordType: null,
    workflowStage: null,
    updatedAt: at,
    lastMessageAt: at,
    sessionId: `session-${index + 1}`,
    runState: entry.state,
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
    clis: CLIS,
    migration: { errors: [] },
    // "The last configuration actually used" — what the new-task pill shows.
    lastRuntime: { cli: 'claude', provider: 'claude-official', providerName: demoText('Claude terminal login', '同 Claude 终端'), model: null, effort: null, subagent: null, providerSelection: null },
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
        id: 'claude-official', appType: 'claude', name: demoText('Claude terminal login', '同 Claude 终端'), source: 'builtin',
        apiFormat: 'anthropic', isOfficial: true, hasToken: false, model: '',
        modelOptions: [], compatibleClis: ['claude', 'claude-exp', 'opencode'], limit: null,
      },
      {
        id: 'codex-official', appType: 'codex', name: demoText('Codex terminal login', '同 Codex 终端'), source: 'builtin',
        apiFormat: 'openai_responses', isOfficial: true, hasToken: false, model: '',
        modelOptions: [], compatibleClis: ['codex', 'codex-exp', 'opencode'], limit: null,
      },
      {
        id: 'claude-official-demo-work', appType: 'claude', name: demoText('Claude · Work account', 'Claude · 工作账号'),
        source: 'builtin', apiFormat: 'anthropic', isOfficial: true, builtinOfficial: true,
        officialAccountId: 'demo-work', hasToken: false, model: '', modelOptions: [],
        compatibleClis: ['claude', 'claude-exp'], limit: null,
        egressBinding: { pluginId: 'chrome-proxy-launcher', profileId: 'demo-work-egress' },
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
    cliAvailability: { claude: true, codex: true },
    protocols: [
      { id: 'anthropic', name: 'Anthropic Messages' },
      { id: 'openai', name: 'OpenAI Responses / Chat Completions' },
    ],
    providersByProtocol: {
      anthropic: configured ? [{
        id: 'claude-official', name: demoText('Claude terminal login', '同 Claude 终端'), modelOptions: ['haiku', 'sonnet', 'opus'],
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
    '/api/air': json(snapshot),
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
        codex: { command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', display: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
      },
    }),
    'GET /api/cli/versions': json({ ok: true, clis: { claude: { installed: true }, codex: { installed: true } } }),
    'GET /api/providers': json(options.providers || providerCatalog()),
    'GET /api/provider-defaults': json({ claude: 'claude-official', codex: 'codex-official' }),
    'GET /api/token-usage/global': json({ ok: true, usage: null, stats: [] }),
    'GET /api/token-usage/by-role': json({ ok: true, roles: [] }),
    'GET /api/version-check': json({ current: require('../package.json').version, channel: 'release', latest: 'v' + require('../package.json').version, latestVersion: require('../package.json').version, updateAvailable: false }),
    'GET /api/server-info': json({ url: 'http://127.0.0.1:3000', uptimeMs: 3 * 3600 * 1000 + 25 * 60 * 1000 }),
    'GET /api/apk-info': json({ exists: false }),
    'GET /api/ios-ota-info': json({ exists: false }),
    'GET /api/settings/notify': json({ ok: true }),
    'GET /api/push/health': json({ ok: true }),
    'GET /api/settings/power': json({ ok: true, available: true, enabled: true,
      unlockPassword: { available: true, set: true, canEdit: true, enabled: true, requiredByLid: true, authorization: { state: 'authorized' } } }),
    'GET /api/settings/goal': json({ ok: true }),
    'GET /api/settings/voice': json({ ok: true }),
    'GET /api/settings/tunnel': json({ ok: true }),
    'GET /api/agent-presets': json({ ok: true, presets: [] }),
    'GET /api/git/directory-status': json({ branch: 'main', baseBranch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirtyFiles: [] }),
    'GET /api/workspaces/overview': json({ ok: true, workspaces: [] }),
    'GET /api/uploads/stats': json({ ok: true, total: 0 }),
    'GET /api/skill-sync/status': json({ ok: true, skills: [] }),
    'GET /api/settings/official-oauth': json({ ok: true }),
    'GET /api/settings/cpr-backend': json({ ok: true, currentBackend: 'node', configuredBackend: 'node', rustAvailable: true, restartRequired: false }),
    'GET /api/system/agent-permissions': json({ ok: true, applicable: true, local: true, accessibility: true, screenRecording: true }),
    'GET /api/claude/accounts': json({ accounts: [], cliLogin: null }),
    'GET /api/codex/accounts': json({ accounts: [], cliLogin: null }),
    'GET /api/claude/subscription': json({ status: 'ok', subscription: null }),
    'GET /api/codex/subscription': json({ status: 'ok', subscription: null }),
    'GET /api/claude/models': json({ models: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }] }),
    'GET /api/codex/models': json({ models: [] }),
    'GET /api/ui-layout': json({ ok: true, layout: { dirOrder: [], sessionOrder: {} } }),
    'GET /api/git/log': json({ commits: [] }),
    'GET /api/plugins': json({ plugins: [{ id: 'chrome-proxy-launcher', engine: { available: true } }] }),
    'POST /api/plugins/chrome-proxy-launcher/run': json({ profiles: [
      { id: 'demo-work-egress', name: demoText('Work account proxy', '工作账号代理'), egressText: 'HTTP · 127.0.0.1:7890' },
      { id: 'demo-personal-egress', name: demoText('Personal account proxy', '个人账号代理'), egressText: 'HTTP · 127.0.0.1:7891' },
    ] }),
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

async function openPage(page, query = '', metrics = DESKTOP) {
  await page.send('Emulation.setDeviceMetricsOverride', metrics);
  await page.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await page.navigate('/__lang');
  await page.evaluate(`(() => {
    ${Object.entries({ ...BROWSER_STATE, multicc_lang: language }).map(([key, value]) => `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))});`).join('\n    ')}
    return document.documentElement.lang;
  })()`);
  await page.navigate(`/air${query}`);
  await page.waitFor(`window.t && getLang() === ${JSON.stringify(language)} && document.body.innerText.length > 0`);
  // The title is populated after the Air sync snapshot loads. Each scene below
  // also waits for the specific control it intends to capture.
  await page.waitFor(`document.querySelector('#task-title').textContent.trim().length > 0`, { timeoutMs: 10000 });
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
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.copyFileSync(captured, path.join(outputDir(), file));
  return path.join(outputDir(), file);
}

// ── current UI shots ─────────────────────────────────────────────────────────

const SHOTS = {
  // A configured workspace with running, waiting, and idle example tasks.
  'air-tasks': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes({ auxConfig: auxConfig(true) }) }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
      await openPage(page, `?dir=${DEMO_DIR.id}`);
      await page.waitFor(`document.querySelector('#task-title').textContent === 'demo-project'`);
      await settle(page);
      return shoot(page, 'air-tasks.png');
    },
  },

  // The first-run setup card. It only exists while the AI Assistant has no
  // provider configured, so this scene answers /api/aux/config with a null
  // providerId — which is exactly the state the card is for.
  'air-first-run': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes({ snapshot: airSnapshot({ directories: [], tasks: [] }) }) }),
    async capture(page) {
      await openPage(page, '?view=overview');
      await page.waitFor(`document.getElementById('setup-card').getBoundingClientRect().width > 0`);
      await settle(page);
      return shoot(page, 'air-first-run.png');
    },
  },

  // The new-task composer with its AI configuration pill, and the dialog the
  // pill opens (CLI / Provider / model / reasoning effort).
  'air-new-task': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes({ auxConfig: auxConfig(true) }) }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
      await openPage(page, `?dir=${DEMO_DIR.id}`);
      await page.waitFor(`document.querySelector('#quick-ai-pill').textContent.trim().length > 0`);
      await page.evaluate(`document.getElementById('quick-ai-pill').click()`);
      await page.waitFor(`[...document.querySelectorAll('dialog')].some(d => d.open)`);
      await page.waitFor(`document.querySelector('dialog[open] .rc-sub-guide-dismiss')`);
      await page.evaluate(`document.querySelector('dialog[open] .rc-sub-guide-dismiss').click()`);
      await sleep(200);
      await page.evaluate(`document.querySelector('dialog[open]').scrollTop = 0`);
      await settle(page);
      return shoot(page, 'air-new-task.png');
    },
  },

  // Responsive web UI at phone width (not a native Flutter screenshot).
  'air-mobile': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes({ auxConfig: auxConfig(true) }) }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', PHONE);
      await openPage(page, `?dir=${DEMO_DIR.id}`, PHONE);
      await page.waitFor(`document.querySelector('#task-title').textContent === 'demo-project'`);
      await settle(page);
      // Show the actual task list at phone width, using its normal scroll area.
      await page.evaluate(`(() => {
        const panel = document.getElementById('directory-task-panel-head');
        const main = document.getElementById('empty');
        main.scrollTop += panel.getBoundingClientRect().top - main.getBoundingClientRect().top;
      })()`);
      await sleep(300);
      return shoot(page, 'air-mobile.png');
    },
  },

  // CLI & provider settings: the routing catalog, the per-CLI default route
  // selects and the provider cards.
  'air-provider': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes({ auxConfig: auxConfig(true) }) }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
      await openPage(page, `?dir=${DEMO_DIR.id}&view=provider`);
      await page.waitFor(`document.querySelector('#air-provider-cards .air-provider-card')`);
      await page.waitFor(`document.querySelectorAll('#air-provider-cards .air-provider-card').length === 3`);
      await page.evaluate(`document.querySelector('#air-provider-cards').scrollIntoView({block:'start'})`);
      await settle(page);
      return shoot(page, 'air-provider.png');
    },
  },

  // Configured, idle AI Assistant; no invented execution history.
  'aux-console': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes({ auxConfig: auxConfig(true) }) }),
    async capture(page) {
      await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
      await openPage(page, `?dir=${DEMO_DIR.id}&view=aux`);
      await page.waitFor(`document.querySelector('#air-aux-status')`);
      await page.waitFor(`document.querySelector('#air-aux-status .air-aux-row')`);
      await page.waitFor(`document.querySelector('#air-aux-records')`);
      await settle(page);
      return shoot(page, 'aux-console.png');
    },
  },
  'air-power': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes({ auxConfig: auxConfig(true) }) }),
    async capture(page) {
      await openPage(page, `?dir=${DEMO_DIR.id}&view=global`);
      await page.waitFor(`document.querySelector('#air-global-power-card:not([hidden])')`);
      await page.waitFor(`!document.querySelector('#air-global-power-toggle').disabled`);
      await page.evaluate(`document.querySelector('#air-global-power-card').scrollIntoView({block:'center'})`);
      await settle(page);
      return shoot(page, 'air-power.png');
    },
  },
  'air-account-proxy': {
    routes: () => ({ ...staticRoutes(), ...apiRoutes({ auxConfig: auxConfig(true) }) }),
    async capture(page) {
      await openPage(page, `?dir=${DEMO_DIR.id}&view=provider`);
      await page.waitFor(`document.querySelector('[data-provider-id="claude-official-demo-work"]')`);
      await page.evaluate(`[...document.querySelectorAll('[data-provider-id="claude-official-demo-work"] button')].find(b=>b.textContent===t('airProviderEdit')).click()`);
      await page.waitFor(`document.querySelector('#air-provider-form').dataset.egressBindingState === 'ready'`);
      await page.evaluate(`document.querySelector('#air-provider-egress-binding').scrollIntoView({block:'center'})`);
      await settle(page);
      return shoot(page, 'air-account-proxy.png');
    },
  },
};


// ── entry point ───────────────────────────────────────────────────────────

async function main() {
  if (!findChromeBinary()) {
    console.error('Chrome/Chromium not found; set MULTICC_CHROME_BIN to capture the shots.');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const requestedLanguage = args.find(arg => arg.startsWith('--lang='))?.split('=')[1] || 'all';
  if (!['all', 'en', 'zh'].includes(requestedLanguage)) throw new Error('Use --lang=all, en or zh');
  const languages = requestedLanguage === 'all' ? ['en', 'zh'] : [requestedLanguage];
  const wanted = args.filter(arg => !arg.startsWith('-'));
  const names = wanted.length ? wanted.map(name => name.replace(/\.png$/, '')) : Object.keys(SHOTS);
  const manifestPath = path.join(IMAGE_DIR, 'capture-manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { captures: {} };
  const digest = input => crypto.createHash('sha256').update(input).digest('hex');
  const sourceDigest = crypto.createHash('sha256');
  const fingerprint = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) fingerprint(full);
      else { sourceDigest.update(path.relative(PUBLIC_DIR, full)); sourceDigest.update(fs.readFileSync(full)); }
    }
  };
  fingerprint(PUBLIC_DIR);
  const source = { version: require('../package.json').version, publicSha256: sourceDigest.digest('hex'),
    captureScriptSha256: digest(fs.readFileSync(__filename)) };

  for (language of languages) for (const name of names) {
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
      manifest.captures[`${language}/${name}`] = { ...source,
        file: path.relative(IMAGE_DIR, file).split(path.sep).join('/'),
        language, viewport: name === 'air-mobile' ? PHONE : DESKTOP,
        capturedAt: new Date().toISOString(), sha256: digest(fs.readFileSync(file)),
        dataSource: 'isolated synthetic API fixture; current unmodified web UI',
      };
      console.log(`${language}/${name}: ${file}`);
    } finally {
      await harness.close();
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
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
  outputDir,
  PHONE,
  SHOTS,
  airSnapshot,
  apiRoutes,
  auxConfig,
  openPage,
  settle,
  shoot,
  staticRoutes,
};
