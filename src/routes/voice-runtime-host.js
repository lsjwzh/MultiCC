'use strict';

// 宿主端口（host port）：`/api/voice-gateway*`（全局实时语音控制面）与
// `/api/voice-runtime*`、`/api/directories/:id/voice-gateway/runtime|restart`
// 已经由 Rust 前门（multicc-gateway）独占。HTTP 方法、路径、状态码、错误码映射、
// launch URL、loopbackOnly 传输标记和 v1 的 apiVersion 元数据都在 Rust 一侧；
// 这里只剩 Node 独有的运行时事实与副作用：
//
//   globalGet / globalPut / globalRemove   全局网关记录 + 子进程
//   globalRuntime / globalRestart          全局实时语音子进程的状态
//   launchBegin / launchEnd / launchResolve 一次性的 launch ticket
//   runtimeGet / runtimeInstall            Qwen Audio 运行时安装
//   fleetRuntime / fleetRestart            旧 per-Fleet 端点对全局子进程的投影
//
// 所有 op 内部同步完成的部分都在第一次 await 之前完成；只有 globalRestart、
// launchBegin 的按需启动和 fleetRestart 需要等待子进程状态，其余与旧单线程
// 路由逐请求等价。`options` 缺失的键必须保持 undefined 交给 service 校验，
// JSON 里的 null 原样透传。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');
const { publicBaseUrl } = require('./voice-gateway-host');

const HOST_PATH = '/api/__host/voice-runtime';

const STOPPED_GLOBAL = Object.freeze({ scope: 'global', state: 'stopped', desired: false, url: null });

