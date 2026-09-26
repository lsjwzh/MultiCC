'use strict';

// CLI display parity: one name per id, on all three platforms.
//
// What this defends:
//   1. One CLI catalogue exists once per platform — server
//      (src/cli/cli-capability.js CLIS, the authoritative one), web
//      (public/provider-catalog.js CLI_FAMILIES) and app
//      (app/lib/utils/cli_display.dart kCliFamilies) — and the three agree.
//      Before this they were written out ten-plus times and had already drifted:
//      the app's dashboard showed codebuddy / kimi / dsh / gemini / grok as
//      "Claude", air-cli-update.js was missing claude-exp / codex-exp.
//   2. The catalogue is two-level — a CLI is a *family*, and each family lists,
//      per session kind, the *lanes* that kind presents — and the flat lane
//      table every consumer reads is derived from it, not a second copy. The
//      three platforms must derive the same rows from the same structure:
//      `claude` in chat is "Claude / Claude Agent SDK", `claude` in a terminal
//      is the command itself, and both are one family.
//   3. An unknown id keeps its own spelling. The fallbacks this replaced
//      answered 'Claude' (Flutter) or 'WorkBuddy' (web AI config), so a CLI the
//      table had never heard of was displayed as a completely different product.
//   4. The consumers really point at the canonical module instead of carrying
//      another copy.
//   5. The two renames and what came with them — 2026-09-24: codex-exp is the
//      product's "Codex" and `codex exec` the fallback "Codex Exec"; 2026-09-26:
//      claude-exp is the product's "Claude" with the engine line "Claude Agent
//      SDK", and the two one-shot lanes (`claude -p`, `codex exec`) left the chat
//      pickers for the terminal — are one fact per platform, not a per-picker
//      decision.
//
// The Dart file is parsed, not imported (same approach as
// tests/test-status-presentation.js), so this stays in the plain node lane. Its
// structure is compared with the server's and flattened by the rule the Dart
// code implements; the values the App actually resolves are pinned by
// app/test/cli_display_test.dart, which runs the real thing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CAP = require('../src/cli/cli-capability.js');
const CATALOG = require('../public/provider-catalog.js');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** `kCliFamilies` literal from the Dart source: family id → {name, colourSymbol,
 *  mark, providerless, lanes: {kind: [lane]}}. Read line by line — the nesting is
 *  real Dart, and a line-oriented read is steadier than one regex over it. */
function dartFamilies() {
  const families = {};
  let current = null;
  let kind = null;
  for (const raw of read('app/lib/utils/cli_display.dart').split('\n')) {
    const line = raw.trim();
    const family = line.match(/^'([^']+)':\s*CliFamily\('((?:[^'\\]|\\.)*)'\s*,\s*(AppColors\.[A-Za-z0-9_]+)\s*(.*)$/);
    if (family) {
      current = family[1];
      kind = null;
      const flags = dartFlags(family[4]);
      families[current] = {
        name: family[2],
        colourSymbol: family[3],
        mark: typeof flags.mark === 'string' ? flags.mark : null,
        providerless: flags.providerless === true,
        declared: /\blanes:/.test(family[4]),
        lanes: { chat: [], terminal: [] },
      };
      continue;
    }
    if (!current) continue;
    const scenario = line.match(/^'([^']+)':\s*<CliLane>\[/);
    if (scenario) { kind = scenario[1]; continue; }
    const lane = line.match(/^CliLane\('((?:[^'\\]|\\.)*)'\s*(.*)$/);
    if (lane && kind) {
      const flags = dartFlags(lane[2]);
      families[current].lanes[kind].push({
        id: lane[1],
        label: typeof flags.label === 'string' ? flags.label : null,
        mark: typeof flags.mark === 'string' ? flags.mark : null,
        engine: typeof flags.engine === 'string' ? flags.engine : null,
        offered: flags.offered !== false,
        deprecated: flags.deprecated === true,
        replacedBy: typeof flags.replacedBy === 'string' ? flags.replacedBy : null,
      });
    }
  }
  assert.ok(Object.keys(families).length >= 10, 'kCliFamilies literal not found in app/lib/utils/cli_display.dart');
  // A family that lists no lanes is its own single lane in both kinds — the rule
  // the Dart `_laneEntries` and the server's `laneEntries` both implement.
  for (const [id, family] of Object.entries(families)) {
    if (family.declared) continue;
    family.lanes = { chat: [{ id, offered: true }], terminal: [{ id, offered: true }] };
  }
  return families;
}

