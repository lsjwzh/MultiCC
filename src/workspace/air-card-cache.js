'use strict';
const { getNative, runNative } = require('../native/runtime');
const { boardStoreOf } = require('../native/task-domain');

// 原生 token 的对象镜像与宿主回调适配。缓存判定、过期和验证规则均在 Rust。
const MODES = new Set(['off', 'shadow', 'on']);
function createAirCardCache({ mode = 'shadow', verifyMs = 60_000, reportMs = 600_000,
  logger = null, clock = Date.now, random = Math.random } = {}) {
  const addon = getNative();
  if (typeof addon.RustAirCardCache !== 'function') throw new Error('卡片缓存 Rust 接口不可用，请构建当前原生模块');
  const native = new addon.RustAirCardCache(), mirrors = new Map();
  const run = command => JSON.parse(native.run(JSON.stringify(command)));
  const opened = run({ op: 'open', mode, verifyMs, reportMs, now: clock() });
  let tail = Promise.resolve();
  let pending = 0;
  let prepared = null;
  let rendered = null;
  async function prepareAsync(command) {
    const held = prepared, store = boardStoreOf(command.board);
    let reply;
    if (store && typeof native.prepareBoardAsync === 'function') {
      // 常驻任务板：先在主线程上送变更，工作线程直接读 Rust 常驻副本，不再整板序列化。
      store.flush();
      const { board: _board, ...rest } = command, input = JSON.stringify(rest);
      reply = JSON.parse(await runNative(() => native.prepareBoardAsync(input, held?.token || 0, store.native)));
    } else {
      const input = JSON.stringify(command);
      reply = JSON.parse(await runNative(() => native.prepareAsync(input, held?.token || 0)));
    }
    const value = reply.prepared || held.value;
    prepared = { token: reply.token, value };
    return value;
  }
  function plan(globalSignature, items, options) {
    return run({ op: 'plan', globalSignature, now: clock(), prune: options.prune,
      items: items.map(item => ({ key: String(options.keyOf(item)), signature: options.signatureOf?.(item) ?? null })) });
  }
  function finish(reply) {
    for (const { token, entry } of reply.entries) mirrors.set(token, entry);
    const entries = reply.tokens.map(token => mirrors.get(token));
    const retained = new Set(reply.retained);
    for (const token of mirrors.keys()) if (!retained.has(token)) mirrors.delete(token);
    for (const { event, ...data } of reply.logs) {
      try { (event === 'air_card_cache_mismatch' ? logger?.warn : logger?.info || logger?.log || logger?.warn)?.call(logger, event, data); } catch (_) {}
    }
    return { entries, hits: reply.hits, builds: reply.builds, render: { keys: reply.keys, tokens: reply.tokens, nativeRenderable: reply.nativeRenderable } };
  }
  function resolve(globalSignature, items, options) {
    const request = plan(globalSignature, items, options);
    try {
      const built = request.needed.map(index => ({ ...(options.nativeBaseOf
        ? { base: options.nativeBaseOf(items[index]) } : { entry: options.build(items[index]) }), random: random() }));
      return finish(run({ op: 'complete', ticket: request.ticket, built, now: clock() }));
    } catch (error) { run({ op: 'abort', ticket: request.ticket }); throw error; }
  }
  function resolveAsync(globalSignature, items, options) {
    // 不再在 pending>=16 时拒绝：串行 tail 本身就是背压，拒绝会让轮询 500。
    pending += 1;
    const result = tail.then(async () => {
      const request = plan(globalSignature, items, options);
      try {
        const built = [];
        for (let i = 0; i < request.needed.length; i++) {
          const item = items[request.needed[i]];
          built.push({ ...(options.nativeBaseOf ? { base: options.nativeBaseOf(item) }
            : { entry: await options.build(item) }), random: random() });
          if (i % 24 === 23) await new Promise(done => setImmediate(done));
        }
        const input = JSON.stringify({ op: 'complete', ticket: request.ticket, built, now: clock() });
        return finish(JSON.parse(await runNative(() => native.runAsync(input))));
      } catch (error) { run({ op: 'abort', ticket: request.ticket }); throw error; }
    });
    tail = result.then(() => {}, () => {});
    return result.finally(() => { pending -= 1; });
  }
  // 一轮快照在 Rust 内完成：先只上送 key/signature 判定 needed，再只提交 needed 的
  // 底稿，complete/overlay/排序全部在 Rust。命中轮次不构造任何卡片，成本与旧 plan 相同。
  function call(op, input) {
    if (typeof native[op] !== 'function') throw new Error('卡片快照 Rust 接口不可用，请构建当前原生模块');
    return runNative(() => native[op](JSON.stringify(input))).then(value => JSON.parse(value));
  }
  function snapshotAsync(command, buildBases) {
    pending += 1;
    const result = tail.then(async () => {
      const planned = await call('snapshotPlanAsync', command);
      try {
        const bases = typeof buildBases === 'function' ? await buildBases(planned.needed || []) : [];
        // finish 不需要 items/globalSignature/prune：complete 只认 ticket+bases，
        // overlay 只认 keys/facts，重复上送整份签名会白白多传一轮。
        const facts = { now: command.now, facts: command.facts, merges: command.merges,
          capacityReasons: command.capacityReasons, knownRenderToken: command.knownRenderToken };
        const reply = await call('snapshotFinishAsync', { ...facts, ticket: planned.ticket, bases });
        for (const { event, ...data } of reply.logs || []) {
          try { (event === 'air_card_cache_mismatch' ? logger?.warn : logger?.info || logger?.log || logger?.warn)?.call(logger, event, data); } catch (_) {}
        }
        rendered = { token: reply.renderToken, cards: reply.cards };
        return reply;
      } catch (error) {
        try { await call('snapshotAbortAsync', { ticket: planned.ticket }); } catch (_) {}
        throw error;
      }
    });
    tail = result.then(() => {}, () => {});
    return result.finally(() => { pending -= 1; });
  }
  async function overlayAsync(result, facts) {
    const held = rendered;
    const command = { op: 'overlay', ...result.render, ...facts,
      knownRenderToken: held?.token || 0,
      entries: result.render.nativeRenderable ? undefined : result.entries };
    function finishOverlay(reply) {
      const cards = reply.cards || held.cards;
      rendered = { token: reply.token, cards };
      return cards;
    }
    try { return finishOverlay(JSON.parse(await runNative(() => native.runAsync(JSON.stringify(command))))); }
    catch (error) {
      // 另一轮刷新已回收 token 时，仍用本轮不可变镜像完成同一份快照。
      if (!error.message.includes('card_cache_version_changed')) throw error;
      return finishOverlay(JSON.parse(await runNative(() => native.runAsync(JSON.stringify({ ...command,
        nativeRenderable: false, entries: result.entries })))));
    }
  }
  return { resolve, resolveAsync, snapshotAsync, overlayAsync, prepareAsync, mode: opened.mode, stats: () => run({ op: 'stats' }) };
}
module.exports = { createAirCardCache, AIR_CARD_CACHE_MODES: MODES };
