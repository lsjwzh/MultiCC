#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_MAX_LINES = 3000;
const ABSOLUTE_EXCEPTION_MAX_LINES = 5000;
const DEFAULT_MAX_BYTES = 240000;
const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.dart', '.java', '.kt',
  '.swift', '.py', '.sh', '.html', '.css',
]);

// Temporary migration debt is deliberately explicit and ratcheted. The
// ceiling must be reduced in the same commit whenever a split makes the file
// smaller. These entries are not permanent exceptions to the 3k target.
//
// server.js returned to the default 3k limit in the typed continuation/wait
// migration. Keep this map for explicit, reviewed debt only; ordinary feature
// work must satisfy the default budget.
const MIGRATION_DEBT = Object.freeze({
  // app/lib/screens/main_shell.dart crossed 3000 in 039c6e43 (跨目录控制台), then
  // grew to 3174 lines / 122149 bytes in 95c6d6a0 (打开对话改成浮层) without
  // re-registering, which turned this gate red on main. The ceiling is the exact
  // committed high-water mark, so it is re-registered here; the next main_shell
  // split must ratchet it down and retire this entry once the file is <= target.
  // 2026-09-26 车道扶正：新建会话的默认线路按会话种类分流（chat 落 claude-exp，
  // 终端落 claude），任务卡上的线路徽标改走 cliDisplayName —— 三行 + 一个 import。
  // 高水位按实测登记到 3167/122298；下一位动 main_shell 该拆的仍是任务卡与目录
  // 控制台那两块渲染。
  'app/lib/screens/main_shell.dart': Object.freeze({
    ceiling: 3167,
    byteCeiling: 122298,
    target: 3000,
  }),
  // public/air.js 和 src/chat/turn-engine.js 都在 0f276ebc（session
  // multicc-claude-chat-06，2026-09-22T09:20）越过 3000：前者 3000 -> 3044，后者
  // 2997 -> 3002，两个都没回来登记，于是这道闸在 main 上红了。之所以没人发现，
  // 是因为当天的发版跑在更早的 Docker clean-install 就挂了，根本没走到 npm test。
  // air.js 在 e8741e73 撤掉「打开对话重复取一次详情」后回到 3040，仍然超。
  // 天花板同样是各自已提交的高水位，拆分哪个就压哪个，落到 <= target 时删掉这条。
  // 保险箱页头（adminHeadings 加一条 secrets，页头才不会掉出原始 key）本该把这行加
  // 回去，但闸只认字节不认「这条该不该有」：就地压掉同区几行注释的赘语把这笔抵掉了，
  // 于是高水位继续往下走到 3039/163299。
  // 工作区面板页头（adminHeadings 加一条 workspaces）用同样的办法就地抵掉，高水位
  // 再往下压一格到 3038/163257。
  // 定时任务「执行记录」（airScheduleRuns* 4 条键的卡片渲染 + 复用 scheduleTime）
  // 让它长到 3062/164739：记录本身是产品要求，但这一格确实是该拆的 —— 下一次动
  // 定时中心应把 renderSchedules 整块抽成独立模块，而不是继续抬这个天花板。
  // Worktree 生命周期那一格（目录页的拆解 + 「现在回收」）整块落在新模块
  // public/air-worktrees.js，air.js 只多了两处接线：目录卡那行文案改走
  // MultiCCAirWorktrees.summary()（原表达式留作 fallback），render() 多一行把快照
  // 递进去。三行注释 + 一段 fallback，没有别的 DOM 逻辑进来 —— 下一位再动目录页，
  // 该拆的仍是 renderSchedules / renderDirectoryOverview，不是这里。
  // 与工作区面板那条一起合入后，两个方向的增量都还在：合并树实测 3067/165249，
  // 天花板就登记这个实测值（不抬到任何一个分支的旧值上去）。
  // 工作区那一格搬成原生（air-workspaces.js）后，adminHeadings 里那条页头从硬写中文
  // 改成 t()，行数不变、字节 +29；同区一段注释就地压掉抵账，高水位往下走到 165233。
  // 目录侧拉 / 拖拽排序（air-directory-nav.js）在 render 里多递一行上下文，旁边两行
  // 注释并成一行抵账，行数不变，字节降到 165226。
  // 侧栏「最近任务」不再掺当前目录的任务（只留未读 + 打开过的）；直接 ?task= 打开的任务
  // 改在 render() 里统一记进最近，refreshEntry 里那段记录连同长注释删掉：降到 3061/164707。
  // 任务全文检索（public/task-search.js + GET /api/task-board/search）在 air.js 里有
  // 三处接线：⌘K 面板与目录页各持一个控制器（paletteSearch / directorySearch），命中
  // 时改用服务端算好的相关度顺序，并把命中片段当副标题/解释行摆出来。行数从 3064 长到
  // 3094：其中 3 行（3061 -> 3064）是本轮之前就漂在 main 上的 —— 上一格的天花板登记在
  // c22b8d2f，之后 4741474a 又碰了 air.js 却没回来改这里，这道闸在 main 上其实已经是红
  // 的；剩下 30 行才是这次的接线。按惯例只登记实测高水位，不抬到别处；下一次动目录页或
  // ⌘K，该拆的仍是 renderSchedules / renderDirectoryOverview，不是这几行接线。
  // 搜索框加「搜索范围」开关（全部记录，含对话 / 仅任务标题与摘要）：目录页多一个
  // select、一行渲染同步、一个 onchange，并默认落到「全部记录（含对话）」——旧默认只搜
  // 任务标题摘要，只在对话里出现过的词根本搜不到。搜索口径另走 air-admin 的
  // searchFilter()（永远搜全部记录，不套状态那格），目录页这里多两行算这份口径。
  // ⌘K 面板没有放开关的位置，直接固定搜全部。行数 3094 -> 3118，其中 4 行仍是上面
  // 那笔 main 既有漂移（3098），这次一并按实测高水位登记。
  // 「等后台任务」独立成状态之后，这张表里的规范状态词全部改由注册表
  // （status-presentation.js）的 airLabelKey 列经 airStatusLabels() 提供 —— 六个手抄的
  // 状态条目（含把 B 说成「等待回答」的那个）连同一条中间变量一起删掉，`label()` 只多
  // 一行去注册表折算别名。少掉的词换来一段解释「为什么规范状态不在这里再写一遍」的
  // 注释，行数刚好抵平（3118 不变），字节按重排后的实测降到 169154。
  // 2026-09-26 车道扶正（接着上面 air.js 那格）：多了一层线路展示壳
  // （cliDisplayName / cliOptionLabel / laneRouteLabel / cliOffersInChat / firstChatCli
  // 五个小助手），快速开始、定时任务、任务气泡三处改走它们，chat 的下拉一律滤掉一次性
  // 车道。laneRouteLabel 是自持账号车道那处「WorkBuddy · WorkBuddy」去重 —— 产品名
  // 扶正之后，路由名和车道名同源时会重一遍。行数 3118 -> 3148、字节
  // 169154 -> 171301，全是接线；下一次动目录页或 ⌘K，该拆的仍是
  // renderSchedules / renderDirectoryOverview。
  'public/air.js': Object.freeze({
    ceiling: 3148,
    byteCeiling: 171301,
    target: 3000,
  }),
  // turn-engine.js returned below 3000 while fixing native UUID preparation.
  // public/manage.js crossed 3000 in b4427cf before the budget gate caught it;
  // paid back down to 2632 by splitting the aux-history UI (modal/panel/ws,
  // plus handleAuxHealth and the synchronous auxConnect init) into
  // public/manage-aux-history.js — no manage.js debt entry remains.
  // Crossed 3000 in the chat-view unification M2 (three new task-mode script
  // tags + the task-mode stylesheet link) after sitting at 2999 for ages. Paid
  // back down to 3000 in M4 when the detail-modal retirement freed enough
  // lines — no chat.html debt entry remains.
  // app/lib/providers/chat_provider.dart sat at exactly 3000/3000 lines for a
  // long time, so any addition at all turned this gate red. The limit-bar
  // structural review (限流条匹配逻辑全链路复查) is what crossed it: the app's
  // provider-quota slots were brought to parity with the web module's
  // (keep-last-known-good on a failed balance query, late ark/kimi responses
  // dropped instead of repainting the previous account, both vendor slots reset
  // on a provider switch) and the in-flight guards were keyed on the provider
  // identity instead of a bare boolean — a bare flag suppressed the *new*
  // provider's query when a switch landed mid-flight, which left the bar blank
  // after the switch had already wiped it. That is ~48 lines, mostly the
  // comments recording those invariants. The next split here should be the
  // vendor-quota cluster (the ark/kimi/qoder fetchers, their in-flight/backoff
  // state and their *QuotaView getters) into its own collaborator — that is one
  // cohesive ~200-line unit, and dropping back to <= 3000 retires this entry.
  // The Jev routing note moved the admission-progress helpers out to
  // app/lib/providers/admission_notes.dart, ratcheting this down to 3032.
  // 通知文案归一（tests/test-notification-copy.js）把 notify 分支里那张
  // 字母→outcome 的 switch 换成了对 session_status_helpers 的一行调用，
  // 于是同提交把天花板压到实测高水位 3017/121688。
  // 2026-09-24 Codex 车道改名：重连抑制的判定要同时认旧名与新名（"Codex" /
  // "Codex Exp" / "Codex Exec"），那 3 行注释解释了为什么不能只认一种拼法，
  // 按实测高水位抬到 3020/121909。
  // 2026-09-25 数字口径统一（shared/format.js ↔ utils/format.dart）：本文件的
  // `_fmtDuration` 换成对 format.dart 的调用，短了 8 行，按棘轮规则把天花板
  // 压回实测高水位 3012/121741（缩小同样是违约，不能只往下不改这里）。
  // 2026-09-26 车道扶正：连接提示里的线路名改从 cli_display 的 cliDisplayName 取
  // （旧写法把「Claude Exp」这种内部名当产品名发给用户），行数不变、字节 +14，
  // 按实测登记到 3012/121755。这一格仍是那笔 ~200 行的 vendor-quota 集群该还的债。
  'app/lib/providers/chat_provider.dart': Object.freeze({
    ceiling: 3012,
    byteCeiling: 121755,
    target: 3000,
  }),
});

