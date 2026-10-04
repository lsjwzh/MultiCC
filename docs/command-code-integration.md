# Command Code 与 DeepSeek 集成

## 范围与来源

用户最初写作 commander go / Commend Code，本次按官方产品 **Command Code** 接入。
按后续指示，先完成 DeepSeek 配置与会话集成，暂不处理 Command Code 账户。

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
它走现有 ACP 桥，使用原生 BYOK 文件，不绑定 MultiCC 的 Claude/Codex Provider 池。
因此复用现有会话文本、工具卡、恢复、取消与错误终态处理。
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

## 账户边界与暂缓验收

1.74.1 的真实非交互试跑在已配置 BYOK 与本地模式时仍返回退出码 3，提示先登录 Command Code。
未使用伪造凭据、修改安装包或移除认证检查。按用户最新指示，账户问题暂缓。

CDP 冒烟脚本验证健康检查、真实页面、会话标识、DeepSeek 模型、配置保存和刷新恢复，不提交模型任务。
原计划的三个历史任务实跑、成功率 ≥90%、相对 OpenCode 的延迟和交互步骤指标仍未验收，不用模拟响应冒充真实性能。
这部分待用户恢复完整验收范围且模型任务可执行时继续。

## 实际验证结果（2026-10-05）

- 镜像 `multicc-command-code:local` 构建成功，真实安装 Command Code 1.74.1；隔离容器启动、重建后健康检查均通过，端口为 `127.0.0.1:8080`。
- 重建前后种子会话 ID 均为 `task-18bd6151c8c31fef1fda4cdf60860b83`，验证数据卷保留与启动恢复，没有重复创建会话。
- 真实 Chrome CDP 的 6 项配置冒烟检查通过：健康检查、会话 DTO、浏览器登录与会话查看、DeepSeek 模型加载、配置保存回读、刷新恢复。通过实际 Air 页面及会话 iframe 打开配置，不使用替代测试页面。
- 专项 Node 测试 218 项通过；最终 `npm run test:command-code` 再次通过 38 项。
- App 修改的 5 个 Dart 文件定向静态分析通过。测试分层登记、仓库产物检查和 `git diff --check` 通过。
- 扩展核心测试未全绿：resident bridge 时序用例首跑失败、独立重跑 3/3 通过；mbrowser daemon 清理测试受到其他 worktree 的既存 fake daemon 进程干扰，独立重跑仍失败，未终止其他会话进程。不能据此宣称完整核心测试通过。

### 未验收项

本轮完成的是用户收窄后的集成与配置验证。未验证 Command Code 登录、真实模型任务提交、真实日志/取消/重试、三个历史任务回放及 OpenCode 性能指标。协议级适配器测试和配置 CDP 成功不能代替这些端到端结果。生产 MultiCC 没有重启，新增 CLI 在生产端生效仍需手动重启；App 展示更新需重新构建。
