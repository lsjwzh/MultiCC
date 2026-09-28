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
// app/lib/screens/main_shell.dart was registered here (ceiling 3167/122298) after
  // it crossed 3000 in 039c6e43 (跨目录控制台). 2026-09-27 删掉整块任务板 UI（老首页、
  // 目录详情浮层、任务板标签页与其级联的渲染类）后降到 699 行，已回到默认 3k 目标
  // 以内，于是这条登记按闸的要求退休 —— 别再把它加回来。
  // public/air.js 曾在 0f276ebc（session multicc-claude-chat-06，2026-09-22T09:20）越过
  // 3000（3000 -> 3044）且没回来登记，这道闸因此在 main 上红过一阵 —— 那之后每一格增量
  // 都按实测高水位登记一回，一路抬到 3108/170451；登记的注释末尾一直写着「下一次动目录页
  // 或定时中心，该拆的仍是 renderSchedules / renderDirectoryOverview」。
  // 2026-09-29 定时任务「脚本任务」这一轮兑现了前半句：renderSchedules 那一族（列表 +
  // 唯一那张表单 + 运行/暂停/重绑/删除四个动作，共 206 行）整块搬进
  // public/air-schedule-center.js，air.js 只留一次 bind()，落到 2903/160035 —— 回到默认
  // 3k 目标以内，于是这条登记按闸的要求退休，别再把它加回来。该拆的还剩页内那份目录
  // 渲染（renderDirectoryOverview）。
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
  // 2026-09-27 FIFO 暂存消息可改正文：queueAction 增加 text 透传（编辑用）。
  // 一行签名 + 一行转发，按实测高水位抬到 3014/121791。
  'app/lib/providers/chat_provider.dart': Object.freeze({
    ceiling: 3014,
    byteCeiling: 121791,
    target: 3000,
  }),
  // public/chat.js 越过 3000：2026-09-27 产出链接优化（fixupLocalFileLinks +
  // stripServerOrigin：agent 输出的本地文件链接改走 /api/download，不再 404）和
  // FIFO 暂存消息双击改正文（createEditHandler + configure 的 onEdit）各加了十几行。
  // 高水位按实测登记 3022/153645；下一次动 chat.js 该拆的是它那 3000 行渲染/事件
  // 编排，而不是继续抬天花板。
  // 2026-09-28 前后它自己降回 2993（<= 3000），这条登记按闸的要求退休 —— 别再把它
  // 加回来。该拆的仍是渲染/事件编排。
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
  // 同期 CLI 更新面板改按家族列行：内置引擎（Claude Agent SDK）挂在家族行下面说明
  // 「随 MultiCC 一起升级」，新增 airCliUpdateBundled 中英各 1 行 = +2。两支合流后
  // 按本树重跑生成器实测 7046 行 / 439114 字节（438951 + 163 = 两侧各自增量之和）。
  // 同日 App 截图标注（image_annotate_screen.dart）：annot* 共 26 键，中英各 26
  // 行 = +52，合流后重跑生成器实测 7098 行 / 441958 字节。
  // 同日删除 Provider 的引用弹窗与强制删除（airProviderRef* / airProviderInUse* /
  // airProviderForce*）共 19 键，中英各 19 行 = +38，合流后重跑生成器实测 7136 行 / 445045 字节。
  // 2026-09-26 又加键：rebase 三键 + 目录概览五卡（airStatRunning/Waiting/Error、
  // airDirStatClickFilter、airStatusRunning、airAdminActiveDetail）等，重跑生成器实测
  // 7154 行 / 445972 字节。
  // 2026-09-26 产物按目录分类 + 永久保留：docsScope*/docsNoDir/artifactKeepForever*
  // /docsregPermanent*/airDirArtifacts* 共 12 键，中英各 12 行 = +24，重跑生成器实测
  // 7178 行 / 447138 字节。
  // 2026-09-26 再 +1 键（airDirArtifactsStaleServer：「服务端没按目录过滤」那句话，
  // 中英各 1 行 = +2），重跑生成器实测 7180 行 / 447499 字节。
  // 2026-09-26 目录「完成」卡改口径：airStageDone 退场、airStatSucceeded 进场、提示行
  // airDirStatDoneHint 改名 airDirStatSucceededHint（键数不变 = 行数不变，只有键名变长
  // 撑了字节），重跑生成器实测 7180 行 / 447520 字节。
  // 2026-09-26 更新窗口改走 install.sh + 重启后轮询 version 确认：airOpsReloadAnyway
  // /airOpsUpdateConfirming/airOpsUpdateConfirmingBody/airOpsUpdateConfirmTimeout
  // 共 4 键，中英各 4 行 = +8，合流后重跑生成器实测按下方登记值为准。
  // 2026-09-27 运行期防锁 + 自动解锁 13 键（airGlobalKeepAwake* / airGlobalUnlock*），
  // 中英各 13 行 = +26，重跑生成器实测 7216 行 / 450572 字节。
  // 2026-09-27 frpc 改「跳官网下载、不再代装」：删 3 键（airTunnelInstallFrpc /
  // airTunnelDownloading / airTunnelFrpcInstalled）、增 2 键（airTunnelDownloadFrpc /
  // airTunnelRecheckClient），中英各 -1 行；改写的 3 条文案更长，重跑生成器实测
  // 7214 行 / 450751 字节（行数回落，字节涨 179）。
  // 2026-09-27 目录首页加「本目录定时任务」入口：airDirSchedulesOpen / airDirSchedulesTitle
  // / airDirSchedulesEmpty / airDirSchedulesOpenCenter 共 4 键（卡片上的动作与状态
  // 全部复用 airSchedule* 那一批已有键），中英各 4 行 = +8，当时按实测登记成
  // 7256 行 / 453069 字节。同日 rebase 到 main：task-run 子系统整体退场，这一批键
  // 跟着被删（-98 行），合流后重跑生成器实测 7158 行 / 447092 字节 —— 缩小也得回来
  // 改这一格，不然以后回涨 98 行都没人管。
  // 2026-09-27 本分支又带我的 i18n 键（本地文件链接、FIFO 编辑）合流：重跑生成器
  // 实测 7176 行 / 448047 字节，按棘轮登记到这一格。
  // 2026-09-28 自动解锁的钥匙串授权：Air 全局设置加「确认授权」按钮与四条状态文案
  // （airGlobalUnlockAuthorized / airGlobalUnlockAuthorize / airGlobalUnlockWaitAuthorize
  // / airGlobalUnlockNotStored / airGlobalUnlockProbeUnknown 共 5 键），中英各 5 行 = +10，
  // 重跑生成器实测 7176→7192 行（脚本按 split("\n") 计数，比 wc -l 多 1）/ 449575 字节，按棘轮登记到这一格。
  // 2026-09-28 电源设置收成两条开关：删掉免密助手那一行（airGlobalHelper* 10 键）与
  // 运行期防锁那一行（airGlobalKeepAwake* 5 键），以及被开关取代的 airGlobalUnlockTitle /
  // airGlobalUnlockClear；补 airGlobalUnlockToggle / airGlobalUnlockNeedPassword 两键，
  // 并改写关盖运行与自动解锁的说明文字。中英各净 -15 键，重跑生成器实测 7162 行 /
  // 447825 字节，按棘轮登记到这一格（缩小也得回来改，不然以后回涨 30 行都没人管）。
  // 2026-09-28 同一批收尾：钥匙串状态读不出来时不许把开关画成「关」，补 1 键
  // airGlobalUnlockUnreadable（中英各 1 行 = +2），另把 airGlobalUnlockFailed 从
  // 「保存失败」改成中性的「设置失败」（关掉开关走的是 DELETE，说成「保存」是错的；
  // 键数不变），并删掉从没被引用过的 airGlobalUnlockReadFailed（-2 行；它那条路现在
  // 由 airGlobalUnlockUnreadable 说话，服务端给的 error 本来就是 'read-failed' 这种码，
  // 塞进「读取失败：{message}」只会把机器码印给用户看）。重跑生成器实测
  // 7162 行 / 447955 字节（行数回落到收编前，字节多 130）。
  // 2026-09-28 抽屉二级联动：补 airSettingsAllPanels / airSettingsPanelCount 两键
  // （中英各 2 行 = +4）。重跑生成器实测 7180 行 / 448479 字节，按棘轮登记到这一格。
  // 2026-09-28 目录 Git 状态那颗「● N 个未提交文件」可点开后补 1 键 airGitDirtyHint
  // （中英各 1 行 = +2）；与上面抽屉那两键合流后，按本树重跑生成器的真实值登记。
  // 定时任务「脚本任务」类型补 12 键（airScheduleKind / KindAgent / KindScript /
  // ScriptIntro / Command / CommandPlaceholder / CommandHint / CreateScript /
  // ScriptPanelNote / ScriptExit / ScriptRan / ScriptRunFailed，中英各 12 行 = +24 行）。
  // 只改文案（airScheduleCommandHint 指到 examples/cron-scripts/）不增行，只长字节：
  // 按最后一版重跑生成器的真实值登记 7206/450584。
  'public/i18n-catalog.js': Object.freeze({
    // Shared setup, cancel and saved-password management for the two power switches.
    maxLines: 7206,
    maxBytes: 450584,
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
