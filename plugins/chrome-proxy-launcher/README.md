# Chrome 隔离出口启动器（chrome-proxy-launcher）

MultiCC 第一个插件。给每个「身份」绑定：

- **一份完全隔离的 Chrome profile** —— 独立 `--user-data-dir`，cookie、登录态、
  扩展、缓存互不串号；
- **一个固定代理出口** —— `--proxy-server` 指到指定 http/https/socks5 代理，
  或身份专属 meow 内核承接的订阅节点。未配置 `DIRECT` 备用。

一键启动，一键停止；「测出口」显示该身份当前的外网 IP。
不同 profile 只隔离登录数据；若绑定同一节点，仍可能共用公网 IP。

## 代理故障与保护边界

固定单代理不可达时，受代理控制的网页请求失败，并不会自动改用直连。
启动探测用于提前报告不可达或认证错误，不是持续断网保护；`checkProxy: false`
只跳过探测，不移除固定代理。Chromium 行为说明：
https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md

新启动的浏览器附加以下约束：

- 禁止非代理 WebRTC UDP、关闭 QUIC。
- 移除 localhost / link-local 的隐式代理绕过。
- 限制 Chrome 本地域名解析，仅放行代理服务器自身的域名；HTTP / SOCKS5
  目标域名交给代理解析。代理服务器域名以及代理内核自己的 DNS 不在此限制内。

**这不是系统级防火墙保证**：不能约束上游代理自己的 DIRECT 分流、其他进程、
浏览器未受这些参数控制的流量或系统 DNS。严格隔离应在独立 VM / 网络命名空间
中默认拒绝出站，仅允许连接指定代理，并同时覆盖 IPv6、DNS、UDP。

移除本地绕过后，浏览器不能直接访问本机管理页和 OAuth localhost 回调；
需要本机回调的登录应使用粘贴回调地址的入口。参数对已运行实例不生效，升级后
请自行停止该身份再启动；插件不会强行关闭浏览器。

运行中的身份不能重复启动或修改出口，引用它的订阅也不能刷新：Chrome 会复用
旧实例而忽略新代理参数，重建随机端口将导致旧窗口断网。新窗口请在浏览器内打开。

中继和内核是独立子进程，**尚未注册系统托管服务**。关闭 MultiCC 页面不会停止
它们；关闭主进程后是否存活取决于服务管理器是否清理整个进程组。即使代理进程
退出，也不会移除 Chrome 的固定代理设置。独立守护只能提高可用性，不等于断网保护。

## 使用

入口：Air 侧栏「**资料与插件 → 插件 → Chrome 隔离出口启动器 → 打开**」。

1. 「探测本机代理端口」—— 扫常见本地出口（Clash 7897/7890/7891、v2ray
   10808/10809、通用 1080/8080…），点结果自动填端口；
2. 填身份名（如「美区店铺」）→ 保存；
3. 「测出口」确认这个身份的外网 IP；「启动浏览器」开一个隔离实例；
   「停止」结束该身份的实例。

## 原版 Chrome 的轻量指纹扩展

默认勾选「启动时自动加载轻量指纹扩展」。点击身份的「启动浏览器」即可：
Rust 自动准备该身份的扩展，通过私有匿名 CDP 管道等待 Chrome 确认加载，
然后打开指定网址。首次和重开都是同一流程，不需要进扩展页、选目录或手工更新。
不支持自动加载接口或被组织策略阻止时，启动明确失败，不静默跳过。

自动模式使用 `--no-startup-window`、`--remote-debugging-pipe` 和
`--enable-unsafe-extension-debugging`。不监听 TCP 调试端口，不修改系统 Chrome
签名，不禁用用户的其他扩展。常驻 Rust 监督进程持有管道，与一次性插件请求
分离；通过插件「停止」时发送 `Browser.close` 正常保存登录信息。
关闭 MultiCC 页面或发起请求的进程不会主动关闭这个监督进程；服务管理器若
终止整个进程组、系统退出或浏览器崩溃，仍可能一起退出。

