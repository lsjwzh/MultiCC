# Web 移动版 UI 溢出与适配走查（2026-08-16）

按「先建 UI 分支图 → 依图逐节点走查」的方式，对 multicc Web 端在手机视口下做了一次
完整的溢出（overflow）与适配（responsive / safe-area / 触控目标）体检。本文是记录，
**不含任何产品代码改动**。

## 1. 方法与工具

双轨取证，互为印证：

| 轨道 | 用途 | 手段 |
|---|---|---|
| headless Chrome + CDP | 可编程遍历所有视图/弹层，做 DOM 量化审计 | `Emulation.setDeviceMetricsOverride` + `setTouchEmulationEnabled` + iPhone UA |
| iOS 模拟器真 WebKit | 视觉核验（Chrome 与 WebKit 在视口高度、文本排版上有真实差异） | `xcrun simctl openurl` + `xcrun simctl io booted screenshot` |

模拟器无法程序化点击（`idb` 未安装；`safaridriver` 需要宿主 Safari 手动勾选
Allow Remote Automation），因此**遍历交给 Chrome，视觉核验交给模拟器**。

审计脚本：`scripts/mobile-web-audit-lib.js`（本次一并入库）。判据六类：

| kind | 含义 |
|---|---|
| `scrollx` | 文档级横向溢出 |
| `oov` | 可见元素越过左右视口边缘 |
| `lost` | 被 `overflow:hidden/clip` 硬裁且无法滚动到 = 内容不可达 |
| `clip` | 文本硬截断（hidden + text-overflow:clip + nowrap，无省略号） |
| `touch` | 交互控件命中区 < 44×44 |
| `covered` | 元素中心点 `elementFromPoint` 命中无亲缘关系的上层元素 = 被压住 |

覆盖视口：**375×667**（iPhone SE / mini）、**393×852**（iPhone 15/16）、
**430×932**（Pro Max）、**932×430**（横屏）。

### 已知误报（已在脚本中过滤，记录备查）

- 关闭态抽屉（`transform: translateX(105%)`）→ 只按水平方向排除，不按垂直位置排除，
  否则会漏掉折叠线以下的真实横向溢出。
- 消息流里滚出可视带的气泡被固定 chrome 覆盖 → 按「最近可滚动祖先的可视带」过滤。
- 全屏遮罩存在时不做 `covered` 判定。
- 关闭态 `<details>` 的子节点在 Chrome 里仍有布局盒（`content-visibility:hidden`），
  会被误判为 `covered` → 已排除（meta 页那 4 条 `covered:pre` 即属此类，非缺陷）。

## 2. UI 分支图与覆盖情况

```
multicc Web Mobile
│
├─ A. /manage — Dashboard（单页 13 视图）                                    [13/13 ✓]
│  ├─ A0 骨架：nav 抽屉 · topbar · toast · focus-panel                      [✓]
│  ├─ A1 overview  A2 cron  A3 memory  A4 voice  A5 goal                   [✓ 干净]
│  ├─ A6 provider                                                          [✗ 溢出 ×2]
│  ├─ A7 global  A8 push  A9 tunnel  A10 bridges                           [tunnel ✗@375]
│  ├─ A11 resources  A12 skillsync  A13 storage                            [✓ 干净]
│  └─ A14 弹层 ×23（newdir/asr/cron/qr/aux/session(iframe)/dir-detail/
│         tb-detail/diff/mem-node/mem-file/memo/git-tree/git-commit-diff/
│         aux-history/focus-panel …）                                       [23/23 ✓ 干净]
│
├─ B. /chat.html?session=<id>
│  ├─ B1 header（11 个子块）                                                [✗ 高度+标题]
│  ├─ B2 悬浮层：danmaku · pending-input · merge-hint · diff-dock · dispatch [✗ 三层重叠]
│  ├─ B3 用量条组 + usage-detail-pop                                        [✗ 被压住]
│  ├─ B4 #messages（长代码 / 宽表格 / 长 URL / 无空格长串 / 超宽图）         [✓ 全部正常]
│  ├─ B5 aux-classify-bar   B6 pill 行   B7 queue-dock   B8 input-bar       [✗ 底部堆叠]
│  └─ B9 弹层 ×15（diff/cwd/goal/memo/dispatch-sheet/voice/debug/
│         cli-picker/effort/provider/ai-config/message-picker …）           [15/15 ✓ 干净]
│
├─ C. /index.html 终端  D. /meta.html  E. /memo.html
├─ F. /events.html  G. /share.html  H. /wechat.html                        [✓ 无溢出]
```

## 3. 问题清单

### P0-1 · chat 底部三层控件互相重叠（375 / 393 / 430 / 横屏全复现）

`merge-hint` 卡片压住下面这些元素，文字互相穿透，既读不了也点不了：