/** `name: value` flag pairs out of a Dart constructor's tail. */
function dartFlags(text) {
  const flags = {};
  for (const pair of text.matchAll(/([A-Za-z]+)\s*:\s*(true|false|'[^']*')/g)) {
    const [, key, raw] = pair;
    if (raw === 'true') flags[key] = true;
    else if (raw === 'false') flags[key] = false;
    else flags[key] = raw.slice(1, -1);
  }
  return flags;
}

/** The flat lane row the Dart `_flattenFamilies` builds, from the structure
 *  parsed above — the same rule the server and the page implement, so agreement
 *  here means all three turn the same structure into the same rows. */
function dartFlatten(families) {
  const out = {};
  for (const [familyId, family] of Object.entries(families)) {
    const order = [];
    const seen = new Map();
    const rowOf = id => {
      if (!seen.has(id)) { seen.set(id, { labels: [], marks: [], engines: new Map(), kinds: [], dying: null }); order.push(id); }
      return seen.get(id);
    };
    for (const kind of CAP.KINDS) {
      for (const lane of family.lanes[kind] || []) {
        const id = String(lane.id).trim().toLowerCase();
        const row = rowOf(id);
        if (lane.label && !row.labels.includes(lane.label)) row.labels.push(lane.label);
        if (lane.mark && !row.marks.includes(lane.mark)) row.marks.push(lane.mark);
        if (lane.engine) row.engines.set(kind, lane.engine);
        if (lane.offered !== false && !row.kinds.includes(kind)) row.kinds.push(kind);
        if (lane.deprecated && !row.dying) row.dying = lane;
      }
    }
    for (const id of order) {
      const row = seen.get(id);
      const engineKind = row.kinds.find(k => row.engines.has(k)) || [...row.engines.keys()][0];
      out[id] = {
        displayName: row.labels[0] || family.name,
        colourSymbol: family.colourSymbol,
        shortMark: row.marks[0] || family.mark || family.name.slice(0, 1).toUpperCase(),
        providerless: family.providerless,
        deprecated: row.dying !== null,
        replacedBy: row.dying ? (row.dying.replacedBy || null) : null,
        engine: engineKind ? row.engines.get(engineKind) : null,
        kinds: row.kinds.length === CAP.KINDS.length ? [...CAP.KINDS] : [...row.kinds],
        family: familyId,
      };
    }
  }
  return out;
}

/** One Dart lane row with the defaults applied — the shape `lanesOf()` answers,
 *  so the three platforms can be compared row for row. */
function dartView(familyId, kind, lane) {
  const family = DART_FAMILIES[familyId];
  const id = String(lane.id).trim().toLowerCase();
  return {
    lane: id,
    kind,
    label: lane.label || family.name,
    engine: lane.engine || id,
    mark: lane.mark || family.mark || family.name.slice(0, 1).toUpperCase(),
    colour: null, // the app's hexes are its own light-theme values; only the symbol is checked
    providerless: family.providerless,
    offered: lane.offered !== false,
    deprecated: lane.deprecated === true,
    replacedBy: lane.deprecated === true ? (lane.replacedBy || null) : null,
  };
}

const DART_FAMILIES = dartFamilies();
const DART = dartFlatten(DART_FAMILIES);
const WEB = CATALOG.CLI_DISPLAY;
const SERVER = CAP.DISPLAY;

const ids = Object.keys(SERVER).sort();
const families = Object.keys(CAP.CLIS);

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
  // it — a picker that only gets {label, color} cannot say "计划淘汰" nor draw the
  // second line.
  assert.equal(CATALOG.cliMeta('codex').deprecated, true);
  assert.equal(CATALOG.cliMeta('codex').replacedBy, 'codex-exp');
  assert.equal(CATALOG.cliMeta('codex-exp').deprecated, undefined);
  assert.equal(CATALOG.cliMetaMap().codex.deprecated, true);
  assert.equal(CATALOG.cliMeta('claude-exp').engine, 'Claude Agent SDK');
  assert.equal(CATALOG.cliMeta('codex-exp').engine, 'Codex App Server');
  // 没有引擎名的车道，meta 里的小字就是 id（= 终端要跑的命令）。
  assert.equal(CATALOG.cliMeta('zcode').engine, 'zcode');
  assert.equal(CATALOG.cliMeta('mystery-cli').engine, 'mystery-cli');
  // 选择器拿到的就是 meta，所以「哪种会话给这条车道」也得跟着它走 —— 一个只拿到
  // {label, color} 的选择器只能自己再判断一遍，那正是这次要收掉的东西。
  assert.deepEqual([...CATALOG.cliMeta('claude').kinds], ['terminal']);
  assert.deepEqual([...CATALOG.cliMeta('claude-exp').kinds], ['chat']);
  assert.deepEqual([...CATALOG.cliMeta('opencode').kinds], ['chat', 'terminal']);
  assert.deepEqual([...CATALOG.cliMeta('mystery-cli').kinds], ['chat', 'terminal']);
});

