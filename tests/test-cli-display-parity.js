'use strict';

// CLI display parity: one name per id, on all three platforms.
//
// What this defends:
//   1. `{id, displayName, shortMark, colour, providerless, deprecated,
//      replacedBy}` exists once per platform — server
//      (src/cli/cli-capability.js DISPLAY, the authoritative one), web
//      (public/provider-catalog.js CLI_DISPLAY) and app
//      (app/lib/utils/cli_display.dart kCliDisplays) — and the three copies
//      agree. Before this they were written out ten-plus times and had already
//      drifted: the app's dashboard showed codebuddy / kimi / dsh / gemini / grok
//      as "Claude", air-cli-update.js was missing claude-exp / codex-exp.
//   2. An unknown id keeps its own spelling. The fallbacks this replaced
//      answered 'Claude' (Flutter) or 'WorkBuddy' (web AI config), so a CLI the
//      table had never heard of was displayed as a completely different product.
//   3. The consumers really point at the canonical module instead of carrying
//      another copy.
//   4. The 2026-09-24 rename and the deprecation plan it came with (codex-exp is
//      the product's "Codex"; `codex exec` is the fallback "Codex Exec", on its
//      way out) are one fact per platform, not a per-picker decision.
//
// The Dart file is parsed, not imported (same approach as
// tests/test-status-presentation.js), so this stays in the plain node lane.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CAP = require('../src/cli/cli-capability.js');
const CATALOG = require('../public/provider-catalog.js');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** kCliDisplays literal from the Dart source. */
function dartTable() {
  const src = read('app/lib/utils/cli_display.dart');
  // Three positional args, then any number of `name: value` flags (true/false or
  // a quoted string), in any order — `providerless: true`, `deprecated: true,
  // replacedBy: 'codex-exp'`, or none at all.
  const re = /'([^']+)':\s*CliDisplay\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*([A-Za-z0-9_.]+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*((?:,\s*[A-Za-z]+\s*:\s*(?:true|false|'[^']*'))*)\s*\)/g;
  const out = {};
  for (const m of src.matchAll(re)) {
    const flags = {};
    for (const pair of m[5].matchAll(/([A-Za-z]+)\s*:\s*(true|false|'([^']*)')/g)) {
      flags[pair[1]] = pair[2] === 'true' ? true : pair[2] === 'false' ? false : pair[3];
    }
    out[m[1]] = {
      displayName: m[2],
      colourSymbol: m[3],
      shortMark: m[4],
      providerless: flags.providerless === true,
      deprecated: flags.deprecated === true,
      replacedBy: typeof flags.replacedBy === 'string' ? flags.replacedBy : null,
    };
  }
  assert.ok(Object.keys(out).length >= 10, 'kCliDisplays literal not found in app/lib/utils/cli_display.dart');
  return out;
}

const DART = dartTable();
const WEB = CATALOG.CLI_DISPLAY;
const SERVER = CAP.DISPLAY;

const ids = Object.keys(SERVER).sort();

// ── 1. Same ids everywhere ──────────────────────────────────────────────────

test('server / web / app carry the same CLI id set', () => {
  assert.deepEqual(Object.keys(WEB).sort(), ids, 'web CLI_DISPLAY ids differ from server DISPLAY');
  assert.deepEqual(Object.keys(DART).sort(), ids, 'app kCliDisplays ids differ from server DISPLAY');
  assert.deepEqual(CAP.knownClis().sort(), ids, 'knownClis() must be the DISPLAY key set');
});

// ── 2. Same columns everywhere ──────────────────────────────────────────────
test('displayName is identical on all three platforms', () => {
  for (const id of ids) {
    assert.equal(WEB[id].displayName, SERVER[id].displayName, `${id}: web name`);
    assert.equal(DART[id].displayName, SERVER[id].displayName, `${id}: app name`);
  }
});

test('shortMark is identical on all three platforms', () => {
  for (const id of ids) {
    assert.equal(WEB[id].shortMark, SERVER[id].shortMark, `${id}: web mark`);
    assert.equal(DART[id].shortMark, SERVER[id].shortMark, `${id}: app mark`);
  }
});

test('providerless flag is identical on all three platforms', () => {
  for (const id of ids) {
    assert.equal(WEB[id].providerless === true, SERVER[id].providerless, `${id}: web providerless`);
    assert.equal(DART[id].providerless, SERVER[id].providerless, `${id}: app providerless`);
  }
  assert.deepEqual(
    [...CATALOG.providerlessClis()].sort(),
    [...CAP.providerlessClis()].sort(),
    'providerless sets differ between server and web',
  );
});