**会话兼容边界**：保留登录态及会话 Cookie。为了让扩展先于网页运行，自动模式
打开指定网址（未指定则打开新标签），不会自动恢复上次的全部标签。
取消勾选自动指纹即可使用原来的普通启动方式（`automaticFingerprint:false`），
保留 Chrome 原生标签恢复；它不负责停用曾经手动安装的扩展。
本次打包并实测 macOS arm64 + 原版 Chrome 156；Unix 管道实现可供 Linux 构建，
但 Linux 尚未实测，Windows 自动模式明确报不支持，不伪报加载成功。
远程服务器上的插件不能给另一台电脑的 Chrome 自动安装扩展。

种子保存在 `fingerprints/<身份 id>/identity.json`，扩展目录在其下的 `extension/`。
首次生成后固定保存，重复生成、身份改名都不更换；损坏时明确报错，不自动重建。
不要把同一扩展目录加载到多个身份，也不要复制另一身份的种子。删除身份不会
删除这些文件（与保留 Chrome 登录目录一致）；新建同名身份也不会复用其种子。

本版范围：

- 在 HTTP/HTTPS 网页的 `document_start`、MAIN world 注入，包含匹配的 iframe。
- 对常见 Canvas 2D `getImageData`、`toDataURL`、`toBlob` 的像素读出做轻微且稳定的扰动。
- 对 WebGL / WebGL2 默认帧缓冲的常见 RGBA/UNSIGNED_BYTE `readPixels` 数组读出做同类扰动。
- 同身份、同网站 origin、同绘制内容复用相同扰动；不同身份采用不同随机种子。
  底层 Chrome、驱动和绘图内容更新仍可能改变结果。
- 绘图缓冲区保持原样，但导出图片的部分像素会有微小变化；需要精确原始像素的工作请停用扩展。

**不是完整指纹隔离**：Worker / OffscreenCanvas、GPU 型号、字体、音频、操作系统、
屏幕信息和网络协议指纹均不改写；特殊 WebGL 布局和不支持的像素类型保持原样。
网站仍可能检测脚本包装或通过其他特征关联身份。扩展不申请 Cookie、历史记录、
代理控制或调试权限，不上传数据；由于需要覆盖页面，其匹配范围是 HTTP/HTTPS 网站。
代理断开后的阻断仍由原来的固定代理机制负责，与扩展是否启用无关。

## 订阅节点与跳板链

「出口类型」选**订阅节点**后：

1. 在下面的「订阅管理」粘贴 Clash 订阅链接（v2rayN/Clash 通用格式；JSON、
   YAML、base64 包裹都认）→「添加订阅」，节点名会被缓存下来；已有订阅点
   「编辑」可改名或换地址（只改名不会重新拉取，token 失效也能改），
   「刷新」按原地址重新拉一次；
2. 身份里选一个节点。启动时插件会为这个身份生成一份**只含该节点**的配置，
   用插件自带的 meow 内核跑一个独立实例（随机端口、只听 127.0.0.1），Chrome 指向它；
3. 家宽 / 住宅代理的常见链路是「先有跳板才连得上」。勾上
   「经这个节点跳板，再到上游住宅代理」并填上游地址即可：

```
Chrome → 本地中继 → meow(跳板节点) → 上游住宅代理(可带账号密码) → 目标站
```

这条链由**插件自己的中继**串起来（内核只负责跳板节点）：中继先经跳板内核的
socks5 连到上游代理，再在上游上开隧道。这样凭据、失败报错、生命周期都在插件
手里，不依赖内核的 `dialer-proxy` 行为；上游不通时会明确拒绝启动，而不是
静默直连。

内核**随插件自带**：`bin/<平台>-<架构>/meow.gz`（本仓库带 darwin-arm64，
meow v0.26.1，MIT，许可与校验值见 `THIRD_PARTY.md`）。首次使用时自动解压到
`plugins-data/.../runtime/meow` 并复用，**不需要另装 Clash 或 mihomo**。其他
平台把官方 release 的单文件压缩成 `meow.gz` 放进对应 `bin/<平台>-<架构>/` 即可。

