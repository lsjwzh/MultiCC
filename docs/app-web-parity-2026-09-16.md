# App ↔ Web UI 对齐走查（2026-09-16）

目标是「把 Flutter App 的功能与 UI 尽量做得和 Web 一样」。本文记录本轮**取证方式**、
**已对齐的三处**和**仍然没对齐的清单**。产品代码改动见同一提交。

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
`01-home / 02-sidebar / 03-task-details / 04-chat / 05-chat-actions`。

两个坑，都踩过：

1. **iOS 通知权限弹窗会盖住整屏且没人能点。** 集成测试必须带
   `--dart-define=SKIP_NOTIF_PROMPT=true`（`NotificationService.init()` 会整段跳过）。
   已经挂起的弹窗重启模拟器即可清掉：`xcrun simctl shutdown <UDID> && xcrun simctl boot <UDID>`。
2. `flutter test` 走的是一次全新安装，App 的服务器配置会回到「连接到 MultiCC」页，
   所以巡游自己会填 URL/令牌再点「验证并连接」。

Web 侧参考帧用无头 Chrome 按同一视口取：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=2 --window-size=430,932 --virtual-time-budget=8000 \
  --user-data-dir=/tmp/chrome-parity --screenshot=/tmp/web/air.png \
  "http://127.0.0.1:3000/air?view=overview&token=$ACCESS_TOKEN"
```

## 2. 本轮对齐的三处（都给了 Web 出处）

1. **Air 侧栏补「任务图谱」。** Web 的 `#side-more .global-links` 是四项
   （服务与文档 / 记忆图谱 / 任务图谱 / 设置中心，`public/air.html:74-79`），App 少第四项。
   App 目前还没有原生任务图谱渲染器，因此沿用「记忆图谱」既有的做法先开 Web 页
   （`public/task-graph.js`，数据来自 `GET /api/task-graph`）。
2. **聊天页 ⋯ 菜单补「语言切换」「任务提醒」。** Web Air 模式的菜单项顺序见
   `public/chat.js:252-266`，App 除了 `lang-btn` / `notify-btn` 都在。两者都是**纯本地状态**：
   语言写 `localStorage['multicc_lang']`（`public/i18n.js:209-216`，App 侧即
   `SettingsService.setLanguage`），任务提醒写 `localStorage['multicc_notify:<sessionId>']`
   （`public/chat-notifications.js:66-135` + `public/pwa.js:18-38`），没有后端接口。
   开关同时决定 App 侧两条通知通道是否静音。
3. **目录统计卡改成 Web 的四张。** `public/air.js:381-398` 的
   `renderDirectoryOverview()` 是 进行中（`N 个正在执行`，blue）/ 计划任务（`待开始或继续规划`）/
   已完成（`仍保留在本目录`，green）/ 全部记录（`N 个已归档`）。App 原来显示的是
   任务 / 未完成 / 执行中 / 待回答 —— 同一份快照在两端会得出四个不同的数字。

## 3. 后续补上的两处

1. **任务生命周期操作**（原第 1 条）。Web 的任务详情动作条是
   恢复任务 / 归档任务 / 移动到其他目录… / 删除任务…（`public/air.js:1207-1274`），
   三条路由也都在服务端（`/api/task-board/tasks/:id/status|relocate`、`DELETE :id`，
   `src/routes/task-board.js:2893-2902`）。App 侧补齐：`AirService.setTaskLifecycle` /
   `relocateTask` / `deleteTask`（错误码经 `airTaskActionErrors` 翻成中文，与 Web 的
   `TASK_ACTION_ERRORS` 同一张表），`air_task_details.dart` 里的动作条与
   移动/删除确认弹层；归档、移动、删除之后各自由宿主决定是刷新、跟着挪过去还是关掉面板。
2. **首页任务面板抬头。** Web 是 `当前目录` + 粗体 `最近任务` 两行标题、右侧
   `N 个任务`，列表按 `updatedAt` 倒序**截到 6（≤760px）/ 10 行**，截掉的那些交给底部
   `查看全部 N 个任务 ›`（`public/air.js:381-422`、`public/air.html:168-174`）。
   App 照这个形状改：抬头换成同一段两行标题 + 计数，筛掉的「未完成 / 全部」两条 chip
   撤掉（Web 这份列表本来就带着归档行），截断线跟着屏宽走，底部那颗按钮承担原来
   「全部」的出口 —— Web 点它去控制台那份完整清单，App 没有第二个容器，就地展开。

## 4. 还没对齐（按优先级，均已核实到代码）

1. **原生任务图谱**：Web 是 `public/task-graph.js`（力导向 + 平移缩放 + 节点详情）。
   App 现在是开外部浏览器。
2. **聊天 ⋯ 菜单的推送订阅态**：Web 的 `notify-btn.title` 会区分
   「系统通知已开启 / 点击开启系统通知」（`public/chat-notifications.js:74-88`），
   App 只做布尔 ✓/✕，点开关不会顺带申请系统权限。
3. **Air 顶部状态徽标不可点**：Web 的 `#task-state` 是按钮，点了展开任务详情
   （`public/air.js:1835`）；App 的 `AirStatusBadge` 没有点击目标。App 头部这一行表达的是
   「本目录有几条在跑」，没有 Web 那种「当前打开的任务」概念，照搬会变成猜一个任务，
  所以本轮没动。

## 5. 回归

```bash
cd app && flutter analyze            # 仅存量 info，无 error/warning
cd app && flutter test               # 906 项全绿
```

巡游脚本不进默认门（要真机/模拟器 + 活服务），只在做对齐取证时手动跑。
