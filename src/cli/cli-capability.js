'use strict';

// The independent facts about a CLI, in one table.
//
//   protocol  — how the child frames its conversation with the host.
//   lifecycle — whether that child outlives the turn it was started for.
//   cancel    — how stopping a turn stops the lane:
//                 process — the turn IS the child; cancelling reaps it
//                 turn    — the turn is interrupted in place, the child survives
//
// DISPLAY, further down, is the same idea for the CLI's *name*: how it is
// called, marked and coloured on screen, whether it owns its provider, and
// whether the lane is on its way out. See the comment above it — that table is
// the one the web and the app mirror.
//
// These used to be one fact derived from an inline pair of claude CLI names
// (`Array.includes` over a two-element name list) repeated at ten call sites.
// That made "streams" and "is resident" look like the same question, so a CLI
// whose protocol is long-lived but whose lane had not caught up — codex-exp
// speaks the app-server protocol but was still spawned per turn — had nowhere to
// be described, and moving a CLI between lanes meant editing ten places without
// missing one.
//
// Only entries that differ from the default are listed, so an unknown or newly
// added CLI behaves exactly like the non-claude CLIs always have.

const DEFAULT_CAPABILITY = Object.freeze({ protocol: 'cli-once', lifecycle: 'per-turn', cancel: 'process' });

const CAPABILITIES = Object.freeze({
  claude: Object.freeze({ protocol: 'claude-stream', lifecycle: 'resident', cancel: 'process' }),
  // The SDK lane interrupts the in-flight turn and keeps its child, so a session
  // is stopped as soon as no turn runs — not when the process disappears.
  'claude-exp': Object.freeze({ protocol: 'claude-stream-sdk', lifecycle: 'resident', cancel: 'turn' }),
  codex: Object.freeze({ protocol: 'codex-exec-json', lifecycle: 'per-turn', cancel: 'process' }),
  // `codex app-server --listen stdio://` is a long-lived server and the bridge
  // holds it across turns (`--resident`), so this is the resident lane like
  // claude. The thread survives a reap, so cancel/recycle re-attach rather than
  // losing the conversation.
  'codex-exp': Object.freeze({ protocol: 'codex-app-server', lifecycle: 'resident', cancel: 'process' }),
  // `zcode.cjs app-server` holds its native session across turns and keeps
  // run_in_background work alive after a turn ends (it wakes itself when that
  // work completes), so the bridge keeps it resident (`--resident`) and holds
  // the host turn open while background work runs. Cancel stops the child; the
  // session resumes by id on the next spawn.
  zcode: Object.freeze({ protocol: 'zcode-app-server', lifecycle: 'resident', cancel: 'process' }),
  // ACP is a per-turn local agent protocol: the bridge spawns the agent for the
  // turn and exits with it, so cancelling reaps the child. opencode was the
  // first CLI on this lane; gemini and grok ride the same bridge (acp.js).
  opencode: Object.freeze({ protocol: 'acp', lifecycle: 'per-turn', cancel: 'process' }),
  gemini: Object.freeze({ protocol: 'acp', lifecycle: 'per-turn', cancel: 'process' }),
  grok: Object.freeze({ protocol: 'acp', lifecycle: 'per-turn', cancel: 'process' }),
});

// Which upstream API dialect a CLI's protocol talks. This is deliberately NOT
// the transport name in CAPABILITIES: `acp` is the local agent protocol, and an
// ACP agent's upstream dialect is its own business (the agent holds the
// credential), so protocolFamilyOf answers null for it rather than guessing.
const FAMILIES = Object.freeze({
  claude: 'anthropic',
  'claude-exp': 'anthropic',
  codex: 'openai',
  'codex-exp': 'openai',
  opencode: 'acp',
  gemini: 'acp',
  grok: 'acp',
});