订阅原文与解析结果都只留在本机；订阅 URL 通常含 token，**不要提交进仓库**。

## 出口地理一致性（时区 / 语言自动跟随）

「中文系统 + Asia/Shanghai 时区 + 美国 IP」是风控触发人机验证最廉价的判据
之一。launch / probe 会经该出口请求一次 ip-api.com（明文 HTTP，限
45 次/分钟，每次启动只用 1 次），拿到出口的国家与时区后**只对这个实例**做
针对性配置。时区与语言全部来自这次实时识别，代码里不写死任何地区：

- **时区**：以进程环境 `TZ` 注入（Chrome 的 `Intl` / `Date` 立即跟随），
  覆盖扩展加载与身份窗口两个阶段。应答走明文、经代理转手，时区名先过
  白名单（只放行 `Region/City` 形态的字符，拒绝 `:` 开头、`..` 等会被
  libc 当成文件路径的写法），不合法就只放弃时区、语言照常套用；
- **语言**：按国家码映射 Chrome locale（约 50 个常用国家，见 `src/geo.rs`
  的 `locale_for_country`；出口在中国大陆时保持 `zh-CN`，表外国家一律
  `en-US`）。四处一起改：
  - `--accept-lang`：请求头 `Accept-Language` 与 `navigator.language(s)`，
    已用过的老 profile 同样生效；
  - 界面 locale：决定 `Intl` 默认 locale 与 `new Date().toString()` 里的
    时区名。macOS 版 Chrome 忽略 `--lang`，只认 Cocoa 的
    `-AppleLanguages (xx-YY)`（只作用于这个进程）；不改它会出现
    `navigator.language=en-US` 而 `Intl=zh-CN`、Date 里带「北美太平洋
    夏令时间」的自相矛盾。其他平台用 `--lang`；
  - 首次启动前预写 profile 的 `Default/Preferences`
    （`intl.accept_languages`，只在文件不存在时写，不覆盖用户选择）；
- **`--disable-blink-features=AutomationControlled`**：所有启动（含
  `automaticFingerprint: false`）统一追加，压掉 `navigator.webdriver`
  这个最显眼的「是机器人」标记。**不影响 CDP 控制**——私有管道
  （`--remote-debugging-pipe`）照常工作。

`-AppleLanguages` 的值 `(xx-YY)` 不以 `--` 开头，Chrome 会把它当网页打开
（实测多出一个 `http://(en-us)/` 标签页），所以它只交给带
`--no-startup-window` 的主进程，网页由第二次调用转发打开。自动指纹路径本来
就是这样的两阶段；普通启动只在 macOS 且套用了语言时才改走两阶段。两阶段
启动不会恢复上次的标签页（登录态 cookie 仍保留，`--restore-last-session`
在主进程上），自动指纹路径从 1.5.0 起即如此。

失败降级语义：geo 服务不可用时退回原有出口可用性验证（`exit_ip`），
只是**不套用时区/语言**，不阻塞启动；`checkProxy: false` 时跳过探测。
launch 返回的 `geo` 字段记录套用结果（`applied: true` + 国家/时区/locale，
或 `applied: false` + 原因），probe / egress(check) 同样返回 `geo`。

时长预算：宿主（`src/routes/plugins.js`）对每条插件命令有 20 秒硬超时，到点
直接 SIGKILL，会跳过插件里的所有清理、留下孤儿内核/中继。所以 launch 总预算
固定 18 秒，geo（≤4 秒）与出口验证都从剩余预算里切、并给浏览器启动预留
5 秒；geo 的读取同时受总时限与 64KB 上限约束，挡住慢速灌数据的应答。

注意这是「时区/语言一致性」，不是完整的反指纹伪装：Canvas、字体、WebGL
等指纹面仍由轻量指纹扩展负责；出口 IP 本身的类型（住宅 / 机房 / 商用）
也不在插件能改的范围内。

## 数据落盘

全部在 `~/.multicc/plugins-data/chrome-proxy-launcher/`：