test('the engine line and the picker kinds are one fact on all three platforms', () => {
  // 2026-09-26：两条常驻车道扶正 —— 大字是产品名（Claude / Codex），小字是它们底下
  // 的引擎（Claude Agent SDK / Codex App Server）；两条一次性车道退出 chat、留在终端。
  // 这两列和大字一样是「一条车道的事实」，各端一份，必须逐字相同。
  for (const id of ids) {
    const engine = SERVER[id].engine || null;
    assert.equal(WEB[id].engine || null, engine, `${id}: web engine`);
    assert.equal(DART[id].engine, engine, `${id}: app engine`);
    assert.equal(CAP.engineOf(id), engine || id, `${id}: server engineOf()`);
    assert.equal(CATALOG.cliEngine(id), engine || id, `${id}: web cliEngine()`);
    assert.equal(DART[id].kinds.join(','), CAP.kindsOf(id).join(','), `${id}: app kinds`);
    assert.equal((WEB[id].kinds || CATALOG.CLI_DEFAULT_KINDS).join(','), CAP.kindsOf(id).join(','), `${id}: web kinds`);
    for (const kind of ['chat', 'terminal']) {
      const offers = CAP.kindsOf(id).includes(kind);
      assert.equal(CAP.offersIn(id, kind), offers, `${id}: server offersIn(${kind})`);
      assert.equal(CATALOG.cliOffersIn(id, kind), offers, `${id}: web cliOffersIn(${kind})`);
      assert.equal(DART[id].kinds.includes(kind), offers, `${id}: app kinds / ${kind}`);
    }
  }
  // 小字写引擎名时，大字必须就是那条车道的产品名 —— 两行是同一个产品的上下两半。
  assert.equal(CAP.displayNameOf('claude-exp'), 'Claude');
  assert.equal(CAP.engineOf('claude-exp'), 'Claude Agent SDK');
  assert.equal(CATALOG.cliEngine('claude-exp'), 'Claude Agent SDK');
  assert.equal(CAP.displayNameOf('codex-exp'), 'Codex');
  assert.equal(CAP.engineOf('codex-exp'), 'Codex App Server');
  assert.equal(CATALOG.cliEngine('codex-exp'), 'Codex App Server');
  // 其余车道没有引擎名，小字就是自己的 id —— 终端里那行小字指的就是要跑的命令。
  assert.equal(CAP.engineOf('claude'), 'claude');
  assert.equal(CAP.engineOf('codex'), 'codex');
  assert.equal(CAP.engineOf('zcode'), 'zcode');
  assert.equal(CAP.engineOf('mystery-cli'), 'mystery-cli');
  assert.equal(CATALOG.cliEngine(''), '');
  // The rule itself: `claude` is `claude -p`, `codex` is `codex exec`. Neither has
  // a place in a chat picker; both are exactly what a terminal runs.
  assert.deepEqual(CAP.kindsOf('claude'), ['terminal']);
  assert.deepEqual(CAP.kindsOf('codex'), ['terminal']);
  assert.deepEqual(CAP.kindsOf('claude-exp'), ['chat']);
  assert.deepEqual(CAP.kindsOf('codex-exp'), ['chat']);
  // A CLI this table has never heard of answers both — it must not vanish from a
  // picker just because nobody added a row for it.
  assert.equal(CAP.offersIn('mystery-cli', 'chat'), true);
  assert.equal(CAP.offersIn('mystery-cli', 'terminal'), true);
  assert.equal(CATALOG.cliOffersIn('mystery-cli', 'chat'), true);
  assert.deepEqual(CATALOG.cliOffersIn('', 'chat'), true);
  // 没写 kinds 的车道两端都答「两种都给」—— 这条默认值也必须一致，否则同一条
  // 车道会在 Web 上出现、在 App 上消失。
  assert.deepEqual([...CAP.DEFAULT_KINDS], [...CATALOG.CLI_DEFAULT_KINDS], 'the "offered everywhere" default must match across platforms');
  assert.deepEqual([...CAP.DEFAULT_KINDS], ['chat', 'terminal']);
  // ...and the casing a record or a wire payload carries must not decide it.
  assert.equal(CAP.offersIn(' CLAUDE ', ' Terminal '), true);
  assert.equal(CATALOG.cliOffersIn(' Codex ', 'CHAT'), false);
});

