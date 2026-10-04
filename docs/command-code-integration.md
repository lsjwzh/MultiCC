# Command Code 与 DeepSeek 集成

## 范围与来源

用户最初写作 commander go / Commend Code，本次按官方产品 **Command Code** 接入。
先前交付配置集成后，用户已授权登录并继续真实任务验收。

- 官方仓库：https://github.com/CommandCodeAI/command-code
- 官方安装说明：https://commandcode.ai/docs/quickstart
- 原生 BYOK 说明：https://commandcode.ai/docs/byok
- 非交互接口：https://commandcode.ai/docs/headless
- 发布源：https://registry.npmjs.org/command-code/latest
- 本次核实的最新版本：**1.74.1**。官方仓库没有可用的 GitHub latest release，版本以官方 README 链接的 npm 包为准。
- Docker 使用独立 `docker/command-code/package-lock.json` 锁定包及传递依赖，`npm ci` 校验完整性。
- 包地址：https://registry.npmjs.org/command-code/-/command-code-1.74.1.tgz
- SHA-512：`AEr4cPm08RQ86xKZTCOIOgf9ohob/L5ugB2ZO8X/iPzOQVk4nxDInRAofKy6/eQTfDlfb49J1y+Nyx3ngXMBFA==`

## 配置与默认假设

| 环境变量 | 默认值或用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 无默认密钥；只经环境变量传递 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` |
| `DEEPSEEK_FLASH_MODEL` | `deepseek-flash`；现有授权配置的 `/v1/models` 返回了这个模型 ID |
| `COMMAND_CODE_CMD` | 自动寻找 `command-code`；可覆盖绝对路径，避免与 Windows 的 `cmd` 冲突 |
| `COMMAND_CODE_PORT` | `8080`，仅绑定 `127.0.0.1` |
| `COMMAND_CODE_LAB_PASSWORD` | 隔离实例访问口令，默认 `command-code-lab`；它不是模型 API Key |

MultiCC 会话内的 CLI ID 为 `commandcode`，模型为 `deepseek/deepseek-flash`。
它使用原生 `-p --output-format json` 事件流和 BYOK 文件，不绑定 MultiCC 的 Claude/Codex Provider 池。1.74.1 的 ACP 模式只提供内置模型目录，真实请求拒绝 `deepseek/deepseek-flash`；因此改用已实测可用的原生非交互接口。
适配器将原生文本增量、工具调用、恢复 ID、用量与最终结果映射到现有界面；取消使用进程终止。ACP 的动态 MCP 服务器注入不适用于这条原生接口，本轮未声明该能力已支持。
配置脚本保留其他 Provider，只更新 `deepseek` 项；遇到损坏的 JSON 会拒绝覆盖。
密钥字段始终为字面量 `$DEEPSEEK_API_KEY`，不会把密钥值写进配置。

Docker 中设置 `CMD_LOCAL_ONLY=1`、`DO_NOT_TRACK=1`，防止 BYOK 流量误走 Command Code 后端。
健康检查验证可执行文件、BYOK 文件、种子会话与 MultiCC `/readyz`，**不表示账户或模型调用已成功**。
数据保存在 Docker 命名卷中，宿主的账户文件、个人会话和工作目录不挂入容器。

## 可复现命令

从当前仓库根目录运行；先确保新文件已进入 Git 索引。构建脚本只导出 Git 已知的普通源文件，排除密钥、历史、运行数据及符号链接。

```bash
# 构建真实 MultiCC + Command Code 1.74.1 镜像
npm run command-code:build

# 使用环境中的 DEEPSEEK_* 启动；不会生成 .env 文件
node scripts/start-command-code-lab.js

# 或显式复用现有 MultiCC 中名为 DeepSeek Flash 的官方 Provider
node scripts/start-command-code-lab.js --provider-file /你的主仓库绝对路径/providers.json

# 配置、适配器、三端展示一致性和命令解析测试
npm run test:command-code

# 真实 Docker 网页的 CDP 冒烟测试；使用独立 Chrome 测试目录
node scripts/test-command-code-cdp.js

# 查看实例状态和日志
docker compose -f docker/command-code/compose.yaml ps
docker compose -f docker/command-code/compose.yaml logs --tail=80 command-code