// ── Display facts: the CLI catalogue ───────────────────────────────────────
//
// A CLI is a **family** first and a **lane** second.
//
// `claude` is ONE CLI. In chat it is the resident Agent SDK lane; in a terminal
// it is the `claude` command itself. Those are two lanes of one family — two
// ids, two presentations, one product. So the catalogue is keyed by family, and
// each family lists, per session kind ('chat' / 'terminal'), the lanes that kind
// offers. Family level holds what is said once about the product:
//
//   name        — the product name (the outward name: "Claude", "Codex").
//   colour      — the brand colour on the web (hex, dark theme).
//   shortMark   — the letter on a collapsed CLI chip (Air task cards).
//   providerless— the CLI owns its account/model config, so a multicc provider
//                 (and a subagent route) must not be bound to its sessions.
//   lanes       — { chat: [lane…], terminal: [lane…] }. A family that lists no
//                 lanes is its own single lane, offered in both kinds — which
//                 is every CLI here except claude and codex.
//
// and each lane holds what that *kind* says differently:
//
//   id          the lane id — what a session record, a provider pool and a wire
//               route persist. Lanes are never renamed, only re-presented.
//   label       the big line in this kind. Default: the family name, which is
//               why both of the chat lanes above are simply "Claude".
//   engine      the small line in this kind. Default: the id — and on a
//               terminal lane the id IS the command that will run.
//   mark        the collapsed-chip letter, where this kind needs another one.
//   offered     whether this kind's pickers offer the lane. Default: yes. This
//               is policy, not capability: `claude -p` *can* chat, the product
//               just does not offer it there any more.
//   bundled     the lane's engine does not come from the family's own CLI
//               artifact: it ships inside MultiCC. Only claude-exp today — the
//               Agent SDK is a library multicc requires, not a binary a user
//               installs. An update row can install the family's CLI; it can
//               never install this, so it says so instead of offering a button.
//   deprecated  the lane still works in this kind but is on its way out, and
//   replacedBy  names the lane to use instead. Only ever present together.
//
// `update` is the family's **own CLI artifact** — the one thing an install or
// upgrade row acts on:
//
//   package     the npm package its published version is read from. Absent when
//               the CLI has no comparable published source (qoder, zcode).
//   command     the official install/upgrade command. Absent on a CLI that has
//               no script (zcode ships inside a desktop app).
//   manual      what to tell the user instead, when there is no command.
//
// This is a family fact and not a lane one: both of codex's lanes run the same
// binary behind the same install script, and claude-exp has no artifact of its
// own at all. Hanging it off lanes is what made the update panel show `codex`
// and `codex-exp` as two rows running one command, and `claude-exp` as a row
// that could only answer "upgrade MultiCC instead".
//
// 2026-09-26：两条常驻车道扶正为产品名，两条一次性车道退出 chat，终端大字照实写
// 命令所属的产品。
//
//   家族    场景       车道        大字           小字
//   claude  chat      claude-exp  Claude         Claude Agent SDK   （bundled）
//           chat      claude      Claude         claude -p        （offered: false）
//           terminal  claude      Claude         claude
//   codex   chat      codex-exp   Codex          Codex App Server
//           chat      codex       Codex          codex exec       （offered: false）
//           terminal  codex       Codex          codex
//   opencode chat     opencode    OpenCode       opencode acp
//           terminal  opencode    OpenCode       opencode
//
// `claude` 是 `claude -p` 的一次性车道、`codex` 是 `codex exec`：chat 里已经没有
// 它们的位置（扶正后的常驻车道才是 chat 的线路），但终端真要把这两个可执行文件
// 跑起来，所以它们只退出 chat、留在终端。反过来 claude-exp / codex-exp 是进程内的
// SDK / app-server 车道，没有可执行文件能丢进终端。
//
// 终端那行大字照实写：它就是 `claude` / `codex` 这个命令，不再叫 "Claude Code" /
// "Codex Exec" —— 后者说的是 chat 里 `codex exec` 那条命令，本来就挂错了场景。
//
// ACP 家族的 chat 车道多写一截 ` acp`：同一个可执行文件在 chat 里是被 ACP 桥
// 驱动的（acp.js），在终端里就是它自己。
//
// id 一律不动：会话记录、Provider 池、路由、适配器 label 全记着旧 id。
//
// This is the ONE table for all of them. Each column used to be spelled out per
// surface and had drifted: web `CLI_META` (chat.js), `CLI_LABELS`/`CLI_MARKS`
// (air-task-settings.js), a third label list in air-cli-update.js (missing
// claude-exp/codex-exp), a four-entry one in air-provider.js, a ternary chain
// in chat-ai-config.js that printed "WorkBuddy" for any CLI it did not know, a
// label ternary in server.js (where the unknown case became "Claude Code"), and
// on Flutter a `switch` in dashboard_screen.dart whose `_ => 'Claude'` really
// did render codebuddy / dsh / gemini / grok as "Claude".
//
// The mirrors are public/provider-catalog.js (web) and
// app/lib/utils/cli_display.dart (app); tests/test-cli-display-parity.js reads
// all three and fails when an id, a name, a mark, a colour, the providerless
// flag or the deprecation plan drifts. Add a CLI here first, then mirror it —
// an id this table does not know falls back to its own raw id everywhere, never
// to a neighbour's name.
//
// "Claude Code", not "Claude": one spelling for the product, and it is the one
// the server already prints when it names a claude session.
const KINDS = Object.freeze(['chat', 'terminal']);

