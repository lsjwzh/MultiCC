'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildPlan, parseArgs, RELEASE_CORE_LANES } = require('../scripts/run-test-tier');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

// The installer is served from the release tag it installs, so the tag in the
// documented URL is the version a user gets: no flags, nothing to keep in sync
// by hand on the command line.
function installVersions(relative) {
  const source = read(relative);
  return [...source.matchAll(/raw\.githubusercontent\.com\/lsjwzh\/MultiCC\/v(\d+\.\d+\.\d+)\/install\.sh/g)]
    .map(match => ({ url: match[1] }));
}

function windowsInstallVersions(relative) {
  const source = read(relative);
  return [...source.matchAll(/raw\.githubusercontent\.com\/lsjwzh\/MultiCC\/v(\d+\.\d+\.\d+)\/install\.ps1/g)]
    .map(match => ({ url: match[1] }));
}

test('public stable install commands use package.json as their version source', () => {
  for (const relative of ['README.md', 'README.zh.md', 'docs/installation.md']) {
    const commands = installVersions(relative);
    assert.ok(commands.length > 0, `${relative} must publish a stable install command`);
    for (const command of commands) {
      assert.equal(command.url, pkg.version, `${relative} install tag drifted`);
    }
    const windowsCommands = windowsInstallVersions(relative);
    assert.ok(windowsCommands.length > 0, `${relative} must publish a stable Windows install command`);
    for (const command of windowsCommands) {
      assert.equal(command.url, pkg.version, `${relative} Windows install tag drifted`);
    }
  }

  const installer = read('install.sh');
  const declared = installer.match(/^INSTALLER_VERSION="([^"]+)"/m);
  assert.ok(declared, 'install.sh must declare INSTALLER_VERSION');
  assert.equal(declared[1], pkg.version, 'installer version drifted from package.json');

  const windowsInstaller = read('install.ps1');
  const windowsDeclared = windowsInstaller.match(/^\$InstallerVersion\s*=\s*'([^']+)'/m);
  assert.ok(windowsDeclared, 'install.ps1 must declare InstallerVersion');
  assert.equal(windowsDeclared[1], pkg.version, 'Windows installer version drifted from package.json');
});

test('tag releases use the manifest core tier instead of the legacy full suite', () => {
  const coreGate = pkg.scripts && pkg.scripts['test:release:core'];
  const installGate = pkg.scripts && pkg.scripts['test:install'];
  const releaseGate = pkg.scripts && pkg.scripts['test:release'];
  assert.match(String(coreGate || ''), /npm run test:tiers:check/);
  assert.match(String(coreGate || ''), /node scripts\/run-test-tier\.js core/);
  assert.equal(installGate, 'npm run test:release:clean-install');
  assert.equal(releaseGate, 'npm run test:release:core && npm run test:install');
  assert.doesNotMatch(String(coreGate || ''), /(?:^|&&)\s*npm test(?:\s|$)/,
    'the release gate must not fall back to the unclassified full suite');

  const manifest = JSON.parse(read('tests/test-tiers.json'));
  for (const path of [
    'tests/test-codex-official-relay.js',
    'tests/test-claude-passthrough-hop.js',
  ]) {
    const entry = manifest.tests.find(candidate => candidate.path === path);
    assert.equal(entry?.tier, 'core', `${path} must stay in the release core tier`);
  }

  const coreWorkflow = read('.github/workflows/core-tests.yml');
  assert.match(coreWorkflow, /npm run test:release:core/);
  for (const workflow of ['.github/workflows/release.yml', '.github/workflows/desktop-release.yml']) {
    assert.match(read(workflow), /core-tests:\s+uses: \.\/\.github\/workflows\/core-tests\.yml/,
      `${workflow} must call the canonical core gate`);
  }
});