# 停止实例，保留数据卷
npm run command-code:down
```

访问 `http://127.0.0.1:8080/`，输入隔离实例口令，打开“Command Code · DeepSeek Flash”会话。
启动脚本在 MultiCC 环境中会登记服务；本机独立运行时没有登记服务的宿主地址则跳过登记。
改动不会重启当前生产 MultiCC；主服务加载新增 CLI 需要用户手动重启，App 需要重新构建。

非 Docker 主机先自行安装锁定版本，然后生成原生配置：

```bash
npm install -g command-code@1.74.1
node scripts/configure-command-code.js
# 启动 MultiCC 的环境需携带 DEEPSEEK_*；可选 CMD_LOCAL_ONLY=1。
```

## 账户边界与后续真实验收

1.74.1 的真实非交互试跑在已配置 BYOK 与本地模式时仍返回退出码 3，提示先登录 Command Code。
未使用伪造凭据、修改安装包或移除认证检查。2026-10-05 已经用户授权完成官方浏览器登录和容器 CLI 授权，`command-code status` 确认认证成功。

CDP 冒烟脚本验证健康检查、真实页面、会话标识、DeepSeek 模型、配置保存和刷新恢复，不提交模型任务。
三个历史任务的真实 CLI 对照结果见下节；GUI 验收与 CLI 基准分别记录，不把模拟结果或单次样本当作长期服务保证。

## 首批配置验证结果（2026-10-05）

- 镜像 `multicc-command-code:local` 构建成功，真实安装 Command Code 1.74.1；隔离容器启动、重建后健康检查均通过，端口为 `127.0.0.1:8080`。
- 重建前后种子会话 ID 均为 `task-18bd6151c8c31fef1fda4cdf60860b83`，验证数据卷保留与启动恢复，没有重复创建会话。
- 真实 Chrome CDP 的 6 项配置冒烟检查通过：健康检查、会话 DTO、浏览器登录与会话查看、DeepSeek 模型加载、配置保存回读、刷新恢复。通过实际 Air 页面及会话 iframe 打开配置，不使用替代测试页面。
- 专项 Node 测试 218 项通过；最终 `npm run test:command-code` 再次通过 38 项。
- App 修改的 5 个 Dart 文件定向静态分析通过。测试分层登记、仓库产物检查和 `git diff --check` 通过。
- 扩展核心测试未全绿：resident bridge 时序用例首跑失败、独立重跑 3/3 通过；mbrowser daemon 清理测试受到其他 worktree 的既存 fake daemon 进程干扰，独立重跑仍失败，未终止其他会话进程。不能据此宣称完整核心测试通过。

### 首批交付时的未验收项（后续状态见下）

本轮完成的是用户收窄后的集成与配置验证。未验证 Command Code 登录、真实模型任务提交、真实日志/取消/重试、三个历史任务回放及 OpenCode 性能指标。协议级适配器测试和配置 CDP 成功不能代替这些端到端结果。生产 MultiCC 没有重启，新增 CLI 在生产端生效仍需手动重启；App 展示更新需重新构建。

## 真实对照（2026-10-05 后续批次）

比较版本为 OpenCode **1.18.33** 与 Command Code **1.74.1**。

用例及原始会话 ID、消息 ID、Provider/model/agent 配置：`tests/fixtures/command-code/history-cases.json`。源为本机只读 OpenCode SQLite；删除宿主注入上下文，保留用户任务。读取 `/etc/hosts` 的用例改为固定 `hosts.fixture`，保证两个平台的内容相同。当前仓库提供复现脚本和固定文件内容。

旧会话分别使用 `opencodego/deepseek-v4-flash` 与 `opencode/big-pickle`，历史记录没有统一的首可见响应计时及交互点击数，故采用同一任务、同一 DeepSeek 官方 OpenAI 端点与 `deepseek-flash` 重新执行。

| 用例 | OpenCode 首文本 / 完成 | Command Code 首文本 / 完成 | 完成耗时比 |
| --- | --- | --- | --- |
| 精确回复 | 2.610 / 2.644 秒 | 1.676 / 1.744 秒 | 0.66 |
| 文件读取 | 4.499 / 4.529 秒 | 1.982 / 2.205 秒 | 0.49 |
| 30 秒命令 | 34.271 / 34.311 秒 | 4.812 / 36.119 秒 | 1.05 |