test('the deprecation plan is identical on all three platforms', () => {
  // 2026-09-24：常驻 app-server 车道（codex-exp）扶正为产品的 Codex，一次性
  // `codex exec`（codex）退成兜底并计划淘汰。id 一个都没动（会话、Provider 池、
  // 路由都存着 id），所以「哪条线路要退役、该换成谁」必须是这一列事实，而不是各
  // 个选择器各自判断。
  for (const id of ids) {
    const deprecated = SERVER[id].deprecated === true;
    assert.equal(WEB[id].deprecated === true, deprecated, `${id}: web deprecated`);
    assert.equal(DART[id].deprecated, deprecated, `${id}: app deprecated`);
    const replacedBy = deprecated ? (SERVER[id].replacedBy || null) : null;
    assert.equal(WEB[id].replacedBy || null, replacedBy, `${id}: web replacedBy`);
    assert.equal(DART[id].replacedBy, replacedBy, `${id}: app replacedBy`);
    // 两个平台的谓词要与表一致 —— 页面和 App 都问它们，不再自己判断。
    assert.equal(CAP.isDeprecated(id), deprecated, `${id}: isDeprecated()`);
    assert.deepEqual(CAP.deprecationOf(id), deprecated ? { replacedBy } : null, `${id}: deprecationOf()`);
    assert.equal(CATALOG.cliDeprecated(id), deprecated, `${id}: web cliDeprecated()`);
    assert.equal(CATALOG.cliReplacedBy(id), replacedBy, `${id}: web cliReplacedBy()`);
    if (!deprecated) continue;
    // 指到一个不存在、指向自己、或指向另一条也在退役的线路，等于让用户换到一条
    // 用不了的线路上 —— UI 的提示就是这么变成假话的。
    assert.ok(ids.includes(replacedBy), `${id} must name a lane DISPLAY knows`);
    assert.notEqual(replacedBy, id, `${id} must not be replaced by itself`);
    assert.equal(SERVER[replacedBy].deprecated === true, false, `${id} must not point at another dying lane`);
  }
  // 判定只挂在 id 上：没听说过的 CLI 没有淘汰计划，也不该因此报错。
  assert.equal(CAP.isDeprecated('mystery-cli'), false);
  assert.equal(CAP.deprecationOf('mystery-cli'), null);
  assert.equal(CATALOG.cliDeprecated('mystery-cli'), false);
  assert.equal(CATALOG.cliReplacedBy('mystery-cli'), null);
  // The picker hands a CLI's meta to the client, so the flags have to travel with
  // it — a picker that only gets {label, color} cannot say "计划淘汰".
  assert.equal(CATALOG.cliMeta('codex').deprecated, true);
  assert.equal(CATALOG.cliMeta('codex').replacedBy, 'codex-exp');
  assert.equal(CATALOG.cliMeta('codex-exp').deprecated, undefined);
  assert.equal(CATALOG.cliMetaMap().codex.deprecated, true);
});

test('the promoted lane carries the product name, and the fallback says what it is', () => {
  // The rename, stated once: this is what every picker ends up showing.
  assert.equal(CAP.displayNameOf('codex-exp'), 'Codex');
  assert.equal(CAP.displayNameOf('codex'), 'Codex Exec');
  assert.equal(CATALOG.cliDisplayName('codex-exp'), 'Codex');
  assert.equal(CATALOG.cliMetaMap()['codex'].label, 'Codex Exec');
  // 角标不能撞：两颗 X 落在同一张任务卡上就分不出是哪条车道。
  const marks = ids.map(id => SERVER[id].shortMark);
  assert.equal(new Set(marks).size, marks.length, 'two CLIs share a shortMark');
  // 角标跟名字走，不是跟 id 走：X 归 Codex（codex-exp），E 归 Codex Exec（codex）。
  assert.equal(SERVER['codex-exp'].shortMark, 'X');
  assert.equal(SERVER.codex.shortMark, 'E');
});