- `profiles.json` —— 身份清单（原子写）
- `subscriptions.json` + `subscriptions/<id>.yaml` —— 订阅清单与拉取到的配置原文
- `run/<id>.pid` —— 运行中的实例 pid
- `run/<id>.core.pid` / `run/<id>.core.json` —— 订阅出口的 meow 内核
- `run/<id>.relay.json` —— 本地中继的 pid 与端口（有中继时才有）
- `runtime/meow` —— 从插件自带 `meow.gz` 解压出来的内核（可随时删除，会自动重建）
- `core/<id>/` —— 每个身份的内核工作目录（`config.yaml`、`core.log`）
- `chrome-profiles/<id>/` —— 每个身份的 Chrome user-data-dir（删除身份时
  **保留**，cookie 等敏感数据不自动清理，需手动删）

## 构建

```bash
cd plugins/chrome-proxy-launcher
cargo build --release
mkdir -p bin/darwin-arm64 && cp target/release/chrome-proxy-launcher bin/darwin-arm64/
```

其他平台把产物放进 `bin/<platform>-<arch>/`（命名见 plugins/README.md），
通道会优先取当前平台的目录。

`bin/darwin-arm64/chrome-proxy-launcher` 已随仓库提交（约 2.4MB，外加 5MB 的
`meow.gz`），开箱即用；其他平台需要本机构建。

测试（在仓库根目录执行）：

```sh
cargo test --manifest-path plugins/chrome-proxy-launcher/Cargo.toml
node --test --test-concurrency=1 plugins/chrome-proxy-launcher/tests/isolation.cjs plugins/chrome-proxy-launcher/tests/fingerprint.cjs plugins/chrome-proxy-launcher/tests/automatic.cjs
```

集成测试默认使用上面构建的 release 二进制（可用 `PLUGIN_TEST_BIN` 指定）。
提供 `CHROME_TEST_BIN` 浏览器路径后，额外在临时 profile 中进行无头断代理测试：
代理开启时页面必须成功，关闭代理后必须记录代理连接错误且目标没有新增直连。
测试不使用用户登录数据，也不关闭现有浏览器。macOS 的所有临时 Chrome 测试
均使用 `--use-mock-keychain`，避免测试读取系统钥匙串或反复弹出授权提示；仅创建
临时 profile 不能隔离钥匙串。此参数不用于真实身份，不能为消除提示而给已有
登录目录切换密钥来源，否则可能无法解密原有 Cookie / 密码。指纹测试通过临时 Chrome 的调试
管道加载真实扩展，验证首段页面脚本、iframe、重复读取、跨进程重载和卸载恢复；
测试接口的临时加载不等于人工安装，不能据此宣称已验证用户身份中的安装状态。

## 命令参考（stdin JSON → stdout JSON）

| 命令 | input | 说明 |
| --- | --- | --- |
| `detect` | – | 找浏览器 + 插件自带的 meow 内核 + 探测本机常见代理端口 |
| `list` | – | 身份清单（含 running/pid）+ 订阅清单 |
| `save` | `{id?, name, egressType:"direct"\|"subscription", proxy:{…}` 或 `subscription:{id,node,via?}, note?, chromePath?}` | 新建 / 更新 |
| `remove` | `{id}` | 删除（运行中先停；磁盘 profile 保留） |
| `fingerprint-prepare` | `{id}` | 仅准备该身份扩展文件；正常启动会自动准备和加载 |
| `launch` | `{id, url?, checkProxy?=true, automaticFingerprint?=true}` | 自动加载扩展后打开隔离实例（时区/语言自动跟随出口，见上节）；传 false 使用普通启动 |
| `stop` | `{id}` | 停止实例（连带收割本地中继 / 内核） |
| `probe` | `{id}` 或 `{proxy:{…}}` 或 `{subscription:{…}}` | 经该出口取外网 IP + 延迟 + 地理信息（`geo`：国家/时区/locale） |
| `egress` | `{id, check?=false}` | 确保该身份的出口**现在**可用，返回标准代理 URL（`proxyUrl`）。订阅出口会复用/拉起内核，带凭据出口会复用/拉起中继；幂等，可被外部程序按需调用 |
| `egress-stop` | `{id}` | 收割该身份的内核与中继（不动 Chrome），出口配置变化时插件自己也会调 |
| `subscription-save` | `{id?, name?, url}` | 拉取并保存订阅（刷新节点缓存） |
| `subscription-refresh` | `{id}` | 重新拉取订阅 |
| `subscription-remove` | `{id}` | 删除订阅（仍被身份引用时拒绝） |
| `relay` | `{id, proxy:{…}, hop?:{…}}` | 内部命令：launch 自动拉起的本地中继；带 `hop`（socks5）时经跳板连上游，不单独使用 |