test('core runner covers every selected path and expands declared variants', () => {
  assert.deepEqual(parseArgs(['core', '--lane', 'isolated', '--dry-run']), {
    tier: 'core', lane: 'isolated', dryRun: true,
  });
  assert.throws(() => parseArgs(['flow']), /only accepts the core tier/);
  assert.throws(() => parseArgs(['core', '--lane']), /requires a value/);

  const manifest = JSON.parse(read('tests/test-tiers.json'));
  const core = manifest.tests.filter(entry => entry.tier === 'core');
  const plan = buildPlan(manifest, { node: 'node', flutter: 'flutter', root });
  // Re-audited: bb5601a2 registered tests/test-dom-helpers-escape.js as core
  // without moving these numbers off 297 (one deterministic Node unit test, no
  // external side effects — safe for the release core tier), this tranche's
  // registration of tests/test-auto-route-notes.js adds one more of the same
  // kind, and the format consolidation registers tests/test-format-guard.js —
  // likewise a static Node unit test that reads public/ and the Flutter source
  // and writes nothing. 297 + 3 = 300. 62119be9 then added
  // tests/test-proxy-stall-watch.js (pure in-memory unit test, registered as
  // core on rebase): 301. Re-audited again: this tranche registers
  // tests/test-session-runtime-busy.js, which asserts a truth table over plain
  // objects plus source-text invariants and touches no clock, port, FS or
  // process — safe for the release core tier. 301 + 1 = 302. The zcode resident
  // work then registered tests/test-zcode-resident.js without moving them, which
  // left this assertion red on main: 302 + 1 = 303. That one is a genuine core
  // invariant (the resident lane and its background hold), and it is hermetic —
  // it spawns only its own fixture app-server into a temp directory, binds no
  // port, and is green in 6s over repeated runs — so it stays in the release
  // tier; the lane it is filed under is the owner's call, not this assertion's.
  // Re-audited: this tranche registers tests/test-terminal-proxy-route.js as core
  // — the terminal route capability and its proxy-guard admission (the regression
  // behind 「终端里 409 provider route attempt is no longer active」). It is a pure
  // in-memory unit test: fake session Map, injected encoder/mint, no clock, port,
  // FS or process — safe for the release core tier. 303 + 1 = 304.
  // Re-audited: this tranche registers app/test/terminal_service_test.dart as core —
  // the terminal attach snapshot must replace the screen rather than append to it,
  // which is what keeps a reconnect or a return from background from doubling the
  // scrollback. It is a plain test() over the transport with a fake WebSocketChannel
  // and a stubbed ticket HTTP client: no network, simulator, clock, port, FS or
  // process — safe for the release core tier. 304 + 1 = 305.
  // Re-audited for the v2.1.3 release. tests/test-global-lane-tier-alias.js had
  // been registered as core by an earlier tranche without moving these numbers,
  // which left this assertion red on main: 305 + 1 = 306. It is a genuine core
  // invariant (a tier alias must resolve inside the lane that owns the wire
  // model, not globally) and it is hermetic — plain objects and source text, no
  // clock, port, FS or process — so it stays in the release tier. This tranche
  // then registers three more, all of them the human-assist annotation contract:
  // tests/test-chat-annotate.js (the byte-exact block the web lightbox emits and
  // the App must reproduce, checked against public/chat-annotate.js and the
  // agent-side contract in src/chat/host-prompts.js), tests/test-assist-snapshots.js
  // (the 7-day screenshot retention sweep: per-file window, emptied session dirs
  // dropped, symlinks left alone, unbounded roots refused, data-dir isolation),
  // and app/test/image_annotate_format_test.dart (the same contract on the Dart
  // side, a plain test() with no widget tree). None of the three touches the
  // network, a simulator, a clock, a port, a live service or another process.
  // 306 + 3 = 309.
  // 2026-09-27 运行期防锁 + 自动解锁：tests/test-keep-awake.js（caffeinate
  // assertion 服务的纯 runtime 测试，注入 spawn，不碰真进程）与
  // tests/test-macos-unlock-password.js（钥匙串存取，注入 security，不碰真
  // 钥匙串）都是 hermetic 单测，注册为 core。309 + 2 = 311。
  // 2026-09-27 dead-subsystem 拆除：task-run 台账/生产主机/转发器那 14 个 core
  // 测试随 src/task-run 一起删除，另有 tests/test-task-board-{merge,cancel-run}.js
  // 与 6 个 app/test/*.dart（task board UI 退役）也退出 core。311 - 20 = 291。
  // 2026-09-28 行缓存守卫：tests/test-task-shell-row-cache.js 注册为 core
  // deterministic 时没同步这几个数字，main 因此一直红在 292 !== 291。它是
  // hermetic 的——只在临时目录里开一个 task-shell sqlite store 验证行缓存的
  // 复用与失效，不碰端口、网络、真库、时钟或别的进程——留在 core 是安全的。
  // 291 + 1 = 292。
  // 2026-09-28 自动解锁授权链路（本次）：再注册 tests/test-macos-unlock-probe.js。
  // 它注入 execFile，只解析 agent 的 stdout JSON，不 spawn 真进程也不碰真钥匙串，
  // 同样是 hermetic 单测。292 + 1 = 293。
  // 2026-09-28 合盖熄屏守卫收进 server 进程（本次）：再注册
  // tests/test-lid-display-guard.js —— 决策表 + 两档轮询 + 注入 execFile 的行为测试，
  // 不 spawn、不碰真屏幕。293 + 1 = 294，deterministic 250 + 3 = 253，
  // commands 277 + 3 = 280。
  // 2026-09-28 主机设置收敛成两条（本次）：运行期防锁（caffeinate）整套退役 ——
  // 它在两开关模型里是多余的（SleepDisabled 覆盖空闲睡眠、自动解锁覆盖锁屏），而且
  // 开着反而跟省电目标对着干（-d 会让屏幕永不熄）。tests/test-keep-awake.js 随之退出
  // core；两个免密助手测试（test-privileged-helper.js / -route.js）本就在 flow 档，
  // 沿 powerd 那条路一起删掉，core 之外的数字不动。294 - 1 = 293，
  // deterministic 253 - 1 = 252，commands 280 - 1 = 279。
  // 2026-09-29 provider 批量迁移（45db1c13，随休眠快照落盘）：注册
  // tests/test-provider-reassign.js 为 core 时没同步这几个数字，main 因此红在
  // 294 !== 293。它是 hermetic 的——内存 harness + 临时目录，不碰端口、网络、
  // 真进程——留在 core 是安全的。293 + 1 = 294，deterministic 252 + 1 = 253，
  // commands 279 + 1 = 280。
  // 2026-09-30 模型价格表（src/pricing/price-table.js）：注册
  // tests/test-price-table.js 为 core deterministic。它钉的是路由的输入契约——
  // 同一个 id 被多个 provider 贩卖时哪个价格作答（providerHint > 一方 provider >
  // 中位价）、只有有价条目才算命中、以及刷新遇到垃圾载荷/断线/超时时必须保留旧表
  // 而不是把一份好价格换成错误页。完全 hermetic：fetch 注入、缓存目录全是 mkdtemp
  // 临时目录、不碰真 ~/.multicc、不碰网络、不绑端口、不起进程（唯一真实计时器是
  // 25ms 的 abort 超时断言）。294 + 1 = 295，deterministic 253 + 1 = 254，
  // commands 280 + 1 = 281。
  // 2026-09-30 价格分档的池（src/chat/auto-provider-pricing.js）：注册
  // tests/test-auto-provider-pricing.js 为 core deterministic。它钉的是价格表的
  // 消费契约——查不到的 id、抛错的表、负价一律落到「未知价」而不是掀翻一轮；自动选模
  // 的线路按价格铺开而不是砍成最便宜的六个；四档封顶且未知价永远排在最贵那档。完全
  // hermetic：纯函数 + 注入的价表 stub，不碰网络、不碰 ~/.multicc、不绑端口、不起进程。
  // 295 + 1 = 296，deterministic 254 + 1 = 255，commands 281 + 1 = 282。
  // 2026-10-01 共享语音输入组件（public/voice-composer.js）：注册
  // tests/test-voice-composer.js 为 core deterministic。它钉的是 Chat 页与 Air
  // 快速任务输入框共用同一套听写实现的契约——直接驱动模块两条路径（流式/legacy）、
  // 经由 Chat composer 证明 onCommit 真的是 send()、以及 air.html/air.js 的静态接线。
  // 完全 hermetic：vm + 注入的假 DOM 对象，不碰网络、端口、真进程或时钟。
  // 296 + 1 = 297，deterministic 255 + 1 = 256，commands 282 + 1 = 283。
  // 2026-10-04 v2.3.0 发版复核：v2.2.3 之后有 7 个测试登记为 core 却没同步这几个
  // 数字，逐个审过都留在发布 tier：
  //   - tests/test-bark-devices.js：Bark 设备存储 + 投递。存储走 mkdtemp + assertTestDir；
  //     投递打的是进程内 127.0.0.1:0 假服务器——与另外 14 个 core deterministic 测试同一
  //     模式，不碰外网、不碰真 ~/.multicc。
  //   - tests/test-fcm-push.js：FCM 设备表与 transport，凭据缺失只停 FCM。fetch 注入、
  //     临时目录，不碰 Google 端点。
  //   - tests/test-native-session-guard.js：zcode/kimi/codebuddy/qoder/dsh 原生会话超限
  //     归档（只挪不删）。全部在 mkdtemp 假 home 下，不 spawn。
  //   - app/test/{fcm_service,notification_foreground,remote_screen_rfb,remote_screen_service}_test.dart：
  //     plain test()，HTTP 走 MockClient、通知走 mock MethodChannel、RFB 编解码纯字节；
  //     没有 widget 树、模拟器、真 socket。
  // 297 + 7 = 304，deterministic 256 + 3 = 259，flutter 17 + 4 = 21，
  // commands 283 + 3 = 286（Flutter 仍是一条批量命令）。
  // 2026-10-04 v2.3.2 发版复核：+2 core deterministic，两个都是纯单测、
  // hermetic（vm/注入 stub，不碰网络端口进程）：
  //   - tests/test-turn-timeline.js：每轮模型时间线（request/thinking/streaming
  //     非 tool 执行段），直接驱动 src/chat/turn-timeline 的观察函数；
  //   - tests/test-notify-prefs.js：统一「通知与播报」偏好档位（off/away/always）
  //     与两个声音控制器（air-task-notify / chat-notifications）的契约，
  //     fake window + 录音式构造器，legacy 布尔键只迁移一次。
  // 304 + 2 = 306，deterministic 259 + 2 = 261，commands 286 + 2 = 288
  // （manifest 各自登记 owner，runner 为两个文件各生成一条执行命令）。
  // 2026-10-05 v2.4.0 发版复核：三处增量，逐个审过都留在发布 tier：
  //   - tests/test-command-code.js：v2.3.2 复核时漏登——它已在 manifest 里注册为
  //     core deterministic 却没同步这几个数字，main 因此一直红在 307 !== 306。
  //     它是 hermetic 单测：mkdtemp 假 home 下验证 command-code 的 providers.json
  //     配置幂等与权限位，不碰网络、端口、真进程（http 字样全是字符串字面量）。
  //   - tests/test-asr-model-installer.js（本次，deterministic）：本地 ASR 权重
  //     下载器的状态机（missing/downloading/ready/failed/unsupported/disabled）、
  //     锁与空闲超时、首启自动下载门。fetch/时钟/文件系统全注入 stub，不碰网络、
  //     端口、真 ~/.multicc。
  //   - tests/test-service-routes.js（isolated）：service 路由的端到端契约——
  //     真实 auth 边界、流式 HTTP、持久化与 WebSocket 代理；打的是 127.0.0.1:0
  //     进程内假上游 + mkdtemp 临时目录，不碰外网。
  // 306 + 3 = 309，deterministic 261 + 2 = 263，isolated 24 + 1 = 25，
  // commands 288 + 3 = 291。
  // 2026-10-06 v2.4.1 发版复核：+1 core deterministic。
  //   - tests/test-ios-ota.js：iOS OTA 分发通道（src/ios-ota.js）的契约——本地
  //     IPA + sidecar 发现、按请求 scheme/host 渲染 manifest（一次投放 loopback/
  //     局域网/Tailscale Funnel 同装）、itms-services 抓取器免登走通。打的是
  //     127.0.0.1:0 进程内服务 + mkdtemp 临时目录，不碰外网——留在发布 tier。
  // 309 + 1 = 310，deterministic 263 + 1 = 264，commands 291 + 1 = 292。
  // 2026-10-11 v2.4.3 发版复核：+1 core deterministic。
  //   - tests/test-json-compression.js：/api/* JSON gzip（src/http/json-compression.js）
  //     的契约——按 Accept-Encoding 压缩一次性整包 JSON、流式/SSE/已编码放行。进程内
  //     http 服务 + 注入压缩流，不碰外网，注册为 core。
  //   - tests/test-model-history-converter.js 补进 core：web_search_call 的 queries
  //     回填（严格第三方 Responses 上游的确定性 422 修复），纯转换函数测试。
  //   - tests/test-file-transfer-routes.js 挂 owner npm:test:core（tier 仍 flow），
  //     不改 core.length。
  // 310 + 1 = 311，deterministic 264 + 1 = 265，commands 292 + 1 = 293。
  // 2026-10-12 v2.5.0 发版复核：+1 core deterministic。
  //   - tests/test-codex-background-progress.js：Codex 原生后台任务进度
  //     （src/cli-adapters/codex-background-events.cjs + src/chat/native-background-tasks.js）
  //     与 codex-exp 适配器 collabAgentToolCall 展示的契约——子任务衍生/两路并行/
  //     嵌套追踪、心跳静默与超时回收、Agent 工具卡片与中文状态。完全 hermetic：
  //     注入 timer/now/emit，fixture 驱动，不碰网络、端口、真进程。
  // 会话医生（tests/test-doctor.js）：312 + 1 = 313，deterministic 266 + 1 = 267，commands 294 + 1 = 295。
  // 2026-10-14 v2.5.2 发版复核：+2 core（1 deterministic + 1 non-UI flutter）。
  //   - tests/test-event-system.js（deterministic）：事件触发器引擎（src/events/ 的
  //     catalog/hub/engine/rules/actions + src/triggers）的契约——事件匹配与已知模式、
  //     任务状态派生事件、规则校验、私网地址判定与签名。完全 hermetic：EventEmitter +
  //     注入 randomUUID/now/dirIdOf，不碰网络、端口、真进程。
  //   - app/test/event_trigger_service_test.dart（flutter，非 UI）：触发器 wire contract
  //     （GET /api/event-triggers、POST/PUT/DELETE 规则路由、draft body、校验）。plain
  //     test()，MockClient + mock SharedPreferences，无 widget 树/模拟器/真 socket。
  // 313 + 2 = 315，deterministic 267 + 1 = 268，flutter 21 + 1 = 22，commands 295 + 1 = 296。
  // 补齐此前登记的 cli-key-accounts（临时目录与假密钥、无真实登录），以及本次
  // claude-oauth-proxy-recovery（本地模拟上游、假凭据）。两者验证核心鉴权不变量，
  // 均无需真实服务或账号；315 + 2 = 317，deterministic 270，commands 298。
  // 2026-10-18 v2.6.2 发版复核：+1 core deterministic。
  //   - tests/test-commandcode-grok-models-route.js：Command Code / Grok 实时模型目录
  //     （src/routes/commandcode-models.js、src/routes/grok-models.js）的契约——按真实
  //     `--list-models` 抓取固化 vendor 分组、忽略周边非模型文本、丢弃 headless-only
  //     段、未鉴权 Grok 列表可服务但不进缓存、兜底列表不缓存。完全 hermetic：
  //     fixture 文本 + mkdtemp 里的假 CLI 脚本，不碰网络/端口/真账号。
  // 317 + 1 = 318，deterministic 271，commands 299。
  // 2026-10-18 v2.6.3 发版复核：+10 core（4 个新登记的保险箱/热词用例 +
  // 以往漏登记、本次补齐 lane 的 4 个 + 2 个 flutter）。四个保险箱用例把
  // 「spawn 时固定的环境」钉死：条目变化只在回合边界换进程，后台任务在跑时顺延
  // 而不是拒绝回合。三个走 injection 的（deterministic、不 spawn 不起服务）、
  // claude-sdk 那个真起子进程+假上游（isolated）；secret-tools 只用 127.0.0.1:0
  // 的进程内服务与 .example.com 字符串。318 + 10 = 328，deterministic 279，
  // isolated 26，flutter 23，commands 308。
  // 补齐已在 HEAD 的逐卡缓存契约，以及本次首页摘要/游标契约：两个 deterministic core。
  // 2026-10-20 v2.7.0 发版复核：+1 core flutter。
  //   - app/test/air_sync_service_test.dart：Air 增量同步机制（真实 HttpServer + WS、
  //     分页/重连/epoch 切换），属于主链路回归，留在 core。
  //   - 同批 app/test/air_indexed_home_test.dart 是 widget 展示测试，按规则归 flow，
  //     不计入 core。
  // 330 + 1 = 331，flutter 23 + 1 = 24。
  // 2026-10-21 v2.8.0 发版复核：+6 core（331 → 337）。
  //   - tests/test-quota-guard.js、tests/test-quota-guard-routes.js（deterministic）：
  //     额度保护闸门的判定与路由契约，纯函数 + 进程内路由，不碰真账号。
  //   - tests/test-chat-stream-resume-startup-death.js（deterministic）：启动期死亡后的
  //     流恢复，属于主链路回归。
  //   - tests/test-claude-refresh-park.js（isolated）：刷新阶梯的退避/停泊与健康文件，
  //     mkdtemp 里的假 CLI 脚本，不碰网络与真账号，但会起子进程所以记 isolated。
  //   - tests/test-official-egress-per-account.js（deterministic）：官方条目的出口 IP
  //     白名单必须钉在正在编辑的那条配置上，属于安全边界。
  //   - app/test/remote_touch_controller_test.dart（flutter）：触摸手势→RFB 指针的坐标
  //     与状态机契约，纯 Dart 不碰 Widget，按非 UI Flutter 计入 core。
  // 337，deterministic 285，isolated 27，flutter 25。
  // v2.8.3 复核新增 7 项：错误持久化、任务清理、HTTP/WS/额度/语音代理
  // 6 项 Node 机制测试使用 stub、临时库或进程内假服务器；Air 删除超时为
  // MockClient + fakeAsync 的非 Widget 测试。均无真实凭据或外部服务依赖。
  // Rust 接入复核：本次增加原生/Node 差分测试（临时合成文件、隔离子进程，
  // 不访问真账号）；同时纳入主线 912d254b 已登记的 relay-model-catalog，
  // 其请求全部使用注入的 fetch stub。344 + 2 = 346，均为 deterministic。
  // v2.8.4 复核新增 3 项：Codex 代理追踪使用内存请求/响应替身；
  // Rust SQLite 使用内存库、临时文件和隔离子进程验证行为兼容；
  // 源码 Rust 启动使用临时仓库、假编译器和独立假服务，不碰宿主服务。
  // 无真实凭据或外部服务依赖，保持 core：349 项，326 条执行命令。
  // v2.9.0 review: four deterministic suites cover Claude egress, Codex
  // account models/OAuth and Rust CPR with injected services or loopback
  // fixtures. Two isolated native suites use temporary credentials and fake
  // CLIs for expired refresh/model discovery. No real accounts are required.
  // Remote frame decoding and pointer queues add two non-Widget Flutter
  // suites; the gesture Widget suite stays in flow. 357 entries, 332 commands.
  // App build 174 review: three deterministic Rust/Air read-model suites
  // compare synthetic snapshots and temporary SQLite fixtures with the Node
  // oracle. No real accounts, user data, devices or external services are used.
  // Remote-screen Widget, wire and live-device suites remain outside core.
  // 360 entries, 335 commands; the non-UI Flutter core remains 28 files.
  // v2.10.0 review: passive Claude quota headers use synthetic response data,
  // injected services and a temporary cache. No account, browser or live API
  // is required. Keep this mechanism regression in deterministic core.
  // 364 entries, 336 commands; non-UI Flutter core is 31 files. The remote
  // screen P2P, LAN resolver and rate controller suites joined core: they drive
  // pure Dart state machines through injected callbacks, MockClient and an
  // injected clock, with no widget tree, simulator or real socket. Flutter is
  // still one batched command, so the command count is unchanged.
  // v2.11 provider trend review: the quota-history adapter suite uses temporary
  // SQLite files and skips explicitly when the native kernel is absent; no
  // account, browser or live API is involved. 365 entries, 337 commands.
  // Provider router review: native-host and virtual-provider suites use
  // temporary stores, loopback fixtures, injected fetch and example.invalid
  // endpoints (virtual-provider also pins MULTICC_DATA_DIR to a temp root).
  // No account, keychain, browser or live API is involved. 367 entries, 339 commands.
  // Re-audited: tests/test-secret-audit.js is a new security boundary suite
  // (vault management, panel reads, tool invocation and missing entries must all
  // leave durable audit records; a failed audit blocks use). It runs on a temp
  // MULTICC_DATA_DIR, spawns nothing and needs no account or live API, so it
  // stays in the deterministic release core tier. 367 + 1 = 368 entries and
  // 339 + 1 = 340 commands, since a new manifest path is a new runner command.
  // 368 entries, 340 commands.
  // Re-audited for the resident task-board migration: tests/test-task-domain-native.js
  // (native task rules, repository quarantine/conflict recovery, panic boundary
  // in a child process) and tests/test-task-board-store.js (resident board
  // handle vs. stateless parity, proxy dirty tracking, transactions) only use
  // temporary directories and the local native kernel; no account, browser or
  // live API. Both are deterministic. tests/test-machines.js (registered on main
  // without a re-audit) uses a temp root and loopback HTTP/WebSocket servers on
  // 127.0.0.1:0 only, so it stays in the isolated lane.
  // Re-audited for the task store v2 schema: tests/test-task-store-v2.js (v1→v2
  // migration with backup, context-record compaction and the 20-turn detail
  // window, no-op writes, batched card access) only uses temporary directories
  // and the local native kernel; deterministic.
  // Re-audited for the task store upgrade gate: tests/test-task-store-migration-gate.js
  // (progress math, retry policy, and a child process holding a 127.0.0.1:0
  // port with a fake native module) uses temp directories and loopback only;
  // deterministic.
  // 368 + 3 + 1 + 1 = 373 entries, deterministic 311 + 1 = 312, 344 + 1 = 345 commands.
  // Windows CLI discovery uses injected filesystem, registry, and process adapters only.
  // Register its seven deterministic regressions in core: 374 entries, 313 deterministic, 346 commands.
  // Re-audited for the send-key preference: tests/test-send-key.js (registered
  // without a re-audit) selects the Enter / Cmd+Enter mode through injected
  // storage and event stubs — plain objects, no clock, port, FS or process —
  // safe for the deterministic release core tier.
  // Re-audited for the Qoder version probe: tests/test-qoder-cli-version-selection.js
  // (registered on main without a re-audit) selects the newest Qoder install by
  // probing `--version` through an injected spawn adapter — plain objects, no
  // clock, port, FS or process — safe for the deterministic release core tier.
  // 374 + 2 = 376 entries, 313 + 2 = 315 deterministic, 346 + 2 = 348 commands.
  // Re-audited for the relay live model catalog: tests/test-provider-models-route.js
  // (registered on main without a re-audit) covers GET /api/providers/:id/models with
  // an injected fetch — the provider store supplies the base URL and credential, the
  // browser never does; unreachable gateways fall back to the static list. Plain
  // objects, no clock, port, FS or process — safe for the deterministic release tier.
  // Re-audited for the chat background activity line: tests/test-chat-bg-activity.js
  // drives the status-line module with fake timers, a stubbed poller and injected
  // format helpers — no clock, port, FS or process of its own — safe for the
  // deterministic release tier.
  // 376 + 2 = 378 entries, 315 + 2 = 317 deterministic, 348 + 2 = 350 commands.
  // Re-audited for the resident Claude API error incident:
  // tests/test-claude-api-error-message.js (already run by npm:test:core) drives
  // the turn engine, background hold and Claude adapter with plain objects and
  // no-op callbacks — no clock, port, FS or process — safe for the deterministic
  // release tier.
  // 378 + 1 = 379 entries, 317 + 1 = 318 deterministic, 350 + 1 = 351 commands.
  // Re-audited for stale CLI session-home cleanup: the janitor tests create an
  // isolated temporary root and verify that only stale, whitelisted directories
  // are removed. This is a filesystem safety boundary in the host lifecycle.
  // 379 + 1 = 380 entries, 30 + 1 = 31 isolated, 351 + 1 = 352 commands.
  // Re-audited for the Rust front door and the lossless JS/Rust bridge:
  // tests/test-gateway-child.js pins the peer-identity boundary behind
  // multicc-gateway (PROXY v1 parsing, request-locality on the real peer, the
  // lifeline and the inherited-environment guard). It binds random loopback
  // ports and spawns one child for the EADDRINUSE exit, so it is isolated.
  // tests/test-js-semantics-boundary.js, tests/test-native-js-bridge.js and
  // tests/test-task-run-context.js call the native kernels with in-memory
  // values only — no clock, port, FS or process — so they are deterministic.
  // 380 + 4 = 384 entries, 318 + 3 = 321 deterministic, 31 + 1 = 32 isolated,
  // 352 + 4 = 356 commands.
  // Quota settings now exercise the real Rust gateway and its Node child.
  // Keep the core set, moving that suite to isolated: 320 deterministic, 33 isolated.
  // tests/test-redaction-native.js compares the Rust text redaction with the
  // frozen Node rules on in-memory strings only, so it is deterministic.
  // tests/test-api-error-policy-native.js compares the Rust API error policy
  // with the frozen Node module on in-memory values, fixtures and seeded
  // generators (no clock, port, FS or process), so it is deterministic too.
  // tests/test-provider-semantic-scrub-native.js compares the Rust semantic
  // scrub and route walk with the frozen Node reference on in-memory events,
  // fixtures and seeded generators (no clock, port, FS or process) as well:
  // 387 entries, 323 deterministic, 359 commands.
  // Removing the JavaScript Claude transport registers
  // tests/test-claude-lane-differential.js: it drives the frozen SDK and the
  // native lane against the same temp-directory fake CLI (one child process
  // each, no port or network), so it is isolated. 387 + 1 = 388 entries,
  // 33 + 1 = 34 isolated, 359 + 1 = 360 commands.
  // Authentication migration adds tests/test-auth-security-native.js. It
  // compares the frozen Node contract, drives ephemeral loopback HTTP servers
  // and a bounded GC child, and verifies capability consumption and expiry.
  // Core/isolated: 389 entries, 35 isolated, 361 commands.
  // Native auth HTTP differential and shared-ticket/restart isolation: one more isolated entry.
  // Workspace transport now runs real HTTP/HTTPS and stream cancellation fixtures.
  // Add the dedicated transport suite as core/isolated; the existing sharing suite
  // retains its reviewed other tier and now also uses the isolated lane.
  // Source administration routes now verify real gateway/oracle HTTP, native
  // owner revocation, failed persistence and restart using isolated fixtures.
  // Move the existing route suite into core/isolated: 392 entries, 38 isolated.
  // Re-audited for the native session-record owner: tests/test-session-records-differential.js
  // compares the frozen Node lifecycle with the native owner over seeded in-memory
  // sequences with an injected timer queue (no real clock, port, FS or process),
  // and tests/test-session-records-durable.js uses only temporary directories plus
  // the local native kernel for disk-format, rotation and recovery fixtures. Both
  // are deterministic core entries run by npm:test:state.
  // 392 + 2 = 394 entries, 323 + 2 = 325 deterministic, 364 + 2 = 366 commands.
  // Re-audited for the native directory registry: tests/test-directory-records-differential.js
  // runs a seeded 1200-step differential against the frozen Node repository and
  // journal over temporary directories, and tests/test-directory-records-durable.js
  // covers envelope/rotation/crash-replay fixtures in temp roots. Both are
  // deterministic core entries run by npm:test:state and touch no port or
  // external process.
  // 394 + 2 = 396 entries, 325 + 2 = 327 deterministic, 366 + 2 = 368 commands.
  // Re-audited for the native workspace subscription owner:
  // tests/test-workspace-ws-native.js drives the native owner against frozen
  // raw-frame, heartbeat and backpressure oracles in memory (no port, real
  // clock, filesystem or child process), so it is deterministic core under
  // npm:test:core. tests/test-workspace-ws-isolated.js starts the real gateway
  // and server.js on a temporary data root and connects real WebSocket clients
  // over loopback and LAN, so it is isolated core under
  // npm:test:integration:isolated.
  // 396 + 2 = 398 entries, 327 + 1 = 328 deterministic, 38 + 1 = 39 isolated,
  // 368 + 2 = 370 commands (367 Node entries).
  // Re-audited for the native chat-session runtime owner:
  // tests/test-chat-runtime-native.js compares the native turn-runtime owner to
  // the frozen legacy store over a seeded 1200-step differential plus route
  // proof, clock-reentrancy and host-identity fixtures in memory, so it is
  // deterministic core under npm:test:core. tests/test-chat-turn-isolated.js
  // starts the real gateway and server.js on a temporary data root with a fake
  // Claude CLI and drives connect/stream/reconnect/cancel/delete over loopback
  // WebSockets, so it is isolated core under npm:test:integration:isolated.
  // 398 + 2 = 400 entries, 328 + 1 = 329 deterministic, 39 + 1 = 40 isolated,
  // 370 + 2 = 372 commands (369 Node entries).
  assert.equal(core.length, 400, 'the reviewed core set changed; re-audit the release tier');
  assert.equal(plan.entries.length, 400);
  assert.deepEqual(
    [...new Set(plan.entries.map(entry => entry.lane))].sort(),
    [...RELEASE_CORE_LANES].sort(),
  );
  assert.equal(core.filter(entry => entry.lane === 'deterministic').length, 329);
  assert.equal(core.filter(entry => entry.lane === 'isolated').length, 40);
  assert.equal(core.filter(entry => entry.lane === 'flutter').length, 31,
    'the reviewed non-UI Flutter core set changed; re-audit it before release');

  const expectedPaths = core.flatMap(entry => Array.from(
    { length: entry.variants?.length || 1 }, () => entry.path,
  )).sort();
  const plannedPaths = plan.commands.flatMap(command => command.paths).sort();
  assert.deepEqual(plannedPaths, expectedPaths, 'the runner must neither skip nor add manifest paths');
  assert.equal(plan.commands.length, 372,
    '369 Node entries, two extra variant executions, and one batched Flutter command are expected');

  const presentationSuites = new Map([
    ['tests/test-chat-history-ordering.js', 'other'],
    ['tests/test-chat-history-view.js', 'other'],
    ['tests/test-chat-recovery-service.js', 'flow'],
    ['tests/test-task-board-groups.js', 'other'],
  ]);
  for (const [testPath, tier] of presentationSuites) {
    const entry = manifest.tests.find(candidate => candidate.path === testPath);
    assert.equal(entry?.tier, tier, `${testPath} is UI/presentation coverage and must not block a release`);
  }

  const dispatchVariants = plan.commands
    .filter(command => command.paths.includes('tests/test-dispatch-loop-isolated.js'))
    .map(command => command.args.slice(1));
  assert.deepEqual(dispatchVariants, [[], ['--new-task']]);
  const taskFirstVariants = plan.commands
    .filter(command => command.paths.includes('tests/test-task-first-isolated.js'))
    .map(command => command.args.slice(1));
  assert.deepEqual(taskFirstVariants, [[], ['--no-token']]);
});


