'use strict';

// 宿主端口（host port）：agent-resources 的 6 条公开路由已经由 Rust 前门
// （multicc-gateway，native/gateway/src/app/agent_resources.rs）独占。路径匹配、
// 参数解码、olderThanDays 校验、purge 的 cutoff 与过滤循环、计数/求和、
// 409/404/400/500 状态码映射都在 Rust；这里只剩 Node 独有的事实与副作用：
//
//   skills                  ~/.claude / ~/.codex / ~/.agents 及项目目录的磁盘扫描
//   presets / preset        public/agent-presets.json 的进程内缓存、Agent Commander
//                           覆盖文案、按 provider store 解析 defaultProviderId/Name
//   claude-sessions         遍历 $HOME/.claude/projects/*/*.jsonl 并关联活动会话
//   claude-session-delete   路径校验、linked 保护、unlink 与会话附属目录清理，
//                           失败时打 agent_resources_failure 日志
//
// 这不是公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest` 拒绝任何
// 转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');

const HOST_PATH = '/api/__host/agent-resources';

function createAgentResourcesHost(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('[agent-resources-host] runtime is required');
  }

  const operations = Object.freeze({
    skills: () => ({ ok: true, skills: runtime.installedSkills() }),
    presets: () => runtime.presetsList(),
    preset: body => runtime.presetLookup(typeof body.id === 'string' ? body.id : ''),
    'claude-sessions': () => ({ ok: true, sessions: runtime.claudeSessions() }),
    'claude-session-delete': body => runtime.removeClaudeSession(
      typeof body.project === 'string' ? body.project : '',
      typeof body.id === 'string' ? body.id : '',
    ),
  });

  return function handle(body) {
    const op = body && typeof body.op === 'string' ? body.op : '';
    if (!Object.prototype.hasOwnProperty.call(operations, op)) return { ok: false };
    return operations[op](body);
  };
}

function mountAgentResourcesHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[agent-resources-host] Express-compatible app is required');
  }
  if (!options.runtime) throw new TypeError('[agent-resources-host] runtime is required');
  const isLocal = options.isLocal || isLocalRequest;
  const handle = createAgentResourcesHost(options.runtime);
  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    try {
      res.json(handle(body));
    } catch (_) {
      res.status(500).json({ error: 'host operation failed' });
    }
  });
}

module.exports = { mountAgentResourcesHostRoute, createAgentResourcesHost, HOST_PATH };