最终样本两边成功率均为 3/3（100%）、错误率均为 0/3。每项均为一次 CLI 提交（交互次数 1，差异 0%）。首文本是 CLI 发出的首个可见文本事件；OpenCode 可能聚合输出，因此不是网络首 token 延迟，不能据此断言底层模型更快。长命令的结束语和完成耗时已检查，文件读取有真实工具事件。

这是每用例每引擎一次的小样本，OpenCode 在宿主运行、Command Code 在 Docker 运行；没有统计置信区间，也没有完成两套 GUI 的交互点击数对照。严格的 GUI 交互差异 ≤20% 尚未验收。

复现：

```bash
# 密钥从 DEEPSEEK_API_KEY 读取；或追加已授权的 --provider-file /绝对路径/providers.json
COMMAND_CODE_BENCHMARK_REPORT=/tmp/command-code-comparison.json node scripts/benchmark-command-code.js
# CLI 已在容器登录且具有可用 DeepSeek 配置后执行真实网页测试
node scripts/test-command-code-cdp.js --live
```

原始汇总结果：`docs/command-code-comparison.json`，不含凭据。初次文件读取因 OpenCode cwd 未显式指定而失败，已修为 `--dir`；一次长命令被测试实例重建中断（退出码 137），已整批重跑，未将其计为成功。原 ACP 路径的错误提示与有限重试确实出现，但该路径已被原生 JSON 替代。网页流式映射缺少 `delta:true` 的换行问题已修复并增加回归断言。

## 最终网页与回归结果

2026-10-05，`node scripts/test-command-code-cdp.js --live` 退出码 0，**13/13 项通过**：健康检查、会话 DTO、登录与查看、模型加载、保存回读、刷新恢复、三个历史任务、实时工具日志展开、中断、无效模型错误提示、恢复正确模型后重新提交成功。真实网页三例耗时分别为 2.528、3.195、35.819 秒（包含发送按钮防抖等待，不等于 CLI 基准）。

最终测试会话 `task-40688762fe621c71341514372019b0dc`；同一会话连续三轮验证原生恢复 ID 可用。错误用例真实调用 DeepSeek，返回 HTTP 400，前端显示明确原因；随后恢复 `deepseek/deepseek-flash`，收到 `CDP_RECOVERY_OK`。取消用例终止正在运行的回合，未等待 30 秒完成。

新增原生协议、网页工具卡及相关回归 **149 项全部通过**；修改的 App 文件 `flutter analyze --no-pub lib/utils/cli_display.dart` 通过（先用 `flutter pub get --offline` 恢复依赖映射）。测试登记、产物治理与 `git diff --check` 通过。Docker 实例最终 `healthy`，账户保存在独立数据卷，重建未丢失登录态。没有重启生产 MultiCC，也没有手动提交或合并。

### 当前验收边界

- Docker、DeepSeek 真实调用、三项历史用例、核心网页流程及 CLI 样本成功率/延迟阈值已通过。
- CLI 每例一次提交，交互数差异为 0%；**两套 GUI 的点击数差异尚未实测**，不能宣称原始全部体验指标均已验收。
- 三个简单任务只是小样本，未测长时间稳定性、大型代码改动、并发或真实项目回归成功率。
- Command Code 自身限制直接 `sleep` 时，模型可能改为后台命令或内置等待工具；测试校验实际等待时间、工具事件和完成结果，不保证完全相同的内部工具路径。
- 原生接口未接入 ACP 的动态 MultiCC MCP 注入。配置、会话文本、工具日志、取消及恢复已测试；跨会话路由、保险箱等 MCP 操作不在本次通过范围。
- 实验实例未配置独立 Aux Provider，自动分类可能显示“判定已暂停”；核心模型执行和上述 CDP 流程不依赖 Aux。不能将该实例视为所有 MultiCC 功能均已配置。

### 默认假设汇总

采用官方 npm 稳定版 1.74.1；8080 仅本机监听；端点 `/v1`、模型 `deepseek-flash`；密钥使用环境变量或显式授权的现有 Provider，仅传递到进程环境；账号经官方授权持久化至 Docker 数据卷；使用独立 Chrome 和 CDP；历史用例去除宿主注入文本，文件内容固定；同模型顺序执行一次作为 CLI 基准，首响应按首可见文本事件计时；自动批准权限仅用于已授权的测试任务与隔离实例。生产加载新适配器仍需用户手动重启。