test('desktop Rust paths are initialized after runner allocation', () => {
  const workflow = read('.github/workflows/desktop-release.yml');
  for (const job of ['build', 'standalone']) {
    const start = workflow.indexOf('  ' + job + ':\n');
    assert.ok(start >= 0);
    const remainder = workflow.slice(start);
    const nextJob = remainder.slice(1).search(/^  [a-zA-Z][\w-]*:\s*$/m);
    const block = nextJob < 0 ? remainder : remainder.slice(0, nextJob + 1);
    const steps = block.indexOf('    steps:');
    assert.ok(steps >= 0);
    assert.doesNotMatch(block.slice(0, steps), /\$\{\{\s*runner\./,
      'runner context is unavailable in job-level env; GitHub rejects the whole workflow');
    assert.match(block.slice(steps), /MULTICC_RUST_PREBUILT_DIR=\$RUNNER_TEMP\/multicc-rust-prebuilt/);
    assert.match(block.slice(steps), /CARGO_TARGET_DIR=\$RUNNER_TEMP\/multicc-rust-target/);
  }
});

test('release publishing uses validated English notes from the tagged changelog', () => {
  const workflow = read('.github/workflows/desktop-release.yml');
  assert.doesNotMatch(workflow, /--generate-notes/);
  assert.match(workflow, /publication-policy -- release-notes "\$GITHUB_REF_NAME" CHANGELOG\.md/);
  assert.match(workflow, /gh release create[^\n]+--notes-file "\$RUNNER_TEMP\/release-notes\.md"/);
  assert.match(workflow, /gh release edit[^\n]+--notes-file "\$RUNNER_TEMP\/release-notes\.md"/);
  assert.match(read('.github/workflows/core-tests.yml'), /publication-policy -- release-notes/);
  assert.match(read('.github/workflows/ci.yml'), /publication-policy -- ci-commits/);
});
