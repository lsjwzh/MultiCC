'use strict';

// 宿主端口：docs / memory / memo / directory-events 簇的 16 条公开路由已由 Rust 前门独占
// （src/docs-registry.js 7 条、src/routes/memory-browser.js 5 条、
// src/memo/router.js 3 条、src/notes-store.js 1 条）。路径匹配、参数解码、
// query/body 读取、OPTIONS Allow、sanitize/校验、记忆库 rel 与穿越判定、view/DTO
// 组装、memo 请求校验与错误信封见
// native/gateway/src/app/docs_memory_routes.rs 与 native/core/src/docs_memory_routes.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：
//
//   docsRegistry        注册表内存表 + docs-registry.json、artifact 依赖图与
//                       servedRoots()、服务进程的 spawn/kill/probe/日志
//   resolveTaskId/Title 任务壳里 artifact ↔ task 的映射与标题
//   resolveDir          会话所属目录（server.js 的 Map 查找）
//   memoryBrowser       记忆库目录扫描（graph/tree）、realpath 祖先事实、
//                        文件读写与 workspaceBroadcast
//   memo controller     memo.md 的读写与 runTurn 投递
//   notesStore          目录事件环（getWorkspaceEvents）与 JSONL
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const { isLocalRequest } = require('../native/binding').requestLocality;
const { mapError } = require('../http-errors');

const HOST_PATH = '/api/__host/docs-memory';

