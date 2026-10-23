# plugins/ —— MultiCC 插件目录

这个目录放**自包含插件**：一个插件 = 一个文件夹，复制进来即安装、删掉即卸载，
插件代码与主程序代码完全隔离（按 AGENTS.md 的后端语言规则，插件的可执行部分
用 Rust 实现；主程序只提供一条协议通道）。

> 目录里的 `bridges/`、`cron/`、`utils/`、`voice/` 是主程序内部模块的历史
> 位置，**不是**插件（没有 plugin.json，通道不会把它们当插件暴露）。

## 安装 / 卸载

```bash
cp -R <某个插件文件夹> plugins/     # 安装
rm -rf plugins/<插件id>             # 卸载
```

不需要重启：Air「资料与插件 → 插件」面板每次打开都会重新读清单。入口在
侧栏「资料与插件」区（`资料与插件 → 插件`）。

git 只跟踪这里的内置项（本 README、上面四个内部目录、`chrome-proxy-launcher/`）：
复制进来的插件属于本机数据，默认被根目录 `.gitignore` 的 plugins 白名单忽略，
不会让检出变「脏」。要把一个插件做成内置插件随仓库发布，在那段白名单末尾加一行
`!/plugins/<插件id>/`。

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
| `commands` | 允许调用的子命令白名单（通道强制校验） |
| `ui` | 面板页相对路径；只有该文件所在子树会通过 HTTP 暴露 |

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