const CLIS = deepFreeze({
  claude: {
    name: 'Claude',
    colour: '#ff9a76',
    update: { package: '@anthropic-ai/claude-code', command: 'npm install -g @anthropic-ai/claude-code' },
    lanes: {
      // 常驻的 Agent SDK 车道就是 chat 里的 Claude（内部 id 仍是 claude-exp）。
      // 它的引擎由 MultiCC 内置，没有可安装的制品 —— 所以是 bundled，不是一条
      // 能升级的车道。
      chat: [
        { id: 'claude-exp', mark: 'A', engine: 'Claude Agent SDK', bundled: true },
        { id: 'claude', engine: 'claude -p', offered: false },
      ],
      // 终端跑的就是 `claude` 这个可执行文件，大字与家族同名。
      terminal: [{ id: 'claude', mark: 'C', engine: 'claude' }],
    },
  },
  codex: {
    name: 'Codex',
    colour: '#20a66a',
    // codex 走官方安装脚本, 不走 npm 全局 —— 这是修一次真实事故换来的选择。
    // `@openai/codex` 的平台二进制(约 133MB)是 optionalDependency: 下载超时会被 npm
    // 静默丢弃, 整条命令仍然 exit 0。留下的是一个能启动失败、却对外报"安装成功"的残废
    // 安装, job 只看退出码, 无从分辨。实测同一个包同一台机器, 一次 27 秒装好, 另一次
    // 卡满 5 分钟默认 fetch-timeout 后被丢 —— 是下载通道本身不稳, 加长超时只是压制。
    // 官方脚本没有这条静默路径: 单一归档、sha256 对 codex-package_SHA256SUMS、set -eu
    // 非零退出、版本化目录 + current 软链原子切换。
    update: { package: '@openai/codex', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
    lanes: {
      chat: [
        { id: 'codex-exp', mark: 'X', engine: 'Codex App Server' },
        // 标成计划淘汰记录的是「chat 那半条路已经交给 codex-exp」；终端上它仍是
        // 本来的 codex 命令，所以这个标记只写在 chat 这条目上。
        { id: 'codex', engine: 'codex exec', offered: false, deprecated: true, replacedBy: 'codex-exp' },
      ],
      terminal: [{ id: 'codex', mark: 'E', engine: 'codex' }],
    },
  },
  // ACP：同一个可执行文件，chat 里由 acp.js 桥驱动（小字写出这层），终端里就是它自己。
  opencode: {
    name: 'OpenCode',
    colour: '#388bfd',
    mark: 'O',
    update: { package: 'opencode-ai', command: 'npm install -g opencode-ai' },
    lanes: { chat: [{ id: 'opencode', engine: 'opencode acp' }], terminal: [{ id: 'opencode' }] },
  },
  zcode: {
    name: 'ZCode',
    colour: '#a371f7',
    mark: 'Z',
    // 协议是 zcode-app-server（常驻），但它没有官方 CLI 安装脚本：CLI 在桌面版里。
    update: { manual: 'ZCode 暂无官方 CLI 安装脚本, 请从官网 https://zcode.z.ai 下载安装 ZCode 桌面版(其内置 CLI)' },
  },
  qoder: {
    name: 'Qoder CN',
    colour: '#ff8a3d',
    mark: 'Q',
    providerless: true,
    // curl 脚本安装，没有可比对的 npm 发布源。
    update: { command: 'curl -fsSL https://qoder.cn/install | bash' },
  },
  kimi: { name: 'Kimi Code', colour: '#13c2c2', mark: 'K', update: { package: '@moonshot-ai/kimi-code', command: 'npm install -g @moonshot-ai/kimi-code' } },
  codebuddy: {
    name: 'WorkBuddy',
    colour: '#0052d9',
    mark: 'W',
    providerless: true,
    update: { package: '@tencent-ai/codebuddy-code', command: 'npm install -g @tencent-ai/codebuddy-code' },
  },
  dsh: {
    name: 'DSH',
    colour: '#4d6bfe',
    mark: 'D',
    providerless: true,
    update: { package: '@deepseek-ai/dsh', command: 'npm install -g @deepseek-ai/dsh' },
  },
  gemini: {
    name: 'Gemini',
    colour: '#4285f4',
    mark: 'G',
    providerless: true,
    update: { package: '@google/gemini-cli', command: 'npm install -g @google/gemini-cli' },
    lanes: { chat: [{ id: 'gemini', engine: 'gemini acp' }], terminal: [{ id: 'gemini' }] },
  },
  grok: {
    name: 'Grok',
    colour: '#8c8f96',
    mark: 'R',
    providerless: true,
    update: { package: '@xai-official/grok', command: 'npm install -g @xai-official/grok' },
    lanes: { chat: [{ id: 'grok', engine: 'grok acp' }], terminal: [{ id: 'grok' }] },
  },
});

// Neutral grey, matching the muted text both clients already draw with. Only
// for a CLI the table has never heard of — its own name is still what is shown.
const DEFAULT_COLOUR = '#8b949e';

// A lane with no `kinds` is offered everywhere. Frozen so a picker that filters
// by kind cannot accidentally mutate the shared default.
const DEFAULT_KINDS = Object.freeze(['chat', 'terminal']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function firstLetter(name) {
  const text = String(name == null ? '' : name).trim();
  return text ? text.slice(0, 1).toUpperCase() : '?';
}

// The lane entries a kind may offer. A family with no `lanes` at all is its own
// single lane in both kinds; a family that lists `lanes` and then says nothing
// about a kind does not appear in that kind.
function laneEntries(familyId, family, kind) {
  if (!family.lanes) return [{ id: familyId }];
  return family.lanes[kind] || [];
}

// One lane, as *this kind* presents it. Everything a surface needs to draw a row
// is here, so no caller has to fall back on a neighbour's name or a raw id.
function presentationOf(familyId, family, kind, entry) {
  const lane = nameOf(entry.id) || familyId;
  return {
    lane,
    kind,
    label: entry.label || family.name,
    engine: entry.engine || lane,
    mark: entry.mark || family.mark || firstLetter(family.name),
    colour: family.colour || DEFAULT_COLOUR,
    providerless: family.providerless === true,
    offered: entry.offered !== false,
    bundled: entry.bundled === true,
    deprecated: entry.deprecated === true,
    replacedBy: entry.deprecated === true ? (entry.replacedBy || null) : null,
  };
}

// The lanes a family offers in one kind, in picker order.
function lanesOf(familyOrLane, kind) {
  const familyId = familyOf(familyOrLane);
  const wanted = nameOf(kind);
  if (!familyId || !KINDS.includes(wanted)) return [];
  const family = CLIS[familyId];
  return laneEntries(familyId, family, wanted).map(entry => presentationOf(familyId, family, wanted, entry));
}

// Which families have anything to offer in a kind.
function familiesFor(kind) {
  const wanted = nameOf(kind);
  if (!KINDS.includes(wanted)) return [];
  return Object.keys(CLIS).filter(id => lanesOf(id, wanted).some(lane => lane.offered));
}

// The flat view: one row per lane, which is what every existing caller reads.
// Derived from CLIS, never a second copy — change the catalogue and this
// follows. A lane's own row answers the questions that are about the *id*
// (its name, its mark, the permission to bind a provider, whether it is on the
// way out); the per-kind answers live in lanesOf().
function buildDisplay(catalogue) {
  const display = {};
  const laneFamily = Object.create(null);
  for (const familyId of Object.keys(catalogue)) {
    const family = catalogue[familyId];
    const lanes = new Map();
    for (const kind of KINDS) {
      for (const entry of laneEntries(familyId, family, kind)) {
        const id = nameOf(entry.id) || familyId;
        const owner = laneFamily[id];
        if (owner && owner !== familyId) {
          throw new Error(`CLI lane ${id} is listed under both ${owner} and ${familyId}`);
        }
        laneFamily[id] = familyId;
        const lane = lanes.get(id)
          || { labels: new Set(), marks: new Set(), engines: new Map(), kinds: [], deprecatedBy: null };
        if (entry.label) lane.labels.add(entry.label);
        if (entry.mark) lane.marks.add(entry.mark);
        if (entry.engine) lane.engines.set(kind, entry.engine);
        if (entry.offered !== false && !lane.kinds.includes(kind)) lane.kinds.push(kind);
        if (entry.deprecated === true && !lane.deprecatedBy) lane.deprecatedBy = entry;
        lanes.set(id, lane);
      }
    }
    for (const [id, lane] of lanes) {
      const label = single(lane.labels, `label of ${id}`);
      const mark = single(lane.marks, `shortMark of ${id}`) || family.mark || firstLetter(family.name);
      // The small line belongs to the kind that offers the lane; a lane offered
      // in both kinds (every single-lane family) takes the first it declares.
      const engineKind = lane.kinds.find(kind => lane.engines.has(kind)) || [...lane.engines.keys()][0];
      const row = {
        displayName: label || family.name,
        shortMark: mark,
        colour: family.colour || DEFAULT_COLOUR,
        providerless: family.providerless === true,
        deprecated: lane.deprecatedBy !== null,
      };
      if (lane.deprecatedBy && lane.deprecatedBy.replacedBy) row.replacedBy = lane.deprecatedBy.replacedBy;
      if (engineKind) row.engine = lane.engines.get(engineKind);
      if (lane.kinds.length !== KINDS.length) row.kinds = Object.freeze([...lane.kinds]);
      display[id] = Object.freeze(row);
    }
  }
  return { display: Object.freeze(display), laneFamily: Object.freeze(laneFamily) };
}

// Two entries naming the same lane differently in the same column is a mistake
// in the catalogue, not a preference: one of them would silently win.
function single(values, what) {
  if (values.size === 0) return null;
  if (values.size > 1) throw new Error(`the catalogue declares two different values for the ${what}: ${[...values].join(' / ')}`);
  return [...values][0];
}

const DISPLAY_VIEW = buildDisplay(CLIS);
const DISPLAY = DISPLAY_VIEW.display;
const LANE_FAMILY = DISPLAY_VIEW.laneFamily;

function nameOf(cli) {
  return String(cli == null ? '' : cli).trim().toLowerCase();
}

function capabilityOf(cli) {
  return CAPABILITIES[nameOf(cli)] || DEFAULT_CAPABILITY;
}

function displayOf(cli) {
  return DISPLAY[nameOf(cli)] || null;
}

// Which CLI family a lane belongs to — by family id, or by any of its lane ids.
// Unknown answers null, so each caller keeps its own fallback.
function familyOf(cli) {
  const key = nameOf(cli);
  if (!key) return null;
  if (CLIS[key]) return key;
  return LANE_FAMILY[key] || null;
}

// The outward name of the CLI: "Claude" for claude, claude-exp and any future
// lane of that family alike. This is what a surface names when the lane itself
// is not the point (a task card, a route slot); when two lanes of one family are
// on screen at once, that is the moment to say the lane's own name too.
function familyNameOf(cli) {
  const family = familyOf(cli);
  if (family) return CLIS[family].name;
  return String(cli == null ? '' : cli).trim();
}

// An unknown id keeps its own spelling. The fallbacks this replaced answered
// 'Claude' (Flutter) or 'WorkBuddy' (web AI-config), which is how a new CLI
// came to be displayed as a completely different product.
function displayNameOf(cli) {
  const entry = displayOf(cli);
  if (entry) return entry.displayName;
  return String(cli == null ? '' : cli).trim();
}

function shortMarkOf(cli) {
  const entry = displayOf(cli);
  if (entry) return entry.shortMark;
  return displayNameOf(cli).slice(0, 1).toUpperCase();
}

function colourOf(cli) {
  const entry = displayOf(cli);
  return entry ? entry.colour : DEFAULT_COLOUR;
}

// Vendor-auth CLIs (Qoder CN / WorkBuddy / DSH / Gemini / Grok) sign in with
// their own account, so no multicc provider is bound to their sessions. This
// predicate is what PROVIDERLESS_CLIS was a fourth copy of.
function isProviderless(cli) {
  const entry = displayOf(cli);
  return entry ? entry.providerless : false;
}

function providerlessClis() {
  return new Set(Object.keys(DISPLAY).filter(id => DISPLAY[id].providerless));
}

// A lane kept only as a fallback, on its way out. The id never moves (sessions,
// provider pools and wire routes persist it), so this flag — not a rename — is
// how the pickers learn to say "计划淘汰" and which lane to use instead.
//
// Returns null for a live lane and for an unknown id alike: a caller must not
// have to tell "no plan" from "never heard of it" to render a warning.
function deprecationOf(cli) {
  const entry = displayOf(cli);
  if (!entry || entry.deprecated !== true) return null;
  return { replacedBy: entry.replacedBy || null };
}

function isDeprecated(cli) {
  return deprecationOf(cli) !== null;
}

// The second, smaller line of a two-line CLI row. Only the promoted resident
// lanes name an engine; everything else answers its own id, which is the command
// the lane actually runs (and is what those rows have always shown).
function engineOf(cli) {
  const entry = displayOf(cli);
  if (entry && entry.engine) return entry.engine;
  return String(cli == null ? '' : cli).trim();
}

// Which session kinds may offer this lane. Unknown ids answer both: a CLI this
// table has never heard of must not silently vanish from a picker.
function kindsOf(cli) {
  const entry = displayOf(cli);
  return entry && entry.kinds ? entry.kinds : DEFAULT_KINDS;
}

function offersIn(cli, kind) {
  return kindsOf(cli).includes(String(kind == null ? '' : kind).trim().toLowerCase());
}

function knownClis() {
  return Object.keys(DISPLAY);
}

// ── The update unit: a family's own CLI artifact ───────────────────────────
//
// An install or upgrade row acts on one artifact. That artifact belongs to the
// FAMILY, never to a lane: `codex` and `codex-exp` are two lanes running one
// binary behind one install script, and `claude-exp` runs an engine that ships
// inside MultiCC and has no artifact at all. Keying this by lane is what made
// the panel show codex twice and offer to install the Agent SDK.
//
// The shape is the one switch-runtime and both clients already speak:
// { auto, command, display, package } — or { auto: false, manual } when the CLI
// has no install script (zcode ships inside a desktop app).
function updateOf(cli) {
  const family = familyOf(cli);
  if (!family) return null;
  const spec = CLIS[family].update;
  if (!spec) return null;
  const command = typeof spec.command === 'string' && spec.command ? spec.command : null;
  return Object.freeze({
    auto: command !== null,
    command,
    display: command,
    manual: command ? null : (spec.manual || null),
    package: spec.package || null,
  });
}

// Every artifact an update row may act on, keyed by family — the roster the
// update panel enumerates and the install/upgrade routes accept.
function updateSpecs() {
  const specs = {};
  for (const familyId of Object.keys(CLIS)) {
    const spec = updateOf(familyId);
    if (spec) specs[familyId] = spec;
  }
  return Object.freeze(specs);
}

// family id → the npm package its published version is read from. Only families
// with a comparable published source appear; a curl-script or desktop-only CLI
// is absent rather than mapped to a package it does not install from.
function npmPackages() {
  const packages = {};
  for (const familyId of Object.keys(CLIS)) {
    const spec = CLIS[familyId].update;
    if (spec && spec.package) packages[familyId] = spec.package;
  }
  return Object.freeze(packages);
}

// A lane whose engine ships inside MultiCC instead of coming from the family's
// CLI artifact. Nothing can be installed for it, so a row that would otherwise
// offer a button says this instead.
function isBundled(cli) {
  const key = nameOf(cli);
  for (const familyId of Object.keys(CLIS)) {
    for (const kind of KINDS) {
      for (const entry of laneEntries(familyId, CLIS[familyId], kind)) {
        if (nameOf(entry.id) === key) return entry.bundled === true;
      }
    }
  }
  return false;
}

// The bundled engine lanes of a family — what an update row for that family adds
// as a second line ("内置引擎 Claude Agent SDK v0.1.x,随 MultiCC 升级"). Empty for
// every family whose lanes all come from its own CLI artifact.
function bundledEnginesOf(cli) {
  const familyId = familyOf(cli);
  if (!familyId) return [];
  const family = CLIS[familyId];
  const out = [];
  for (const kind of KINDS) {
    for (const entry of laneEntries(familyId, family, kind)) {
      if (entry.bundled !== true) continue;
      const lane = nameOf(entry.id) || familyId;
      if (out.some(item => item.lane === lane)) continue;
      out.push({ lane, engine: entry.engine || lane, kind });
    }
  }
  return out;
}

// The resident lane. A resident CLI keeps one child across turns, so its turns
// are cancelled and observed through the stream runtime, never through a
// per-turn child process.
function isResident(cli) {
  return capabilityOf(cli).lifecycle === 'resident';
}

// The lane a SESSION may run on. This used to be narrower than the CLI's own
// lane: a codex session routed through a concrete provider materialized a
// credential-bearing CODEX_HOME per attempt and scrubbed it when the turn ended,
// so a warm child would have outlived the credentials it was holding, and such a
// session stayed per-turn (src/codex/proxy-policy.js).
//
// That is no longer the case. A resident lane now holds a route that outlives the
// attempt on both provider paths: claude's rides in the ANTHROPIC_* env the host
// rebuilds every turn (and in a route capability the lane keeps stable while its
// spawn contract holds — src/chat/provider-attempt-runtime.js), while a codex
// session owns a session-scoped CODEX_HOME instead of an attempt-scoped one
// (src/codex/resident-route.js). So a session's provider no longer moves it off
// the resident lane, and every resident CLI answers true here.
//
// What that buys is residency — one child across turns instead of a respawn per
// turn. What it costs is attribution scope: a child orphaned by a finished
// attempt of the same spawn contract can still reach the host proxy during a
// later attempt of that session. It holds only an opaque local capability, never
// an upstream key, so this widens attribution, not credential exposure.
//
// The predicate keeps its session-shaped call sites (each caller has the session
// in hand anyway) without consulting one: today the answer depends on the CLI
// alone, and a caller without a session asks `isResident` for that same question.
function isResidentSession(cli) {
  return isResident(cli);
}

function protocolOf(cli) {
  return capabilityOf(cli).protocol;
}

// True when stopping a turn stops the lane's child, i.e. "the runner has
// stopped" and "the process is gone" are the same statement. False on a lane
// that interrupts in place: there the child outlives the cancel, so only the
// absence of an in-flight turn proves the runner stopped.
function cancelStopsProcess(cli) {
  return capabilityOf(cli).cancel === 'process';
}

// Wire value carried on a turn request and on the provider route minted for it;
// a route is only accepted for a turn whose transport matches (turn-request.js).
// Kept as the historical strings so persisted turns and route contracts stay
// valid even as the lanes they name are generalized.
function transportOf(cli) {
  return isResident(cli) ? 'claude-stream' : 'cli-process';
}

// Which API dialect the CLI speaks upstream. `format` only picks the spelling:
// the wire name (`anthropic-messages`) or a provider summary's apiFormat
// (`anthropic`). Returns null for a CLI this table does not know — including the
// ACP family, whose agent holds its own upstream credential and dialect — so
// each caller keeps its own fallback rather than inheriting one from here.
function protocolFamilyOf(cli, format = 'wire') {
  const family = FAMILIES[nameOf(cli)];
  if (family === 'acp') return null;
  if (family === 'anthropic') return format === 'api' ? 'anthropic' : 'anthropic-messages';
  if (family === 'openai') return format === 'api' ? 'openai_responses' : 'openai-responses';
  return null;
}

module.exports = {
  CAPABILITIES,
  CLIS,
  DEFAULT_CAPABILITY,
  DEFAULT_COLOUR,
  DEFAULT_KINDS,
  DISPLAY,
  KINDS,
  bundledEnginesOf,
  cancelStopsProcess,
  capabilityOf,
  colourOf,
  deprecationOf,
  displayNameOf,
  displayOf,
  engineOf,
  familiesFor,
  familyNameOf,
  familyOf,
  isBundled,
  isDeprecated,
  isProviderless,
  isResident,
  isResidentSession,
  kindsOf,
  knownClis,
  lanesOf,
  npmPackages,
  offersIn,
  protocolFamilyOf,
  protocolOf,
  providerlessClis,
  shortMarkOf,
  transportOf,
  updateOf,
  updateSpecs,
};
