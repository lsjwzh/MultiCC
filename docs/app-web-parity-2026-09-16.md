# App ↔ Web UI 对齐走查（2026-09-16）

目标是「把 Flutter App 的功能与 UI 尽量做得和 Web 一样」。本文记录**取证方式**、
**已对齐的部分**和**仍然没对齐的清单**。产品代码改动见同一提交。

## 1. 先解决取证：App 侧怎么截图

这台机器是 headless 会话：Simulator 没有可点的窗口（`System Events` 读到的窗口数是 0、
`screencapture` 全黑），`idb` 未安装，所以**无法从宿主点模拟器**。可用的两条路：

| 轨道 | 用途 | 手段 |
|---|---|---|
| `integration_test` 在设备内注入点击 | App 侧逐屏取证 | `app/integration_test/ui_tour_test.dart` |
| `xcrun simctl io booted screenshot` | 抓真实渲染帧 | 宿主侧 1~1.5s 一轮的截图循环 |

```bash
# 宿主侧先开截图循环（写 /tmp/<dir>/<epochMs>.png）
node -e 'const{execFileSync}=require("child_process");for(;;){execFileSync("xcrun",["simctl","io","booted","screenshot","/tmp/shots/"+Date.now()+".png"]);execFileSync("sleep",["1"])}'
# 再跑巡游：每个点位驻留 4s，并打印 SHOT:<name>:<epochMs>
cd app && flutter test integration_test/ui_tour_test.dart -d <UDID> \
  --dart-define=SKIP_NOTIF_PROMPT=true \
  --dart-define=MULTICC_SIM_URL=http://127.0.0.1:3000 \
  --dart-define=MULTICC_SIM_TOKEN=<token>
```

巡游里的 `SHOT:` 时间戳与截图文件名同源（同一台机器的时钟），按最近时间即可把 PNG 命名成
`01-home / 02-sidebar / 03-task-details / 06-task-graph / 07-memory-graph / 04-chat /
05-chat-actions`。

**七个点位现在都是真的**（2026-09-16 第二轮：`04-chat` 那一跳已修好；第三轮：`06`/`07` 的
抽屉点击不再被引导浮层吃掉）。五个坑，都踩过：

1. **任务行要挑「有会话的」。** 首页那份列表带着归档行，而归档/observed 记录没有可续接的
   会话 —— 点它只会弹一句错误，停留首页。巡游现在优先选 `!readOnly && sessionId != null`
   的那一行，找不到才退回第一行（`_openableTaskTile`）。
2. **聊天页是「等出来的」，不是「等一会」出来的。** 点任务行要等 `AirService.openTask()`
   往返一次，聊天页才作为底部 sheet 挂上来。原来的固定 12s 延迟撞上慢请求就什么都没抓到，
   现在改成轮询 `find.byType(ChatView)`（`_waitFor`，最多 25s），失败时把可见的错误文案打
   出来（`_visibleError`）。
3. **聊天页头那颗 overflow 菜单是 ⋯（`Icons.more_vert`），不是横向的 `more_horiz`；
   而且新手引导浮层会盖在聊天页上**（第 3/4 步正好挡住输入区和消息区），所以打开聊天页
   之后要再点一次「跳过」（`_skipOnboarding`）。
4. **iOS 通知权限弹窗会盖住整屏且没人能点。** 集成测试必须带
   `--dart-define=SKIP_NOTIF_PROMPT=true`（`NotificationService.init()` 会整段跳过）。
   已经挂起的弹窗重启模拟器即可清掉：`xcrun simctl shutdown <UDID> && xcrun simctl boot <UDID>`。
   另外 `flutter test` 走的是一次全新安装，App 的服务器配置会回到「连接到 MultiCC」页，
   所以巡游自己会填 URL/令牌再点「验证并连接」。
5. **新手引导卡片是「异步挂上来」的，用固定延迟点它就是竞态。** 第二轮那版在开屏后固定等
   8 秒就去点一遍「跳过」——热容器（没有连接页要填）时卡片还没挂上，那一遍点了个空，
   卡片随后才出现，**它的 scrim 从此吃掉侧栏的所有点击**：抽屉打开看着正常，
   `06-task-graph`/`07-memory-graph` 却都报 `up:false`。现在 `_dismissOverlays()` 先
   轮询等它出现（首页那次给 15s，之后每次进抽屉再复查一遍），再点到它消失为止。