function createVoiceRuntimeHost({
  service,
  launchRegistry,
  voiceRouter = null,
  runtime = null,
  getBaseUrl = () => 'http://127.0.0.1:3000',
  log = console,
  installer,
  supervisor,
} = {}) {
  if (!service || typeof service.inspectGlobal !== 'function') {
    throw new TypeError('global voice gateway routes require the voice gateway service');
  }
  if (!launchRegistry || typeof launchRegistry.issue !== 'function') {
    throw new TypeError('global voice gateway routes require a launch registry');
  }
  if (!installer || typeof installer.status !== 'function' || typeof installer.startInstall !== 'function') {
    throw new TypeError('qwen audio runtime routes require installer');
  }
  if (!supervisor || typeof supervisor.status !== 'function') {
    throw new TypeError('qwen audio runtime routes require supervisor');
  }

  // 失败只回 code；异常回 `thrown`，由前门映射成 500。
  function thrown(error) {
    return { thrown: { code: error?.code, message: String(error?.message || error) } };
  }

  function mountRoutes(app) {
    if (!app || typeof app.post !== 'function') {
      throw new TypeError('[voice-runtime-host] Express-compatible app is required');
    }

    app.post(HOST_PATH, async (req, res) => {
      // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
      if (!isLocalRequest(req)) return res.status(404).json({ error: 'not found' });
      const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};

      if (body.op === 'globalGet') {
        const result = service.inspectGlobal();
        return res.json({
          gateway: result.gateway,
          legacy: result.legacy,
          baseUrl: publicBaseUrl(getBaseUrl()),
        });
      }

      if (body.op === 'globalPut') {
        try {
          const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options)
            ? body.options : {};
          const result = service.ensureGlobal({
            enabled: options.enabled,
            provider: options.provider,
            commanderSessionId: options.commanderSessionId,
          });
          if (!result.ok) return res.json({ ok: false, code: result.code });
          // A global launch has nowhere to land without the router session, so
          // provision it with the gateway rather than at first use.
          if (result.gateway.enabled === true) {
            const provisioned = voiceRouter?.ensure?.();
            if (provisioned && provisioned.ok === false) {
              log.warn?.('[multicc/voice] router provisioning failed', { code: provisioned.code });
            }
          }
          // reconcileAll is the single place that decides how many children run.
          runtime?.reconcileAll?.({ installIfNeeded: body.autoInstall === true });
          return res.json({ ok: true, created: result.created, gateway: result.gateway });
        } catch (error) {
          return res.json(thrown(error));
        }
      }

      if (body.op === 'globalRemove') {
        try {
          const result = service.removeGlobal();
          if (!result.ok) return res.json({ ok: false, code: result.code });
          Promise.resolve(runtime?.stopGlobal?.()).catch(() => {});
          return res.json({ ok: true });
        } catch (error) {
          return res.json(thrown(error));
        }
      }

      if (body.op === 'globalRuntime') {
        const status = runtime?.statusGlobal?.() || { ...STOPPED_GLOBAL };
        return res.json({ status });
      }

      if (body.op === 'globalRestart') {
        try {
          const status = await runtime?.restartGlobal?.();
          return res.json({ status: status || {} });
        } catch (error) {
          return res.json(thrown(error));
        }
      }

      if (body.op === 'launchBegin') {
        try {
          const inspected = service.inspectGlobal();
          if (!inspected.gateway.configured || inspected.gateway.enabled !== true) {
            return res.json({ ok: false, code: 'voice_gateway_not_found' });
          }
          // Backfill for a gateway configured before the router existed.
          if (!body.sourceSessionId) {
            const provisioned = voiceRouter?.ensure?.();
            if (provisioned && provisioned.ok === false) {
              return res.json({ ok: false, code: provisioned.code || 'voice_router_not_provisioned' });
            }
          }
          const issued = launchRegistry.issue({ sourceSessionId: body.sourceSessionId });
          if (!issued.ok) return res.json({ ok: false, code: issued.code });

          // Start on demand so the first launch of the day does not require the
          // user to have pressed a separate "start" button. A failed start is
          // reported through the returned status, never as a transport error.
          let status = runtime?.statusGlobal?.() || null;
          if (status && status.state !== 'running') {
            try { status = await runtime?.startGlobal?.(); } catch (_) { /* reported via status */ }
          }
          return res.json({
            ok: true,
            launch: {
              id: issued.launch.id,
              scope: issued.launch.scope,
              expiresAt: issued.launch.expiresAt,
              display: issued.launch.display,
              sourceSessionId: issued.launch.sourceSessionId || null,
            },
            targetSessionId: issued.context.targetSessionId,
            status,
          });
        } catch (error) {
          return res.json(thrown(error));
        }
      }

      if (body.op === 'launchEnd') {
        if (body.revoke === true) {
          launchRegistry.revoke(body.id);
        } else {
          try {
            log.info?.('[multicc/voice] launch issued', {
              scope: body.scope,
              source: body.source || null,
              target: body.target,
            });
          } catch (_) {}
        }
        return res.json({ ok: true });
      }

      if (body.op === 'launchResolve') {
        const result = launchRegistry.resolve(body.launchId);
        if (!result.ok) return res.json({ ok: false, code: result.code });
        return res.json({ ok: true, context: result.context });
      }

      if (body.op === 'runtimeGet') {
        return res.json({ runtime: installer.status() });
      }

      if (body.op === 'runtimeInstall') {
        try {
          const before = installer.status();
          const runtime = installer.startInstall();
          installer.waitForInstall()
            .then(() => supervisor.reconcileAll())
            .catch(error => {
              try { log.error?.('[multicc/qwen-audio] asynchronous install failed', { error: error?.message }); } catch (_) {}
            });
          return res.json({ installed: before.installed, runtime });
        } catch (error) {
          return res.json(thrown(error));
        }
      }

      // Once the global gateway exists there is only one child, so the legacy
      // per-Fleet runtime endpoints must report *that* child rather than an
      // always-stopped Fleet slot.
      if (body.op === 'fleetRuntime') {
        const projectsGlobal = supervisor.hasGlobalGateway?.() === true;
        return res.json({
          projectsGlobal,
          status: projectsGlobal ? supervisor.statusGlobal() : supervisor.status(body.id),
        });
      }

      if (body.op === 'fleetRestart') {
        try {
          const projectsGlobal = supervisor.hasGlobalGateway?.() === true;
          const status = projectsGlobal ? await supervisor.restartGlobal() : await supervisor.restart(body.id);
          return res.json({ projectsGlobal, status });
        } catch (error) {
          return res.json(thrown(error));
        }
      }

      return res.status(400).json({ error: 'unknown host operation' });
    });
  }

  return Object.freeze({ mountRoutes });
}

module.exports = { createVoiceRuntimeHost, HOST_PATH };