| 被压住的元素 | 压住它的 |
|---|---|
| `#claude-rate-limit-bar`（5h/1wk 配额条） | `span.merge-hint-text` |
| `span.usage-ctx-text` / `.usage-ctx-more`（上下文 93.1k/1000k · 详情） | `span.merge-hint-text` |
| `#subagent-pill` / `#subagent-pill-label`（子任务: …） | `span.merge-hint-text` / `#merge-hint-btn` |
| `#liveness-pill-label`（产出中） | `div#merge-hint.show` |
| `#dispatch-activity-fab` / `#dispatch-activity-count` | `#merge-hint-diff-btn` |

证据：`/tmp/se-chat.jpg`（375 Chrome）、`/tmp/land-chat.jpg`（横屏）、
`/tmp/ios-chat.jpg`（**iOS 模拟器真 WebKit**）。三份截图同一现象。

底部这一带同时承载：配额条 + 上下文条 + merge-hint 卡（含「查看 Diff」「合并」「⌄」）
+ subagent pill + liveness pill + dispatch 悬浮球 + danmaku 悬浮球 + 输入栏。
手机宽度下没有分层与让位规则，**这是本次最严重的问题**。

### P0-2 · chat.html 缺 dvh / -webkit-fill-available，输入框被 Safari 工具栏切掉

- `public/chat.html:11` — `html, body { height: 100%; overflow: hidden; }`
- 全文件没有 `100dvh`，也没有 `-webkit-fill-available`
- 对照组：`public/manage.html:509-510` 已经是
  `height:100vh; height:-webkit-fill-available; height:100dvh;` 三段 fallback

iOS Safari 下 `height:100%` 参照的是 ICB（大视口，含被工具栏覆盖的区域），
结果输入框第二行「paste files here」被底部工具栏切掉。模拟器截图已复现。

### P1-1 · chat 头部 chrome 吃掉半屏（小屏尤其严重）

| 视口 | header | cwd | aux | merge-hint | input | chrome 合计 | 消息区 |
|---|---|---|---|---|---|---|---|
| 375×667 | 103 | 34 | 28 | 75 | 109 | **349 (52%)** | 307 (46%) |
| 393×852 | 103 | 34 | 28 | 75 | 109 | 349 (41%) | 492 (58%) |
| 430×932 | 103 | 34 | 28 | 52 | 61 | 278 (30%) | 626 (67%) |
| 932×430 横屏 | 87 | — | — | — | 59 | ~288 (67%) | **142 (33%)** |

`#header` 有 11 个直接子块，375 下折成 4 行。横屏时消息区只剩 142px（约 2 张工具卡）。

### P1-2 · `#session-title` 被压到 38vw，右侧大片空白（CSS 源序 bug）

- `public/chat.html:147-159` 的 `@media (max-width: 760px)` 里已经写了
  `#session-title { order: 2; flex: 1 1 45%; max-width: none; }`
- 但 `public/chat.html:162-172` 的**基础规则**写在 media query **之后**，
  其中 `max-width: 38vw` 同特异性、后出现 → 覆盖了 `max-width: none`

实测标题实际宽度恒等于 0.38×vw：375→142.5px、393→149.3px、430→163.4px，
「multicc / 产品 · UI · UX」被截断，而同一行右侧有 ~200px 空白。
修法：把基础规则移到 media query 之前，或给移动端规则加权重。

### P1-3 · manage/provider「新增 provider」别名行横向溢出

- `public/manage.html:1234` — `<div id="prov-new-alias-row" class="setting-row" style="align-items:flex-start">`
- 基础 `.setting-row{display:flex;align-items:center;gap:14px}`（`manage.html:433-435`）
- 移动断点 `.setting-row{flex-direction:column;align-items:stretch;gap:5px}`（`manage.html:540-541`）
- **inline style 的 `align-items:flex-start` 优先级高于 media query**，column 方向下
  子块退化为 max-content 宽 → 撑破容器

实测：容器 375/430，内容右边缘 R553 → **溢出 178px（@375）/ 123px（@430）**。
受影响：`#prov-new-alias-opus-model` / `-sonnet-` / `-haiku-` / `-fable-model` 四个输入框
及其说明文字。修法：去掉 inline style，或在移动断点用 `align-items:stretch !important`。

### P1-4 · provider 卡片信息列被挤成每行 2–4 字

- `public/manage.js:2562-2573` — 单行 `display:flex; gap:10px`，
  左侧信息列 `flex:1;min-width:0`，右侧 4 个按钮（余量/测速/编辑/删除）不收缩

按钮组固定占 ~250px，339px 的行宽下信息列只剩 ~90px，于是
「来自 cc-switch · 可用于 Claude / OpenCode」被折成每行 4 个字，配额数字更是逐字换行。
Chrome 393 与 iOS 模拟器真机一致复现（`/tmp/ch393-prov.jpg`、`/tmp/ios-prov.jpg`）。
修法：窄屏 `flex-wrap:wrap` 让按钮组独占一行，或折进 ⋯ 菜单。

### P2-1 · `.prov-tabs` 一行放不下且无滚动提示

`public/manage.html:428` — `flex-wrap:nowrap; overflow-x:auto`（可横滚，但滚动条隐藏）。
430 视口只露到「OpenAI Cha…」，ZCode / Kimi / 统计用量在屏外，**没有任何可发现性提示**。
修法：右侧渐隐遮罩 / 箭头，或窄屏改 `flex-wrap:wrap`。