**跑完巡游要记得把正式包装回去**：`flutter test integration_test/...` 装进模拟器的是测试宿主
包（单独启动会停在启动画面）。`flutter build ios --simulator --debug` 出来的
`build/ios/iphonesimulator/Runner.app` 才是能独立运行的那个；`simctl install` 覆盖安装即可，
服务器地址/令牌要重新填（或像本轮一样直接写进容器的 preferences）。

Web 侧参考帧用无头 Chrome 按同一视口取：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=2 --window-size=430,932 --virtual-time-budget=8000 \
  --user-data-dir=/tmp/chrome-parity --screenshot=/tmp/web/air.png \
  "http://127.0.0.1:3000/air?view=overview&token=$ACCESS_TOKEN"
```

注意：**图谱那一页现在在 `/air?view=taskgraph`**，`/manage?view=taskgraph` 会被 302 到
`/air?view=overview`（本轮修掉的一个真 bug，见 §3）。

## 2. 第一轮对齐的三处

1. **Air 侧栏补「任务图谱」。** Web 的 `#side-more .global-links` 是四项
   （服务与文档 / 记忆图谱 / 任务图谱 / 设置中心，`public/air.html:74-79`），App 少第四项。
2. **聊天页 ⋯ 菜单补「语言切换」「任务提醒」。** Web Air 模式的菜单项顺序见
   `public/chat.js:252-266`。语言写 `localStorage['multicc_lang']`，任务提醒写
   `localStorage['multicc_notify:<sessionId>']`，没有后端接口。
3. **目录统计卡改成 Web 的四张。** `public/air.js:381-398` 的 `renderDirectoryOverview()`。

## 3. 第二轮补齐 / 修掉的东西（2026-09-16）

1. **原生任务图谱页**（原第 4 节第 1 条，最大的一处缺口）。
   - 新增 `app/lib/services/task_graph_service.dart`（`GET /api/task-graph`）与
     `app/lib/screens/task_graph_screen.dart`（力导向 + 平移缩放 + 项目筛选 + 节点详情），
     逐项对着 `public/task-graph.js` 实现。
   - 侧栏「任务图谱」不再开外部浏览器，走原生路由；节点详情里的「在 Air 打开」把
     `(dirId, taskId)` 交回宿主，先切目录再走和任务行完全相同的打开链路。
   - 有意偏离 Web 的一处（写在代码注释里）：图例固定画全套 6 个 classify 色（Web 只画
     当前子图出现过的）—— 手机上切项目时布局不跳动，而且「图例齐、节点不全」本身就是信息。
     本轮另外补掉的「拖动节点固定」「缩放级标签」见 §4.3 / §4.4。
2. **聊天页「任务提醒」补三态与权限语义。** Web 的 `#notify-btn` 会区分
   「系统通知已开启 / 点击开启系统通知 / 已关闭」（`public/chat-notifications.js:78-86`），
   而且打开开关时会去申请系统通知权限、用户拒绝就把开关**回滚成关闭**
   （同文件 96-125 行）。App 原来只有布尔 ✓/✕、点了也不申请权限；现在三态文案与 Web
   逐字一致，点开时申请权限、被拒回滚并给出提示。
   顺带改掉一个与 Web 不一致的行为：**冷启动不再无条件申请通知权限**
   （Web 只在用户主动打开 `#notify-btn` 时申请，`public/pwa.js:224`）。
3. **Air 顶部状态徽标变成可点。** Web 的 `#task-state` 是按钮
   （`public/air.js:1835` 接到当前任务详情）。App 首页没有「当前打开的任务」这一层，
   照搬就得替用户猜一个任务，所以这里点开的是那个数字本身：**本目录正在执行的任务清单**，
   每一行仍走同一套打开链路。
4. **修掉一个真 bug：App 的「任务图谱」入口其实只落到控制台。**
   `/manage?view=taskgraph` 现在被 302 到 `/air?view=overview`（其余 view 都保留，
   只有 taskgraph 被映射掉了），所以原来那颗入口点开看到的是控制台。
   图谱改走原生页之后这个入口不再依赖那张映射表；同时把「记忆图谱」的网页入口从
   `/manage?view=memory` 直接改成终点 `/air?view=memory`（少一跳兼容跳转）。

## 4. 第三轮：原生记忆图谱 + 共用图谱画布（2026-09-16）

