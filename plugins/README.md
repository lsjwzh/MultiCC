# plugins/ —— MultiCC 插件目录

这个目录放**自包含插件**：一个插件 = 一个文件夹，复制进来即安装、删掉即卸载，
插件代码与主程序代码完全隔离（按 AGENTS.md 的后端语言规则，插件的可执行部分
用 Rust 实现；主程序只提供一条协议通道）。

> 目录里的 `bridges/`、`cron/`、`utils/`、`voice/` 是主程序内部模块的历史
> 位置，**不是**插件（没有 plugin.json，通道不会把它们当插件暴露）。

## 安装 / 卸载

随 MultiCC 发布的**内置插件**在这个目录里，被 git 跟踪（`.gitignore` 末尾的白名单）。
另外安装的插件放在用户目录 `~/.multicc/plugins/`；设了 `MULTICC_DATA_DIR` 的实例
（比如桌面版，它的程序目录只读）用各自数据目录下的 `plugins/`。

自己的私有插件直接复制进这个目录也可以，升级不会丢：
- 源码运行：被 `.gitignore` 忽略，`./multicc update` 不碰它；打包脚本也不会把没被 git
  跟踪的插件打进安装包（`scripts/desktop-bundle-server.js` `untrackedPlugins`）。
- 独立包：升级会整包替换程序目录，但 install.sh、install.ps1 和 `multicc update`
  都会在删掉旧版本前，把旧包没有自带的插件原样复制到新版本
  （`scripts/standalone-cli.js` `carryUserPlugins`）。新版本恰好内置了同 id 的插件时
  以内置为准，你的那份备份到数据目录的 `plugins-backup/`；复制失败时旧版本整个留在
  磁盘上，不删。

```bash
cp -R <某个插件文件夹> ~/.multicc/plugins/   # 安装
rm -rf ~/.multicc/plugins/<插件id>           # 卸载
```

同一个 id 两边都有时以内置为准，面板上会提示冲突。不需要重启：Air「资料与插件 →
插件」面板每次打开都会重新读清单。