### P2-2 · manage/tunnel `#tnl-ts-restart`「重连控制面」按钮溢出（仅 @375）

实测 L313 R409 / vw375 → 右侧越界 34px。430 及以上不复现。

### P2-3 · 触控目标普遍小于 44×44（全站）

| 区域 | 控件 | 实测 |
|---|---|---|
| 全局 | `#nav-toggle` / `.lang-toggle` | 40×40 |
| 全局 | `.btn.primary`（＋新建 Fleet） | 78×42 |
| 全局 | `.btn-icon` / `.aux-cls-more` | 30×30 / 31×16 |
| chat header | `#reconnect-btn` `#cli-btn` `#header-more-btn` `#merge-btn` | 40–87 × **40** |
| chat 输入栏 | `#mic-btn` `#attach-btn` `#goal-btn` `#send-btn` `#cancel-btn` | 44×**40** |
| chat 底部 | `#ac-cancel-task` / `#claude-rate-limit-bar` | 51×19 / 116×**18** |
| chat 底部 | `#merge-hint-collapse-btn` / `#danmaku-collapse-btn` | 18×18 / 17×17 |
| chat 消息 | `.msg-del` / `.msg-fork` | 20×20 |
| chat 弹层 | `#diff-min-btn` `#diff-close-btn` / `#dbg-close` | 28×28 / 24×20 |
| 复选框 | 所有 `input[type=checkbox]` | **13×13** |
| meta | `.tb-reclassify` / `.tb-quick-archive` / `summary` | 34–75 × **17–18** |
| wechat | `#cfg-toggle` / `.logo` | 12×18 / 62×18 |

最该先修的是 18px 高那一档（配额条、两个收起按钮、meta 行内按钮）和 13×13 的复选框。

### P3-1 · 文案缺陷：「当前 worktree 有**有**未提交改动」

- `public/i18n.js:76` — `worktreeMergeable: '当前 worktree 有{detail}，可合并回 {base}。'`
- `public/i18n.js:58` — `dirtyChanges: '有未提交改动'`
- 拼接处 `public/chat.js:1093-1102` `mergeStatusText()` → 「有」+「有未提交改动」

修法：模板改成 `当前 worktree {detail}，…`，或 `dirtyChanges` 去掉「有」。
英文串（`i18n-catalog.js:858`）无此问题。

### P3-2 · `?view=<v>` 进入 manage 时页头标题不跟随

`public/manage.html:2159-2163` 用 query param 调 `setView()`，但页头 crumb 仍显示「概览」。
用 JS 直接调 `setView('provider')` 时又显示原始 key「provider」而非本地化名称。
App 内跳转/深链走的正是这条路径。

## 4. 确认干净的部分（同样是结论）

- **chat 消息内容渲染全部正常**：长代码块 `pre{overflow-x:auto}`（sw 1957 > cw 319，可横滚）、
  宽表格同样可横滚（sw 571）、裸长 URL 与 160 字无空格长串靠 `overflow-wrap:break-word`
  正常折行、`width:1400px` 的超宽图被钳住；文档 `scrollWidth == clientWidth`，**无页面级横向溢出**。
- **chat 15 个弹层 / picker 全部无溢出**（含 voice / cli / effort / provider / ai-config / message-picker）。
- **manage 23 个弹层全部无溢出**（含 session-modal 内嵌 iframe、dir-detail、git-tree、diff）。
- **manage 除 provider / tunnel 外 11 个视图无溢出**。
- **meta / memo / events / share / wechat / 终端页无溢出**（问题只在触控目标）。
- 横屏下 manage 各视图无溢出（宽度充裕）。

## 5. 建议的修复顺序

1. P0-1 chat 底部分层：给 merge-hint / pill 行 / 配额条一套明确的堆叠与让位规则（同一列纵向排布，或 merge-hint 默认收起成一个小徽标）。
2. P0-2 chat.html 补 `height:100vh; height:-webkit-fill-available; height:100dvh;`，与 manage.html 对齐。
3. P1-2 `#session-title` 的 CSS 源序（一行改动，收益立竿见影）。
4. P1-3 / P1-4 provider 页两处（去 inline style + 按钮组换行）。
5. P2-3 触控目标：先把 ≤20px 高的一档抬到 44。
6. P3 文案与标题同步。

## 6. 证据索引

| 文件 | 内容 |
|---|---|
| `/tmp/ios-chat.jpg` | iOS 模拟器真机 · chat 底部重叠 + 输入栏被切 |
| `/tmp/ios-prov.jpg` | iOS 模拟器真机 · provider 卡片信息列被挤 |
| `/tmp/se-chat.jpg` | Chrome 375 · 底部三层重叠 |
| `/tmp/land-chat.jpg` | Chrome 932×430 横屏 · 消息区只剩 142px |
| `/tmp/ch393-prov.jpg` | Chrome 393 · provider 卡片 + tab 条截断 |
| `/tmp/aud-*.json` | 各视口 / 各视图的结构化审计结果 |