1. **原生记忆图谱页**（Air 侧栏「记忆图谱」不再开外部浏览器）。
   - `app/lib/services/memory_graph_service.dart`（`GET /api/memory/graph`）+
     `memory_file_service.dart`（`GET/PUT/DELETE /api/memory/file`）+
     `app/lib/screens/memory_graph_screen.dart` + `memory_file_editor_screen.dart`，
     对着 `public/memory-graph.js` / `memory-model.js` / `memory-controller.js` 实现。
   - 项目筛选与 Web 同规则：`node.dirId === target || scope ∈ {machine, cli}`
     （`public/memory-graph.js:136`）—— 全局层不随项目切走。
   - 图例只画**当前子图出现过**的类型与作用域（`renderLegend()` 逐字对齐）。这点和任务
     图谱的选择相反（§3.1）：记忆图谱的 KIND/SCOPE 档数多，全画会占掉半屏。
   - 文件编辑器照抄 Web 的三条安全语义：超过 20 万字符只读；读取失败禁用保存；404 视为
     「保存后创建」。删除要二次确认；返回时若有未保存改动先拦一道；改动过就回图谱重取。
2. **抽出共用图谱画布** `app/lib/widgets/graph/graph_canvas.dart`（857 行）。两张图谱页
   原来各写一份力导向 / 手势 / 命中 / 视图换算；现在 `GraphLayout`（物理 + 视图，纯计算）、
   `GraphCanvasController`（帧驱动、手势、命中）、`GraphPainter`（画线 / 画点 / 标签 /
   箭头 / 虚线）都只有一份，页面只交 payload 和各自的 painter。
   `task_graph_screen.dart` 因此从 1,527 行回到 1,034 行。
3. **补上「拖动节点固定」**（原「还没对齐」第 2 条的一半）。手指把节点拖到哪它就钉在哪，力导向
   不再挪它（Web `if (a.pinned) continue`，`task-graph.js:215`），并按 Web 的手感
   `startSim(0.25)` 抖一下让邻居让位。两页都加了「重置视图」按钮
   （Web 的 `#tg-reset-view` / `#mg-reset-view`）：松开所有钉住的节点并重新适配。
4. **补上「缩放级标签」**（原「还没对齐」第 2 条的另一半）—— 这条是 App 侧的设计，Web 没有对应
   的抽稀：Web 给每个节点都建 `<text>`，只靠 `opacity: degree > 0 ? 0.95 : 0` 决定显不
   显示（`task-graph.js:279` / `memory-graph.js:273`），手机上缩到 0.3 倍就是几百个标签
   糊成一片。App 按缩放档位抽稀：`≥1.2` 全标、`≥0.8` 只标 `degree ≥ 1`、`≥0.5` 只标
   `≥3`、`≥0.3` 只标 `≥5`、再小只标 `≥8`（`GraphLayout.labelMinDegreeFor`）；节点数超过
   1,200 就整体不建标签（任务图谱原来是 400 且只按 `degree > 0` 判）。
   为了让「放大到位就一定看得到孤立节点的标题」成立，捏合上限回到 Web 的 `0.2..4`
   （`task-graph.js:380`）；首次装载 / 双击的 `fitView()` 仍按 Web 夹 `0.2..2`
   （`task-graph.js:313`）。

## 5. 还没对齐（按优先级，均已核实到代码）

1. **通知权限状态有「延迟一拍」**：⋯ 菜单是同步构建的，而系统权限查询是异步的，所以 App
   维护了一份同步缓存，展开菜单时 fire-and-forget 刷新。用户在系统设置里刚改过权限时，
   第一次展开可能仍显示旧值（`NotificationService.permissionGranted` 的注释里写了取舍）。
2. **归档场景的入口差异**：Web 的任务详情动作条有「移动到其他目录…」，App 已在第一轮补齐；
   但 Web 控制台里跨目录的批量操作 App 没有对应容器。

## 6. 回归

```bash
cd app && flutter analyze            # 仅存量 info，无 error/warning
cd app && flutter test               # 962 项全绿
npm run test:architecture            # 55 项（含行数/字节预算门）全绿
```

本轮新增的测试：`app/test/graph_canvas_test.dart`（11 项，缩放级标签分档 / 拖动固定 /
拖后吞 tap / `resetView` / `zoomAt` 夹取 / 命中 / 适配）、`app/test/memory_graph_screen_test.dart`
（12 项）、`app/test/memory_file_editor_screen_test.dart`（9 项），`task_graph_screen_test.dart`
补 2 项。巡游脚本加了 `07-memory-graph` 点位。

巡游脚本不进默认门（要真机/模拟器 + 活服务），只在做对齐取证时手动跑。