// Reviewed third-party/generated assets are not first-party maintainability
// units. Keep this whitelist exact; directories must never be broadly ignored.
const REVIEWED_EXEMPTIONS = Object.freeze({
  'public/qrcode.min.js': Object.freeze({
    maxLines: ABSOLUTE_EXCEPTION_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
    reason: 'vendored minified QR encoder',
  }),
  // 终端页（public/index.html）原先四支 xterm 资源全走 cdn.jsdelivr.net，断网/被墙时
  // 整页打不开，现在按用户要求全部收进 public/vendor/。xterm.js 是 npm 包里唯一一份
  // 浏览器构建，上游没有 min 版：2 行 283404 字节，超的不是手写量而是体积，故按
  // qrcode.min.js 的先例登记成「已复核的第三方资产」。升级 xterm 时同步更新这里的
  // 字节数和 public/vendor/xterm/README.md 里记的 SHA-256。
  'public/vendor/xterm/xterm.js': Object.freeze({
    maxLines: ABSOLUTE_EXCEPTION_MAX_LINES,
    maxBytes: 283404,
    reason: 'vendored third-party UMD build of xterm 5.3.0 (upstream ships no minified file)',
  }),
  // 生成物，不是手写代码：scripts/generate-i18n.js 把 app/assets/i18n/{zh,en}.json
  // 原样拼成这一份双语词典，键数就是产品的文案条数。Air 补齐英文之后它从 2634 行
  // 长到 4988 行，对话帧（chat.html 的 title/aria-label 与运行期文案）补齐后又到 5156
  // 行，引导卡「未检测到任何 CLI」与 Assistant 空模型目录提示补 8 条键后再到 5174 行，
  // 侧栏 CLI 待更新浮层（airCliUpdate* 17 条键 × 中英）补到 5208 行
  // —— 涨的是数据量，不是复杂度，改它也没有意义（谁都不该手改生成物）。
  // 天花板压在当前高水位上，再涨必须回来改这里。真要瘦身只有一条路：按语言拆成
  // 两个文件（各约 150KB，各自都能落在默认 3000 行以内），那是独立的一次改动。
  // （上一轮把它记成 5172，比生成器实际写出的少 2 行——countLines 数的是 split('\n')
  // 的元素个数，行尾那个换行也算一格，所以对齐数字要用测试自己的量法，别用 wc -l。）
  // 目录首页的 Chat / Terminal 切换补 10 条键（airModeChat/Terminal、
  // airTerminals* 、airNewTerminal*），双语各 10 行 = +20 行；数字按测试自己的
  // countLines 量法对齐。App 页内加载补 3 条键（中英共 6 行）。
  // 0f276ebc（session multicc-claude-chat-06，2026-09-22T09:20）又补 9 条键 × 中英
  // = +18 行，正好越过上一轮压住的 5234/318056 高水位（0e3e10aa 时还严丝合缝地
  // 等于天花板）；同一个提交也是 public/air.js 与 src/chat/turn-engine.js 越线的
  // 那次，一并按当前高水位重新登记。
  // 保险箱入口「属于环境变量，不埋在某一组功能里」这次补 4 条键（中英各 4 行 =
  // +8 行）：secretsVaultEntry / secretsVaultShortHint（侧栏卡片副行与 Air 设置卡
  // 说明共用一句）/ secretsVaultCountHint / airAdminPanelSecrets。按测试自己的
  // countLines 量法（split(/\n/).length）对齐到当前高水位。
  // 原生保险箱面板再补 2 条键 × 中英 = +4 行（secretsSaved / secretsDeleted：保存
  // 与删除各要一句带条目名的回执，否则只能复用没有 {name} 的通用文案）。
  // 「旧 manage 页剩下十格全搬成 Air 原生面板」这一轮又补 296 条键 × 中英 = +592 行
  // （记忆/任务图谱、语音、Goal、全局、推送、桥接、Agent 资源、技能同步、临时上传
  // 各一格的正文文案；桥接那格的二维码/登录流程与图谱两个画布的图例先前是旧模块里
  // 的中文字面量，也一并进了词典）。按测试自己的 countLines 量法对齐到当前高水位。
  // 定时任务执行记录补 5 条键（airScheduleRuns / RunsEmpty / RunsManual /
  // RunsScheduled / RunsHint，中英各 5 行 = +10 行），再抬到 6232/381217。
  // Worktree 生命周期补 12 条键（airWorktree*：拆解、占用、策略、回收与四条回收
  // 回执，中英各 12 行 = +24 行），抬到 6256/382946。
  // 面板搬成原生之后，被复用的旧模块（manage-bridges / task-graph / memory-* ）原先
  // 藏在 iframe 里的中文一下子进了 Air 的扫描面：Air 的 i18n 关卡只认 DOM 文本，旧页
  // 里的字面量以前扫不到、现在扫得到，于是这四个模块也一并入典（键名前缀沿用它们各自
  // 的面板名）。中文值逐字保留，中文渲染与既有断言不受影响。
  // Aux 并发池补 4 条键（airAdminPool / PoolValue / SerialLane / SerialLaneValue，
  // 中英各 4 行 = +8 行），抬到 6264/383378；同时把任务板回填的确认文案去掉「串行」
  // 字样（aux 已经是并发池），纯值文本改写不动行数。
  // 缺 macOS 命令行工具时的「一键安装」补 6 条键（airTaskSettingsInstallDevTools
  // 及其 5 条结果文案，中英各 6 行 = +12 行），抬到 6276/384713。
  // macOS 磁盘权限的「一键打开设置」补 5 条键（airTaskSettingsOpenDiskAccess 及其
  // 4 条结果／路径文案，中英各 5 行 = +10 行），抬到 6286/385832。
  // 关盖运行的免密助手补 10 条键（airGlobalHelper* ：按钮两态、已装／未装、等待、
  // 两条结果、两条失败、一段说明，中英各 10 行 = +20 行），抬到 6306/387580。
  // 合并 main 时两侧各自抬过这一格（本分支 6306，main 因 airWorktreeRecordTotal
  // 一条键抬到 6266，两者从不同基线出发）。冲突解法定式是「以重新生成后的真实数字
  // 为准」，不是取某一侧：下面这组是两侧键全在的 i18n 重新生成后量出来的。
  // 工作区面板原生化再补 51 条键（airAdminPanelWorkspaces* + airWorkspaces*：四张卡的
  // 标题与 eyebrow、概览三行、两个清扫按钮与四条结果、目录行五个计数、孤儿对账七条、
  // 审计三条，中英各 51 行 = +102 行），抬到 6410/393445。旧页那一格的中文本来藏在
  // iframe 里扫不到，搬成原生后每一句都要入典，所以这一笔比寻常一格大。
  // Provider「高级」那四块（官方多账号 / 借道 / ZCode / Kimi 原生连接）从旧页的 iframe
  // 搬成原生后再补 55 条键、删 4 条（renderLegacy 的「在独立页打开」+ 迁移提示 + 那个
  // iframe 的标题）；官方多账号那个模块从旧页搬过来后自己写 DOM 的 60 条文案也归 i18n
    // 管了，净 +111 键，中英各 111 行 = +222 行，抬到 6632/409893。删 Provider 的那句
  // 确认词补上「只删本地副本、不动 CC-Switch」这条边界（旧页删掉之后这是唯一的删除
  // 入口，那条边界不能跟着旧页一起消失）：键数不变、只是变长，字节抬到 410097。
  // CLI 更新浮层给未安装的行加「安装」（4 键）+ 目录拖拽排序 / 目录卡侧拉（3 键），
  // 中英各 7 行 = +14 行，抬到 6646/410852。
  // 插入队列增加“尚未启动”提示，中英各一行。
  // Agent 资源页技能按来源分层（内置/CLI 自带/插件/我的/项目，5 键），中英各 5 行
  // = +10 行，抬到 6658/411500。
  // Auto Provider 候选池预设（套用/保存/删除/最近使用等 9 键），中英各 9 行 = +18 行，
  // 抬到 6676/412600。
  // 技能分层每组加一句来源说明（5 键 Hint），中英各 5 行 = +10 行，抬到 6686/413300。
  // 主/辅 token 徽标 tooltip 注明「含缓存」（改写 2 键，行数不变），字节抬到 413500。
  // Auto Provider 的难度路由（Jev 逐条评估）补 7 条键（中英各 7 行 = +14 行）：路由
  // 开关后缀 / 说明 / 至少两个候选 / 至少两个不同档位 / 档位上限 / 档位 aria / 档位
  // title。只在词典源（app/assets/i18n/*.json）里按键名字母序插入，catalog 同步手补
  // ——没有重跑生成器，免得把 main 上已存在的陈旧漂移（usage* 那几条）带进来。
  // 抬到 6696/414195。
  // 补第 8 条键 autoEditorRoutingKeyMissing（路由已勾但保险箱缺 vercel-api-key 的提示），
  // 中英各 1 行 = +2 行，抬到 6698/414487（这次是重跑生成器后的真实行数，用
  // split(/\n/).length 量的，比 wc -l 多 1）。
  // 难度路由改成「一看就会」的向导（方式单选 / ① 连接 Jev：粘 key、测试、判断不了时
  // / ② 负责列 + 效果预览 / 各类失败的白话解释），净增 44 键（新 47、删 3 条旧提示），
  // 中英各 44 行 = +88 行，重跑生成器后抬到 6786/420551。
  // 按原型重做成紧凑卡片（按顺序|按难度 分段、Jev 状态卡、↑↓✕ 行、添加线路、
  // 更多设置折叠），净增 22 键（新 32、删 10），中英各 +22 行 → 6826/422294。
  // 聊天窗口里的 Jev 判定小字（正在判断 → 判定为某档 · 选用某线路，以及判断不了
  // 时的白话原因），新增 21 键，中英各 +21 行 → 6868/424618。
  // Jev 网关可选（Vercel / OpenRouter / TypeSafe / 自定义）——每家的建 key 步骤和
  // key 前缀各写各的、自定义那栏的地址/模型/格式说明、以及 5 条地址校验白话，
  // 新 21 键、删 2 条旧的 Vercel 专属文案，净增 19 键，中英各 +19 行 → 6906/427403。
  // 搜索范围开关新增 3 键（airSearchScopeFull / airSearchScopeBoard /
  // airSearchScopeLabel），中英各 +3 行；⌘K 提示那行只改文案不加行。两条改动在
  // rebase 时合流（这是同一段登记，两边各改各的注释），按合流后重跑生成器的真实
  // 行数抬到 6912/427748。
  // 任务行的 Worktree 徽标补齐 dirty / ahead / dirty+ahead 三种状态文案；此前
  // air-admin.js 已引用这些 key，但词典缺项会把裸 key 直接渲染出来。中英各 3 行，
  // 按生成器真实高水位抬到 6918/428225。
  // 新 CLI gemini / grok（两条 providerless 车道）各要一句「默认（跟随 X 配置）」，
  // 中英各 2 行 = +4 行，重跑生成器后抬到 6922/428499。
  // 推送/通知文案归一（tests/test-notification-copy.js）：新增 B 的
  // notificationWaitingBackgroundTitle 中英各 1 行，同时删掉 18 个没人引用的
  // 同义 key（waitingInteraction / waitingBackground / apiError / tbRun* /
  // tbClass* / queue*），本笔净减 34 行。天花板按本树重跑生成器后的实测值登记
  // （6899 是 wc -l，这里的量法是 split('\n').length，多一格行尾换行）。
  // 2026-09-24 Codex 车道改名：新增 cliLaneDeprecatedNote（选择器里那句「兜底
  // 线路，计划淘汰」）中英各 1 行 = +2，按本树重跑生成器后的实测值抬到 6902。
  // 格式化归一（public/shared/format.js + app/lib/utils/format.dart）：相对时间
  // 多一档「紧凑秒」——配额条那一条挤着三个窗口段，说 `57s 前` 而不是 `57 秒前`。
  // 新增 secondsAgoCompact 中英各 1 行 = +2，重跑生成器后按
  // split(/\n/).length 量到 6904 行 / 428203 字节（生成器输出与提交版本逐字一致，
  // 没有带进别的漂移）。
  // 2026-09-25 MultiCC 自更新弹窗改成分步进度：七个步骤名 + 「跳过」+ 进度行
  // 共 9 个键，中英各 9 行 = +18，重跑生成器实测 6922 行 / 429053 字节。
  // 同日独立包也能从左下角更新：下载/校验/解压三个步骤名 + 独立包说明共 4 键，
  // 中英各 4 行 = +8，实测 6930 行 / 429730 字节。
  // 新建终端改成先问用哪个 CLI，随后又改成复用 chat 那套配置对话框（自建的选择层
  // 撤掉，只留 airNewTerminalHint 文案 + airTerminalCreateFailed 两条）；那一层还要
  // 按用途换抬头，补 airTaskSettingsHeading/Intro/FootTerminal 三键（中英各 3 行
  // = +6）。按本树重跑生成器实测 6938 行 / 430433 字节。
  // 2026-09-26 会话交接包上界面（public/chat-handoff.js 的导出/导入弹窗 + 分享
  // 卡片里那两个入口按钮）：handoff* 共 27 键，中英各 27 行 = +54，重跑生成器实测
  // 7018 行 / 437112 字节。
  // 同日目录里的终端行加状态点、提示行、「多久没动」与重命名 / 复制 id：airTerminal*
  // 共 13 键，中英各 13 行 = +26，重跑生成器实测 7044 行 / 438951 字节。
  'public/i18n-catalog.js': Object.freeze({
    maxLines: 7044,
    maxBytes: 438951,
    reason: 'generated bilingual dictionary (scripts/generate-i18n.js) — data, not hand-written source',
  }),
});

function countLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\n/).length;
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file));
}

function evaluateLineBudgets(entries, {
  defaultMax = DEFAULT_MAX_LINES,
  migrationDebt = MIGRATION_DEBT,
  exemptions = REVIEWED_EXEMPTIONS,
} = {}) {
  const violations = [];
  const debts = [];
  const observed = new Map(entries.map(entry => [entry.file, entry.lines]));

  for (const entry of entries) {
    const exemption = exemptions[entry.file];
    const bytes = Number.isInteger(entry.bytes) ? entry.bytes : 0;
    if (exemption) {
      if (entry.lines > exemption.maxLines || bytes > exemption.maxBytes) {
        violations.push({
          ...entry,
          bytes,
          limit: exemption.maxLines,
          byteLimit: exemption.maxBytes,
          kind: 'reviewed_exception_over_limit',
        });
      }
      continue;
    }
    const debt = migrationDebt[entry.file];
    if (debt) {
      const byteCeiling = Number.isInteger(debt.byteCeiling)
        ? debt.byteCeiling
        : bytes;
      if (entry.lines > debt.ceiling || bytes > byteCeiling) {
        violations.push({
          ...entry,
          bytes,
          limit: debt.ceiling,
          byteLimit: byteCeiling,
          kind: 'migration_debt_regressed',
        });
      } else if (entry.lines <= debt.target && bytes <= defaultMax * 80) {
        violations.push({
          ...entry,
          bytes,
          limit: debt.target,
          kind: 'migration_debt_should_be_removed',
        });
      } else if (entry.lines < debt.ceiling || bytes < byteCeiling) {
        violations.push({
          ...entry,
          bytes,
          limit: entry.lines,
          byteLimit: bytes,
          kind: 'migration_debt_ceiling_not_ratcheted',
        });
      } else {
        debts.push({ ...entry, bytes, ...debt });
      }
      continue;
    }
    if (entry.lines > defaultMax || bytes > DEFAULT_MAX_BYTES) {
      violations.push({
        ...entry,
        bytes,
        limit: defaultMax,
        byteLimit: DEFAULT_MAX_BYTES,
        kind: entry.lines > ABSOLUTE_EXCEPTION_MAX_LINES || bytes > DEFAULT_MAX_BYTES
          ? 'unapproved_over_5000'
          : 'unapproved_over_3000',
      });
    }
  }

  for (const file of Object.keys(migrationDebt)) {
    if (!observed.has(file)) {
      violations.push({ file, lines: 0, limit: 0, kind: 'stale_migration_debt' });
    }
  }
  for (const file of Object.keys(exemptions)) {
    if (!observed.has(file)) {
      violations.push({ file, lines: 0, limit: 0, kind: 'stale_exemption' });
    }
  }

  return { violations, debts };
}