test('colour is identical between server and web, and the app brands differ deliberately', () => {  for (const id of ids) {
    assert.equal(String(WEB[id].colour).toLowerCase(), String(SERVER[id].colour).toLowerCase(), `${id}: colour`);
  }
  // The app ships a light theme, so it may hold its own hex per brand — but each
  // one has to be a real AppColors constant, not an inlined literal.
  const theme = read('app/lib/theme.dart');
  for (const id of ids) {
    const symbol = DART[id].colourSymbol;
    assert.ok(/^AppColors\./.test(symbol), `${id}: app colour must come from AppColors, got ${symbol}`);
    const name = symbol.slice('AppColors.'.length);
    assert.ok(
      new RegExp(`static const(?: Color)?\\s+${name}\\s*=`).test(theme),
      `${id}: AppColors.${name} is not defined in app/lib/theme.dart`,
    );
  }
});

// ── 3. Every CLI the server accepts can be displayed ────────────────────────

test('every CLI the server accepts has a display entry', () => {
  // A lane added on the server without a row here would render as its own raw id
  // on every surface (that is the fallback, on purpose) — this turns "someone
  // forgot the display table" into a red test instead of a mystery on screen.
  const { SUPPORTED_CLIS } = require('../src/session-dto');
  const { SUPPORTED_CHAT_CLIS } = require('../src/cli-switch');
  const schema = JSON.parse(read('contracts/v1/schemas/session.schema.json'));
  const sets = [
    ['src/session-dto SUPPORTED_CLIS', SUPPORTED_CLIS],
    ['src/cli-switch SUPPORTED_CHAT_CLIS', SUPPORTED_CHAT_CLIS],
    ['contracts/v1 session.schema.json cli.enum', schema.properties.cli.enum],
  ];
  for (const [label, set] of sets) {
    for (const id of set) assert.ok(ids.includes(id), `${label} accepts ${id} but DISPLAY has no row for it`);
  }
});

// ── 4. Unknown ids keep their own spelling ──────────────────────────────────

test('an unknown CLI id falls back to the raw id, never to another product', () => {
  for (const junk of ['mystery-cli', 'claude-next', '']) {
    assert.equal(CAP.displayNameOf(junk), junk, `server displayNameOf(${JSON.stringify(junk)})`);
    assert.equal(CATALOG.cliDisplayName(junk), junk, `web cliDisplayName(${JSON.stringify(junk)})`);
    assert.equal(CATALOG.cliMeta(junk).label, junk, `web cliMeta(${JSON.stringify(junk)}).label`);
    assert.equal(CAP.isProviderless(junk), false, `server isProviderless(${JSON.stringify(junk)})`);
    assert.equal(CATALOG.cliProviderless(junk), false, `web cliProviderless(${JSON.stringify(junk)})`);
    assert.equal(CATALOG.nativeRouteLabel(junk), '', `web nativeRouteLabel(${JSON.stringify(junk)})`);
  }
  // The two fallbacks this replaced. A future id must not land on either.
  assert.equal(CATALOG.cliDisplayName('mystery-cli'), 'mystery-cli');
  assert.notEqual(CAP.displayNameOf('mystery-cli'), 'Claude');
  assert.notEqual(CATALOG.cliDisplayName('mystery-cli'), 'WorkBuddy');
});

test('unknown-id colour and mark stay neutral', () => {
  assert.equal(CAP.colourOf('mystery-cli'), CAP.DEFAULT_COLOUR);
  assert.equal(CATALOG.cliColour('mystery-cli'), CATALOG.CLI_DEFAULT_COLOUR);
  assert.equal(CAP.DEFAULT_COLOUR, CATALOG.CLI_DEFAULT_COLOUR, 'neutral grey must match across platforms');
  assert.equal(CAP.shortMarkOf('mystery-cli'), 'M');
  assert.equal(CATALOG.cliShortMark('mystery-cli'), 'M');
  assert.equal(CATALOG.cliShortMark(''), '?', 'an empty id has no letter to show');
});

// ── 5. Ids are matched case/space-insensitively ─────────────────────────────

test('lookups tolerate the spacing and casing a session record carries', () => {
  assert.equal(CAP.displayNameOf(' Claude '), 'Claude Code');
  assert.equal(CATALOG.cliDisplayName(' CODEX '), 'Codex Exec');
  assert.equal(CATALOG.cliMeta('ZCode').label, 'ZCode');
  assert.equal(CATALOG.cliMeta('zcode').color, SERVER.zcode.colour);
});

// ── 6. The providerless set is derived, not re-listed ───────────────────────

