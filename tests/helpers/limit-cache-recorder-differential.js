'use strict';

// Deterministic in-memory hosts: no database, account or outbound request.
const assert = require('node:assert/strict');
const legacy = require('./legacy-limit-cache-recorder').createLimitRecorder;
const current = require('../../src/quota/limit-cache-recorder').createLimitRecorder;
const start = 1_700_000_000_000;
function run(create, scenario) {
  const effects = [];
  let tick = start;
  const entries = new Map();
  const records = [
    { appType: 'claude', id: 'line', baseUrl: 'https://example.test/v1' },
    { appType: 'codex', id: 'codex-line', baseUrl: 'https://example.test/v1/responses' },
    { appType: 'claude', id: 'claude-official', activeAccountId: '0123456789abcdef' },
    { appType: 'claude', id: 'claude-official-0123456789abcdef', activeAccountId: '0123456789abcdef' },
  ];
  const cache = {
    get(type, id) { effects.push(['get', type, id]); return entries.get(`${type}:${id}`) || null; },
    record(type, id, value) { effects.push(['record', type, id, JSON.stringify(value)]); entries.set(`${type}:${id}`, value); return value; },
    recordFailure(type, id, value) { effects.push(['failure', type, id, JSON.stringify(value)]); },
    key(type, id) { effects.push(['key', type, id]); return `${type}:${id}`; },
  };
  const recorder = create({ cache, now() { effects.push(['now']); return tick++; },
    persistedSessions: { get(id) { effects.push(['session', id]); return id === 'session' ? { provider: 'line', cli: 'claude' } : null; } },
    providers: {
      appTypeForCli(cli) { effects.push(['appType', cli]); return cli === 'claude' ? 'claude' : null; },
      getProvider(type, id) { effects.push(['provider', type, id]); return records.find(p => p.id === id); },
      listProviders(type) { effects.push(['list', type]); return records.filter(p => p.appType === type); },
      getProviderLimitTarget(type, id) { effects.push(['target', type, id]); return { host: 'EXAMPLE.TEST', strategy: id.startsWith('claude-official') ? 'claude-official' : 'glm' }; },
    },
  });
  const value = scenario(recorder, entries, cache, effects);
  return { value: value instanceof Set ? [...value] : value, effects, entries: [...entries].map(([k,v]) => [k, JSON.stringify(v)]) };
}
module.exports = function recorderDifferential(ok) {
  const scenarios = [
    ['invalid identity does not touch stores or clocks', r => [r.appTypeForSession(''), r.recordSession('absent', {}), r.recordProvider('claude', '', {})]],
    ['session and explicit alias identity', r => [r.appTypeForSession('session'), r.recordSession('session', { kind: 'balance', available: true, total: 1.23, currency: 'CNY' }, 'claude-official')]],
    ['window seconds and weekly fraction', r => r.recordSession('session', { kind: 'window', provider: 'glm', status: 'allowed', rateLimitType: 'five_hour', utilization: 0.213456, resetsAt: (start + 3600_000) / 1000, weeklyUtilization: 0.901234, weeklyResetsAt: start + 7200_000 })],
    ['borrowed Claude preserves model windows', r => r.recordDto('claude','line', { kind: 'window', provider: 'claude', status: 'allowed', windows: [{ window: '5h', label: 'Session', usedPercent: 25, resetMs: start + 100_000 }, { window: '1wk', label: 'Sonnet', usedPercent: 70, resetMs: start + 200_000 }] })],
    ['passive headers use Claude merge policy', r => r.recordDto('claude','line', { kind: 'window', provider: 'claude', source: 'response_headers', status: 'allowed', utilization: 0.5, resetsAt: start + 200_000, rateLimitType: 'five_hour' })],
    ['unavailable and malformed DTOs skip writes', r => [r.recordDto('claude','line',null),r.recordDto('claude','line',{kind:'unknown'}),r.recordDto('claude','line',{kind:'window',provider:'claude',windows:[]})]],
    ['failure precedence and UTF-16 slice', r => r.recordProvider('claude','line',{ok:false,detail:'x'.repeat(199)+'😀',reason:'generic',code:429})],
    ['summary result evaluates clock once', r => r.recordProvider('claude','line',{ok:true,summaryText:'cached',summary:{x:1}})],
    ['DTO result retains own clock path', r => r.recordProvider('claude','line',{ok:true,dto:{kind:'balance',provider:'deepseek',available:false,total:0,currency:'CNY'}})],
    ['bare failure and async refresh side-effect order', r => { r.setRefresher(() => Promise.resolve()); return r.recordProviderFailure({providerId:'line',httpStatus:429}); }],
    ['revoked alias is concrete and releasable', r => { r.recordProviderFailure({providerId:'claude-official',category:'authentication_permission',httpStatus:401}); return r.releaseProviderFailure({providerId:'claude-official'}); }],
    ['bare failure preserves a longer park by reference', (r,entries) => { const previous={summary:{status:'rejected',blockedUntilMs:start+3600_000}};entries.set('claude:line',previous);return {same:r.recordProviderFailure({providerId:'line',httpStatus:429})===previous}; }],
    ['model rejection keeps stronger account park by reference', (r,entries) => { const previous={summary:{kind:'availability',status:'rejected',blockedUntilMs:start+3600_000}};entries.set('claude:line',previous);return {same:r.recordProviderFailure({providerId:'line',httpStatus:429,rejection:{kind:'window',scope:'model',model:'model-a',resetMs:start+600_000}})===previous}; }],
    ['structured account park bounds far reset', r => r.recordProviderFailure({providerId:'line',category:'rate_limit',httpStatus:'429',rejection:{kind:'window',scope:'account',resetMs:start+20*86400_000,window:'1wk',code:' quota '}})],
    ['revoked park cannot be replaced', (r,entries) => { const previous={summary:{status:'rejected',revoked:true,blockedUntilMs:1}};entries.set('claude:line',previous);return {same:r.recordProviderFailure({providerId:'line',httpStatus:429})===previous}; }],
    ['no revoked cache means release does not read clock', r => r.releaseProviderFailure({providerId:'line'})],
    ['host and path identity matching', r => [r.resolveByHost('example.test'),r.resolveByBaseUrl('https://example.test/v1/a?x=y'),r.resolveByBaseUrl('bad-url'),r.resolveByHost(null)]],
    ['vendor success deduplicates session host and path', r => r.recordVendor({kind:'kimi',session:'session',host:'example.test',baseUrl:'https://example.test/v1',result:{status:'ok',summary:[{window:'5h',label:'5h',usedPercent:30,resetMs:start+100_000}]}})],
    ['vendor failure only writes explicit unique identity', r => [r.recordVendor({kind:'kimi',session:'session',result:{status:'failed',reason:'unavailable'}}),r.recordVendor({kind:'kimi',host:'example.test',result:{status:'failed'}})]],
    ['Claude observed timestamps evaluate two clocks', r => r.recordClaude('session',{status:'ok',summary:[{window:'1wk',usedPercent:20,resetMs:start+100_000}]},'1wk 80% {cd:123|1wk} · ⟳ 刷新')],
    ['official windows merge and expire by cycle aliases', (r,entries) => { entries.set('codex:codex-line',{summary:{windows:[{window:'weekly',usedPercent:80,resetMs:start+100_000},{window:'1m',usedPercent:90,resetMs:start-1000}]}});return r.recordOfficialWindows('codex','codex-line',{windows:[{window:'5h',usedPercent:10,resetMs:start+100_000}]}); }],
    ['live key callback order', r => r.liveKeys()],
  ];
  for (const [name, scenario] of scenarios) {
    try { assert.deepStrictEqual(run(current, scenario), run(legacy, scenario)); ok(true, `Rust recorder differential: ${name}`); }
    catch (error) { ok(false, `Rust recorder differential: ${name}: ${error.message}`); }
  }
};