面板同时读 GitHub 上的插件列表 [lsjwzh/multicc-plugins](https://github.com/lsjwzh/multicc-plugins)
（带签名，格式见那边的 README 和 `docs/plugin-catalog-design.md`），把每个插件分成
内置 / 已安装 / 可更新 / 可安装 / 不支持本机 / 已装但不兼容，并写出第一条不满足的要求。
列表里的插件可以在面板上一键安装、更新、卸载，更新后还能退回上一个版本（只能在这台电脑上
操作，手机和远程页面只能看）。装到上面的用户目录，下载包按列表里的 sha256 核对；卸载只删
程序，`~/.multicc/plugins-data/<插件id>/` 里的设置和记录保留。发布一个可另外安装的插件：
在列表仓库运行 `node scripts/release.js <插件目录>`，见那边的 README。

git 只跟踪这里的内置项（本 README、上面四个内部目录、`chrome-proxy-launcher/`）：
复制进来的插件默认被根目录 `.gitignore` 的 plugins 白名单忽略，不会让检出变「脏」。
要把一个插件做成内置插件随仓库发布，在那段白名单末尾加一行 `!/plugins/<插件id>/`，
并在插件列表里把它登记为 `builtin`。

## 插件规范

```
plugins/<id>/
├── plugin.json          # 清单（必需）
├── bin/                 # 可执行文件（必需；Rust 构建产物）
│   ├── darwin-arm64/<name>
│   ├── linux-x64/<name>
│   └── <name>           # 当前平台的兜底路径
├── ui/index.html        # 面板页（可选；iframe 嵌入 Air）
├── Cargo.toml + src/    # Rust 源码（随插件发布）
└── README.md
```

`plugin.json` 字段：

| 字段 | 说明 |
| --- | --- |
| `schema` | 固定 `1` |
| `id` | 与目录名一致，`[a-z0-9][a-z0-9._-]*` |
| `name` / `nameEn` | 显示名（`nameEn` 是英文界面降级位，可省） |
| `version` / `description` / `icon` | 展示信息 |
| `engine.type` | 目前只有 `command` |
| `engine.binary` | 可执行文件相对路径 |
| `engine.binaryPlatformDir` | 跨平台产物目录（通道先试 `<dir>/<platform>-<arch>/<basename>`） |
| `engine.resident` | 可选，`true` 表示常驻插件：MultiCC 启动时拉起，见下文「常驻插件与通知渠道」 |
| `channel` | 可选，`{label, labelEn?, platforms?}`：声明这个常驻插件是一个通知渠道（推送设置、钩子只认这一项） |
| `commands` | 允许调用的子命令白名单（通道强制校验） |
| `ui` | 面板页相对路径；只有该文件所在子树会通过 HTTP 暴露 |
| `category` / `provides` | 可选。分组用的分类（`channel`、`browser`）和插件提供的能力（如 `channel`：可作提醒渠道） |
| `requires` | 可选，和插件列表里每个版本的 `requires` 同一格式：`multicc`（版本范围）、`pluginApi`、`agentBuild`、`platforms[{os, arch, minOS}]`、`apps[{id, name, minVersion}]`、`permissions`。装着的插件以这里为准判断兼容性 |

## 通信协议

**调用**（主程序 → 插件二进制）：

```
<binary> <command>        # JSON 从 stdin 读入，结果一行 JSON 写到 stdout
→ {"ok":true,"data":{…}}  # 成功
→ {"ok":false,"error":"…"} # 失败（退出码非 0）
```

主程序侧的通道（Node 只做桥接，无业务逻辑，见 `src/routes/plugins.js`）：

- `GET  /api/plugins` — 已装插件清单
- `POST /api/plugins/<id>/run` — body `{"command":"…","input":{…}}`，spawn
  插件二进制（不走 shell、20s 超时、命令白名单校验）
- `GET  /plugins/<id>/<ui 子树>` — 插件面板静态文件（受与主站相同的鉴权保护）

### 常驻插件与通知渠道

`engine.resident: true` 的插件由 MultiCC 在启动时拉起为常驻进程（`<binary> serve`，见
`src/plugins/channel-host.js`）：退出后按 1 秒、5 秒、30 秒、之后每 5 分钟退避重启，连续运行
满一分钟算恢复；插件被删掉、换了版本或换了程序文件，30 秒内停掉或换新；本机不满足
`channel.platforms` / `requires.platforms` 的不拉起。常驻插件的面板命令（`/api/plugins/<id>/run`）
不再每次启动程序，转给常驻进程；超过 20 秒的操作由插件自己返回任务编号，面板再轮询。

常驻进程和 MultiCC 走它的标准输入输出，每行一个 JSON：

```
MultiCC → 插件  {"id":7,"type":"run","command":"health","input":{…}}
                {"id":8,"type":"targets"}               渠道插件：接收人列表
                {"id":9,"type":"deliver","target":"…","source":"push:<订阅>"|"hook:<规则>",
                 "sessionId":"…","taskName":"…","project":"…","category":"error",
                 "summary":"…","occurredAt":…,"dedupKey":"<sessionId>:<category>"|null}
                                                        渠道插件：投递一件事，只入队、回投递编号
插件 → MultiCC  {"id":7,"ok":true,"data":{…}}  或  {"id":7,"ok":false,"error":"…"}
                {"event":"hello","protocol":1,"version":"0.1.0"}     启动后就绪时发一次
                {"event":"alert","key":"agent-permissions","level":"warn"|"critical","title":"…","body":"…"}
                {"event":"alert","key":"agent-permissions","resolved":true}   问题消失
                {"event":"alert",…,"replay":true}   重启后补报已推送过、还没恢复的问题（只上页面）
```

- 标准输入读到结束（MultiCC 退出、重启或停掉插件）时，插件要自己退出。
- 环境变量：`MULTICC_PLUGIN_ID`、`MULTICC_PLUGIN_DATA_DIR`（插件自己的数据目录，
  `~/.multicc/plugins-data/<id>/`）、`MULTICC_BASE_URL`（本服务地址，本机请求不用口令）、
  `MULTICC_PLUGIN_PROTOCOL`（目前是 `1`）。
- 告警交给推送的现有渠道（网页推送、FCM、Bark、Webhook）；同一个 key 恢复之前只发一次，
  每个插件每小时最多 10 条。插件停了一分钟还没回来，MultiCC 替它报一条 `plugin-down`。
- `GET /api/channels`：常驻插件是否在运行、未恢复的告警、面板地址 `ui`，渠道插件另有
  `inUse`（有推送订阅或钩子在用它）；`GET /api/channels/targets`：各渠道插件的接收人
  （`targets` 回 `{"targets":[{"id","name","status"}]}`，只有 `status` 为 `active` 的才真发）。
- **投递**（`deliver`）：推送设置「插件渠道」一栏的订阅（`src/push/channel-subscriptions.js`）
  和钩子的「发到渠道」动作（`src/events/actions.js`）都经 `src/plugins/channel-registry.js`
  交给插件。`category` 只有 `done`、`question`、`background`、`error`、`test` 几种；
  `dedupKey` 是「任务 + 类别」，同一件事从订阅和钩子同时到同一个接收人时插件只留一条。
  插件回 `{"deliveryId":…}`（或 `{"queued":false,"suppressed":true}`）就算交付成功，合并、
  去重、限频、重试和发送记录都在插件里。服务重启打断的回合（`cancel_shutdown`）不投给渠道。
- **发送前复核**：插件真要动手之前可以 `POST /api/channels/recheck`
  `{"items":[{"sessionId","category"}]}`（只收本机请求），回
  `{"items":[{"sessionId","category","active":true|false}]}`：`false` 表示问题已经解决
  （任务不在了，或者它现在的状态已不是这一类），插件应把这条从正文里去掉，全去掉就取消。

**插件 UI**（ui/index.html ↔ 通道）：同源页面，直接 `fetch('/api/plugins/<id>/run',
{method:'POST', body: JSON.stringify({command, input})})`；登录 cookie 由浏览器
自动携带。所有动态文本用 `textContent`，不要拼 `innerHTML`。

## 写一个新插件

1. 复制 `plugins/chrome-proxy-launcher/` 作为模板（或按上面规范新建）；
2. 改 `plugin.json`（id、命令白名单、UI 路径）与 Rust 源码；
3. `cargo build --release`，产物放进 `bin/<platform>-<arch>/`；
4. 复制整个文件夹到 `plugins/`（或就地开发——就在这个目录里也行）。

第一个插件：**Chrome 隔离出口启动器**（`plugins/chrome-proxy-launcher/`）——
每个身份一份隔离 Chrome profile + 强制出口代理，详见它自己的 README。