test('PROVIDERLESS_CLIS and NATIVE_ROUTE_LABELS are not written out again', () => {
  // Names that used to be spelled out: the five ids in cli-switch.js, the
  // four-entry NATIVE_ROUTE_LABELS copies in chat.js / air.js.
  const srcSwitch = read('src/cli-switch.js');
  assert.match(srcSwitch, /providerlessClis\(\)/, 'src/cli-switch.js must derive PROVIDERLESS_CLIS from the table');
  assert.doesNotMatch(srcSwitch, /new Set\(\[[^\]]*'qoder'[^\]]*\]\)/, 'src/cli-switch.js re-lists the providerless ids');
  for (const file of ['public/chat.js', 'public/air.js', 'public/air-task-settings.js']) {
    assert.doesNotMatch(read(file), /NATIVE_ROUTE_LABELS/, `${file} still defines NATIVE_ROUTE_LABELS`);
  }
});

// ── 7. No consumer keeps a second CLI label table ───────────────────────────

test('no page file defines its own CLI id → label map', () => {
  // A map entry keyed by a CLI id whose value is exactly a display name, either
  // `claude: 'Claude Code'` or `claude: { displayName: 'Claude Code' }`. Three
  // such entries in one file is a table; one or two is a coincidence (quota's
  // VENDOR_LABEL shares codex/qoder but is a different axis — it also names
  // non-CLIs like ark/zhipu, and spells `opencode: 'OpenCode Go'`).
  const nameAlt = ids.map(id => SERVER[id].displayName).join('|');
  const idAlt = ids.map(id => id.replace(/-/g, '\\-')).join('|');
  const entry = new RegExp(`['"]?(?:${idAlt})['"]?\\s*:\\s*(?:\\{[^}\\n]*\\b(?:displayName|label|name)\\s*:\\s*)?['"](?:${nameAlt})['"](?=\\s*[,}])`, 'g');
  const allow = new Set(['public/provider-catalog.js', 'src/cli/cli-capability.js', 'public/i18n-catalog.js']);
  const offenders = [];
  for (const dir of ['public', 'src']) {
    for (const rel of walk(dir)) {
      if (allow.has(rel) || /\.min\.js$/.test(rel)) continue;
      const hits = [...fs.readFileSync(path.join(ROOT, rel), 'utf8').matchAll(entry)];
      if (hits.length >= 3) offenders.push(`${rel} (${hits.length})`);
    }
  }
  assert.deepEqual(offenders, [], 'these files carry their own CLI id → label map');
});

/** Relative POSIX-ish paths of every .js/.html under dir (files only). */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(rel));
    } else if (/\.(js|html)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

test('the former hand-written label tables are gone', () => {
  const consumers = [
    'public/chat.js',
    'public/air-task-settings.js',
    'public/air-cli-update.js',
    'public/air-provider.js',
    'public/chat-ai-config.js',
  ];
  for (const file of consumers) {
    const src = read(file);
    for (const gone of ['CLI_LABELS', 'CLI_MARKS', 'CLI_NAMES', 'CLI_META = {']) {
      assert.ok(!src.includes(gone), `${file} still has ${gone}`);
    }
  }
  // The one surviving CLI_META is chat.js's, and it is built from the catalog.
  const chat = read('public/chat.js');
  assert.match(chat, /CLI_META = _providerCatalog\.cliMetaMap\(\)/, 'chat.js must build CLI_META from the catalog');
  assert.match(chat, /nativeRouteLabel\(/, 'chat.js must take the native route label from the catalog');
  const dartMessage = read('app/lib/models/message.dart');
  assert.match(dartMessage, /String get displayName => cliDisplayName\(name\)/, 'message.dart must delegate to cli_display.dart');
  assert.match(read('app/lib/screens/dashboard_screen.dart'), /cliDisplayName\(/, 'dashboard_screen.dart must delegate to cli_display.dart');
});

// ── 8. Wiring: the pages load the catalog before its consumers ──────────────

test('chat.html and air.html load provider-catalog.js before every CLI-name consumer', () => {
  for (const [page, consumers] of [
    ['public/chat.html', ['chat.js', 'chat-ai-config.js', 'chat-live-ui.js']],
    ['public/air.html', ['air.js', 'air-task-settings.js', 'air-cli-update.js', 'air-provider.js']],
  ]) {
    const html = read(page);
    const at = html.indexOf('<script src="provider-catalog.js"></script>');
    assert.ok(at > 0, `${page} does not load provider-catalog.js`);
    for (const consumer of consumers) {
      const cAt = html.indexOf(`<script src="${consumer}"></script>`);
      if (cAt < 0) continue;
      assert.ok(at < cAt, `${page}: provider-catalog.js must come before ${consumer}`);
    }
  }
});