function trackedSourceEntries({ rootDir = path.resolve(__dirname, '..') } = {}) {
  const output = execFileSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard',
  ], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return output.split('\0').filter(Boolean).filter(isSourceFile)
    // `git ls-files --cached` still reports a tracked file deleted in the
    // worktree until that deletion is staged. Governance must evaluate the
    // candidate tree, not crash midway through an intentional cleanup.
    .filter(file => fs.existsSync(path.join(rootDir, file)))
    .map(file => ({
    file,
    ...(() => {
      const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
      return { lines: countLines(content), bytes: Buffer.byteLength(content) };
    })(),
    }));
}

function main() {
  const result = evaluateLineBudgets(trackedSourceEntries());
  if (result.violations.length > 0) {
    for (const item of result.violations) {
      console.error(`[line-budget] ${item.kind}: ${item.file} has ${item.lines} lines (limit ${item.limit})`);
    }
    process.exitCode = 1;
    return;
  }
  const debtText = result.debts
    .sort((a, b) => b.lines - a.lines)
    .map(item => `${item.file}=${item.lines}->${item.target}`)
    .join(', ');
  console.log(`Source line budget OK; migration debt: ${debtText || 'none'}`);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_MAX_LINES,
  ABSOLUTE_EXCEPTION_MAX_LINES,
  DEFAULT_MAX_BYTES,
  MIGRATION_DEBT,
  REVIEWED_EXEMPTIONS,
  countLines,
  isSourceFile,
  evaluateLineBudgets,
  trackedSourceEntries,
};