代理类型支持 `http` / `https` / `socks5`，可选用户名密码。注意两处边界：

- **`https`（TLS 到代理）只支持无账号密码**：直接交给 Chrome 原生处理；
  带账号密码会拒绝启动（插件内中继没有做 TLS 到代理），测出口对 https
  代理也不可用。需要认证请用 `http` 或 `socks5`。
- **跳板目前只支持「订阅节点」**：想让本机 Clash / 普通 VPN 的端口当跳板
  （再到家宽代理）暂未提供入口。

**带账号密码的代理**：Chrome 的 `--proxy-server` 带不了代理凭据（只认无认证
代理），所以只要身份里填了账号，launch 会先在本机起一个中继进程：

```
Chrome --proxy-server=http://127.0.0.1:<随机端口>  →  中继  →  真实上游
                                        (http Basic / socks5 RFC1929 认证)
```

凭据只存在于插件进程中，从不进入 Chrome 的命令行。中继端口随机、只听
127.0.0.1，stop / remove 时一并收割；连续 30 分钟无流量且对应浏览器已退出时
才自动退出。中继状态
写在 `~/.multicc/plugins-data/chrome-proxy-launcher/run/<id>.relay.json`。
上面「订阅节点 + 上游住宅代理」的跳板链复用的也是这个中继，只是多传一个
`hop`（跳板内核的 socks5 端口）。

带凭据的身份在 launch 前会做一次**认证探测**（而不是仅 TCP 可达）：凭据错了
直接拒绝启动，不会让 Chrome 挂在一个永远 407 的中继上。

## 给 Claude 账号当专用出口

同一个身份除了给 Chrome 用，也可以给**某一个 Claude 官方账号**当专用出口
（MultiCC 侧「线路 → 官方账号 → 编辑 → 专用出口」）：每个账号绑一个不同的
身份，各账号的请求就从不同的 IP 出去。

调用方（MultiCC 交给 cli-provider-router 的 `resolveUpstreamAgent` 钩子）每个
请求拨号前调一次 `egress`，拿到一条标准代理 URL，CPR 就经这条出口去连上游。`egress` 只负责「把出口准备好」
—— 内核/中继已在跑就复用，不在跑就拉起；返回的 `kind` 说明用的是哪一段：

| kind | proxyUrl | 何时 |
| --- | --- | --- |
| `direct` | `<scheme>://host:port` | 无凭据直连代理（本机 Clash / VPN 端口） |
| `core` | `http://127.0.0.1:<内核端口>` | 订阅节点，无上游 |
| `relay` | `http://127.0.0.1:<中继端口>` | 带凭据直连，或订阅节点 + 上游住宅代理 |

要在 UI 之外核对这个身份此刻的出口 IP，加 `"check": true`，返回里会带 `exitIp`
与 `geo`（国家/时区/locale；geo 服务不可用时 `geo.identified` 为 `false`）
（多一次外网探测，默认不做）。不想让它继续常驻就调 `egress-stop`。

出口配置（代理地址/订阅节点/上游）一改，插件会立刻收割旧内核与中继：内核没有
空闲退出，不收割的话下一个请求会继续走旧出口 —— 改了却换不了 IP 是最坏的结果。
订阅「刷新」同样会收割引用它的身份的内核。


专用出口当前覆盖模型转发；不能据此宣称令牌续期、额度查询、资料查询等账号
网络活动均已隔离。严格账号隔离需要将这些调用统一接入同一出口策略并逐项验证。