test('the promoted lane carries the product name, and the fallback says what it is', () => {
  // The rename, stated once: this is what every picker ends up showing.
  assert.equal(CAP.displayNameOf('claude-exp'), 'Claude');
  assert.equal(CAP.displayNameOf('claude'), 'Claude Code');
  assert.equal(CATALOG.cliDisplayName('claude-exp'), 'Claude');
  assert.equal(CATALOG.cliMetaMap()['claude'].label, 'Claude Code');
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
  // 两条扶正车道的名字不能与它们的一次性前身撞：chat 里点「Claude」，终端里跑
  // `claude` —— 两行选项要是同名，用户就分不出自己选的是哪一条。
  for (const [promoted, oneShot] of [['claude-exp', 'claude'], ['codex-exp', 'codex']]) {
    assert.notEqual(SERVER[promoted].displayName, SERVER[oneShot].displayName, `${promoted} must not share a name with ${oneShot}`);
    assert.notEqual(SERVER[promoted].shortMark, SERVER[oneShot].shortMark, `${promoted} must not share a mark with ${oneShot}`);
  }
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

// ── 2b. The catalogue is ONE structure, on all three platforms ──────────────
//
// 一个 CLI 是家族，家族在每个场景里给出衍生车道。上面那组测试比的是摊平后的
// 车道行；这组比的是**结构本身** —— 谁属于哪个家族、每个场景给哪些衍生、每个
// 衍生在那个场景里叫什么。摊平是这三份结构各自的投影，所以结构一致才意味着
// 用户看到的一致。

test('server / web / app carry the same CLI family set', () => {
  assert.deepEqual(Object.keys(CATALOG.CLI_FAMILIES), families, 'web CLI_FAMILIES keys differ from server CLIS');
  assert.deepEqual(Object.keys(DART_FAMILIES), families, 'app kCliFamilies keys differ from server CLIS');
  assert.ok(families.length >= 10, 'the catalogue lost its CLIs');
  assert.deepEqual([...CAP.KINDS], [...CATALOG.CLI_KINDS], 'the two kinds must be the same two kinds everywhere');
});

test('a family says its name, brand, mark and account once, on all three platforms', () => {
  for (const familyId of families) {
    const server = CAP.CLIS[familyId];
    const web = CATALOG.CLI_FAMILIES[familyId];
    const dart = DART_FAMILIES[familyId];
    assert.equal(web.name, server.name, `${familyId}: web family name`);
    assert.equal(dart.name, server.name, `${familyId}: app family name`);
    assert.equal(web.colour, server.colour, `${familyId}: web family colour`);
    assert.equal(web.mark, server.mark, `${familyId}: web family mark`);
    assert.equal(dart.mark || null, server.mark || null, `${familyId}: app family mark`);
    assert.equal(web.providerless === true, server.providerless === true, `${familyId}: web providerless`);
    assert.equal(dart.providerless, server.providerless === true, `${familyId}: app providerless`);
    // 一个家族的名字就是**对外**那个名字：车道行的 displayName 可以另起（终端那行
    // 写 Claude Code），家族名不会。
    assert.equal(CAP.familyNameOf(familyId), server.name, `${familyId}: familyNameOf`);
    assert.equal(CATALOG.cliFamilyName(familyId), server.name, `${familyId}: web cliFamilyName`);
    assert.ok(familyId === familyId.trim().toLowerCase(), `${familyId}: family ids are stored lowercase`);
  }
});

test('每个场景给的衍生、顺序和叫法，三端逐行相同', () => {
  const shape = row => [row.lane, row.label, row.engine, row.mark, row.offered, row.deprecated, row.replacedBy].join(' | ');
  for (const familyId of families) {
    for (const kind of CAP.KINDS) {
      const server = CAP.lanesOf(familyId, kind);
      const web = CATALOG.cliLanesOf(familyId, kind);
      const dart = (DART_FAMILIES[familyId].lanes[kind] || []).map(lane => dartView(familyId, kind, lane));
      assert.deepEqual(web.map(shape), server.map(shape), `${familyId}/${kind}: web lane rows`);
      assert.deepEqual(dart.map(shape), server.map(shape), `${familyId}/${kind}: app lane rows`);
      // 车道 id 是记录里存的那个，不分大小写地比对；家族里不该有两条同名衍生。
      const lanes = server.map(row => row.lane);
      assert.equal(new Set(lanes).size, lanes.length, `${familyId}/${kind}: two lanes share an id`);
    }
  }
  // 摊平出来的车道表就是这些结构投影的结果：一行不多、一行不少。
  const declared = new Set();
  for (const familyId of families) {
    for (const kind of CAP.KINDS) for (const row of CAP.lanesOf(familyId, kind)) declared.add(row.lane);
  }
  assert.deepEqual([...declared].sort(), ids, 'every lane in DISPLAY must be declared by a family, and every declared lane must have a row');
});

test('一条车道的家族归属三端一致，未知 id 不冒充任何家族', () => {
  for (const id of ids) {
    assert.ok(families.includes(CAP.familyOf(id)), `${id}: server familyOf must name a family`);
    assert.equal(CATALOG.cliFamilyOf(id), CAP.familyOf(id), `${id}: web familyOf`);
    assert.equal(DART[id].family, CAP.familyOf(id), `${id}: app flatten must keep the family`);
  }
  // 一个 CLI 的家族名是它的**产品**名，不是它在某个场景里的行名：终端那行叫
  // Claude Code，家族仍叫 Claude。
  assert.equal(CAP.familyOf('claude'), 'claude');
  assert.equal(CAP.familyOf('claude-exp'), 'claude');
  assert.equal(CAP.familyNameOf('claude'), 'Claude');
  assert.equal(CAP.familyNameOf('claude-exp'), 'Claude');
  assert.equal(CAP.displayNameOf('claude'), 'Claude Code', 'the lane row keeps its own name');
  assert.equal(CATALOG.cliFamilyName('claude-exp'), 'Claude');
  assert.equal(CATALOG.cliFamilyName('claude'), 'Claude');
  // 大小写与空格不该改变归属（记录里带着的就是这些拼法）。
  assert.equal(CAP.familyOf(' CLAUDE-EXP '), 'claude');
  assert.equal(CATALOG.cliFamilyOf(' Codex '), 'codex');
  // 没听说过的 id 没有家族 —— 回落成它自己的名字，不是邻居的。
  for (const junk of ['mystery-cli', 'claude-next', '']) {
    assert.equal(CAP.familyOf(junk), null, `server familyOf(${JSON.stringify(junk)})`);
    assert.equal(CATALOG.cliFamilyOf(junk), null, `web cliFamilyOf(${JSON.stringify(junk)})`);
    assert.equal(CAP.familyNameOf(junk), junk, `server familyNameOf(${JSON.stringify(junk)})`);
    assert.equal(CATALOG.cliFamilyName(junk), junk, `web cliFamilyName(${JSON.stringify(junk)})`);
  }
});

test('derivatives are a family fact, so a second surface cannot invent one', () => {
  // claude 与 codex 是仅有的两个**一 CLI 多衍生**的家族：chat 一条常驻 + 一条
  // 退出 chat 的一次性车道，terminal 一条原生命令。其余家族都是一条衍生、两种
  // 场景都给 —— 表里没写 lanes 就是那个意思。
  for (const familyId of families) {
    if (familyId === 'claude' || familyId === 'codex') continue;
    assert.equal(CAP.CLIS[familyId].lanes, undefined, `${familyId} declares lanes it does not need`);
    assert.equal(CATALOG.CLI_FAMILIES[familyId].lanes, undefined, `${familyId}: web mirror disagrees`);
    assert.deepEqual(CAP.lanesOf(familyId, 'chat').map(l => l.lane), [familyId], `${familyId}: chat lane`);
    assert.deepEqual(CAP.lanesOf(familyId, 'terminal').map(l => l.lane), [familyId], `${familyId}: terminal lane`);
    assert.deepEqual(CAP.lanesOf(familyId, 'chat').map(l => l.offered), [true], `${familyId}: offered in chat`);
  }
  // 两条扶正家族的 chat 各给两条衍生，其中一次性那条 offered:false —— 它仍然是
  // 一条真实的车道（记录里存着这个 id），只是选择器不再提供。
  assert.deepEqual(CAP.lanesOf('claude', 'chat').map(l => [l.lane, l.label, l.engine, l.offered]), [
    ['claude-exp', 'Claude', 'Claude Agent SDK', true],
    ['claude', 'Claude', 'claude -p', false],
  ]);
  assert.deepEqual(CAP.lanesOf('claude', 'terminal').map(l => [l.lane, l.label, l.engine, l.offered]), [
    ['claude', 'Claude Code', 'claude', true],
  ]);
  assert.deepEqual(CAP.lanesOf('codex', 'chat').map(l => [l.lane, l.label, l.engine, l.offered]), [
    ['codex-exp', 'Codex', 'Codex App Server', true],
    ['codex', 'Codex', 'codex exec', false],
  ]);
  // 同一个家族在两种场景里的名字可以不同（终端是原生命令），但**对外**只有一个。
  assert.equal(CAP.familyNameOf('claude'), 'Claude');
  assert.equal(CAP.lanesOf('claude', 'terminal')[0].label, 'Claude Code');
  assert.equal(CATALOG.cliLanesOf('claude', 'terminal')[0].engine, 'claude');
  // 两种场景都能给的家族，两个场景里都列得出来。
  for (const familyId of families) {
    const offered = CAP.KINDS.filter(kind => CAP.lanesOf(familyId, kind).some(l => l.offered));
    assert.deepEqual(offered, CAP.KINDS.filter(kind => CAP.familiesFor(kind).includes(familyId)), `${familyId}: familiesFor disagrees with its own lanes`);
    assert.deepEqual(CATALOG.cliFamiliesFor('chat').includes(familyId), CAP.familiesFor('chat').includes(familyId), `${familyId}: web familiesFor(chat)`);
  }
  // 未知的家族名与未知的场景名都答空，不是抛错。
  assert.deepEqual(CAP.lanesOf('mystery-cli', 'chat'), []);
  assert.deepEqual(CAP.lanesOf('claude', 'nowhere'), []);
  assert.deepEqual(CATALOG.cliLanesOf('mystery-cli', 'chat'), []);
  assert.deepEqual(DART_FAMILIES.claude.lanes.nowhere || [], []);
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
  // such entries in one file is a table; one or two is a coincidence.
  const nameAlt = ids.map(id => SERVER[id].displayName).join('|');
  const idAlt = ids.map(id => id.replace(/-/g, '\\-')).join('|');
  const entry = new RegExp(`['"]?(?:${idAlt})['"]?\\s*:\\s*(?:\\{[^}\\n]*\\b(?:displayName|label|name)\\s*:\\s*)?['"](?:${nameAlt})['"](?=\\s*[,}])`, 'g');
  const allow = new Set(['public/provider-catalog.js', 'src/cli/cli-capability.js', 'public/i18n-catalog.js']);
  // quota's VENDOR_LABEL is a different axis that happens to key on the same
  // words: it names the *provider behind a quota bar*, so it also has non-CLI
  // keys (ark / zhipu), and it spells `opencode: 'OpenCode Go'` — the OpenCode
  // subscription, not the CLI. It is exempt only as long as that stays true: if
  // someone trims it down to a pure CLI id → name map, the assertion below takes
  // the exemption away again.
  const exempt = new Map([['src/quota/quota-bar-view.js', /ark\s*:\s*['"]/]]);
  const offenders = [];
  for (const dir of ['public', 'src']) {
    for (const rel of walk(dir)) {
      if (allow.has(rel) || /\.min\.js$/.test(rel)) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const reason = exempt.get(rel);
      if (reason && reason.test(src)) continue;
      if (reason && !reason.test(src)) offenders.push(`${rel} (exemption no longer justified)`);
      const hits = [...src.matchAll(entry)];
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