/** Marker meaning "this op is not part of the cluster" -> 400 unknown operation. */
const UNKNOWN = Symbol('unknown');

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function createDocsMemoryHost(rawDeps = {}) {
  const deps = rawDeps;
  const logger = deps.logger || console;
  const docs = deps.docs || require('../docs-registry');
  const memory = deps.memory;
  const memo = deps.memo;
  const notes = deps.notes || {};
  const directories = deps.directories;
  const artifactExists = typeof deps.artifactExists === 'function'
    ? deps.artifactExists
    : docs.defaultArtifactExists();
  const resolveTaskId = typeof deps.resolveTaskId === 'function' ? deps.resolveTaskId : () => null;
  const resolveTaskTitle = typeof deps.resolveTaskTitle === 'function' ? deps.resolveTaskTitle : () => null;
  const resolveDir = typeof deps.resolveDir === 'function' ? deps.resolveDir : () => null;

  // src/http 的品牌映射（DomainError -> 4xx，InfrastructureError -> 500）。
  // 错误对象只能在这个进程里映射；回到前门的是已经定稿的 {status,code,message}。
  function refusal(error) {
    const mapped = mapError(error);
    return {
      refused: {
        status: mapped.status,
        code: mapped.code,
        message: mapped.message,
      },
    };
  }

  function mapped(run) {
    try {
      return { data: run() };
    } catch (error) {
      return refusal(error);
    }
  }

  async function mappedAsync(run) {
    try {
      return { data: await run() };
    } catch (error) {
      return refusal(error);
    }
  }

  function docsFacts(items) {
    const sessionDir = [];
    const exists = [];
    const taskTitle = [];
    for (const item of items) {
      const entry = asObject(item);
      const dir = resolveDir(entry.sessionId);
      sessionDir.push(dir === undefined ? null : dir);
      exists.push(entry.artifactId ? artifactExists(entry.artifactId) : null);
      taskTitle.push(entry.taskId ? resolveTaskTitle(entry.taskId) : null);
    }
    return { sessionDir, exists, taskTitle };
  }

  function invoke(body) {
    switch (body.op) {
      // ── docs registry ──
      case 'docs-list':
        return {
          entries: docs.entriesSnapshot(),
          order: docs.viewSortOrder(),
          retained: docs.retainedIds(),
        };

      case 'docs-facts':
        return docsFacts(Array.isArray(body.items) ? body.items : []);

      case 'docs-get': {
        const entry = docs.entryById(String(body.id));
        return { found: Boolean(entry), entry };
      }

      case 'docs-replace':
        return { found: docs.replaceEntryById(String(body.id), asObject(body.entry)) };

      case 'docs-delete':
        return docs.removeEntryById(String(body.id));

      case 'docs-register':
        return docs.registerEntry(asObject(body.entry));

      case 'docs-start':
        return docs.startService(String(body.id));

      case 'docs-stop':
        return docs.stopService(String(body.id));

      case 'docs-log':
        return docs.serviceLog(String(body.id));

      case 'docs-probe-kick':
        docs.probeAllServices().catch(() => {});
        return {};

      case 'docs-task-id':
        return { taskId: resolveTaskId(body.sessionId) };

      case 'docs-dir':
        return { dir: resolveDir(body.sessionId) };

      case 'docs-clean-url': {
        // `cleanUrl`'s absolute branch: WHATWG `new URL(url).href`. The cheap
        // checks (trim, length, CRLF, root-relative) already ran in Rust.
        const input = typeof body.url === 'string' ? body.url : '';
        try {
          const parsed = new URL(input);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { href: null };
          return { href: parsed.href };
        } catch (_) {
          return { href: null };
        }
      }

      // ── memory browser ──
      case 'memory-graph': {
        const startedAt = Date.now();
        try {
          const data = memory.buildMemoryGraph(String(body.dirId));
          return { data, durationMs: Date.now() - startedAt };
        } catch (error) {
          return { error: require('./memory-browser').publicFailure('graph build', error) };
        }
      }

      case 'memory-tree': {
        const startedAt = Date.now();
        try {
          const data = memory.buildMemoryTree();
          return { data, durationMs: Date.now() - startedAt };
        } catch (error) {
          return { error: require('./memory-browser').publicFailure('tree build', error) };
        }
      }

      case 'memory-resolve':
        return memory.pathFacts(String(body.rel));

      case 'memory-read':
        return memory.readMemoryFile(String(body.rel));

      case 'memory-write':
        return memory.writeMemoryFile(String(body.rel), String(body.content));

      case 'memory-delete':
        return memory.deleteMemoryFile(String(body.rel));

      // ── memo ──
      case 'memo-read':
        return mapped(() => memo.read({ directoryId: String(body.directoryId) }));

      case 'memo-write':
        return mapped(() => memo.write({
          directoryId: String(body.directoryId),
          text: body.text,
        }));

      case 'memo-send':
        return mappedAsync(() => memo.send({
          directoryId: String(body.directoryId),
          text: body.text,
          sessionId: body.sessionId,
        }));

      // ── directory event log ──
      case 'notes-events': {
        const directory = directories && directories.get(String(body.directoryId));
        if (!directory) return { found: false, events: [] };
        return { found: true, events: notes.recentEvents(directory.id) };
      }

      default:
        return UNKNOWN;
    }
  }

  async function handle(body) {
    return invoke(asObject(body));
  }

  function mount(app) {
    app.post(HOST_PATH, (req, res) => {
      // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
      const isLocal = typeof deps.isLocal === 'function' ? deps.isLocal : isLocalRequest;
      if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
      const body = asObject(req.body);
      return Promise.resolve()
        .then(() => invoke(body))
        .then(
          (value) => {
            if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
            return res.json({ ok: true, value: value === undefined ? null : value });
          },
          (error) => {
            // 500 会被前门翻译成 rust_backend_unavailable（见 docs/gateway.md §9）。
            logger?.error?.('[docs-memory-host] operation failed', body.op, error);
            return res.status(500).json({ error: 'host operation failed' });
          },
        );
    });
    // The service probe loop used to live inside docsRegistry.mount().
    docs.startProbeLoop();
  }

  return { handle, mount };
}

function mountDocsMemoryHostRoute(app, options = {}) {
  createDocsMemoryHost(options).mount(app);
}

module.exports = { HOST_PATH, createDocsMemoryHost, mountDocsMemoryHostRoute };
