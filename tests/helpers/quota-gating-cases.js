'use strict';

// The shared input table for every bar/quota gating decision.
//
// The gates live in THREE independent copies: the server renders the words once
// (src/quota/quota-bar-view.js), but web (public/chat-rate-limit.js) and the
// Flutter app (app/lib/models/vendor_quota.dart) each mirror the baseUrl/cli
// predicates that decide WHICH bar may be on screen. Those predicates are pure
// string sniffing over a baseUrl, which is exactly the kind of code that drifts
// silently: a rule fixed on one end never reaches the other, and the symptom is
// a bar that exists on the phone and not in the browser (or vice versa).
//
// This module is the one input list both ends are measured against:
//   • scripts/generate-quota-gating-fixture.js runs it through the web module
//     (the authority) and writes tests/fixtures/quota-gating-golden.json;
//   • tests/test-quota-gating-parity.js re-runs it against the live web module,
//     so a predicate change that is not accompanied by a regenerated fixture
//     fails (the fixture diff IS the review);
//   • app/test/quota_gating_parity_test.dart re-runs it against the Dart mirror,
//     so a Dart copy that stops agreeing with the web fails too.
//
// Every entry carries a `why`: the trap it encodes. A case with no trap is a
// case nobody can review later.

// Every CLI id the product accepts (src/session-dto.js SUPPORTED_CLIS) plus ''
// — an unknown id must not silently behave like a member of a family.
const CLIS = Object.freeze([
  'claude', 'claude-exp', 'codex', 'codex-exp',
  'opencode', 'qoder', 'zcode', 'kimi', 'codebuddy', 'dsh',
  'gemini', 'grok',
  '',
]);

// The `provider` argument of providerMatchesCli. The first four are what
// limitProvider() can actually produce; the rest are unreachable from today's
// call sites on purpose: they pin what happens to an unexpected kind instead of
// leaving the fail-through undecided.
const WINDOW_KINDS = Object.freeze([
  'claude', 'glm', 'codex', 'opencode',
  'qoder', 'kimi', '',
]);

const BASE_URLS = Object.freeze([
  { label: 'official-login', url: '', why: '官方登录：没有 baseUrl' },
  { label: 'blank', url: '   ', why: '只有空白，必须和官方登录等价' },
  { label: 'anthropic', url: 'https://api.anthropic.com/v1', why: 'Claude 官方域名' },
  { label: 'anthropic-upper-port', url: 'https://API.ANTHROPIC.COM:8443/v1', why: '大写 host + 端口：host 判定必须小写化并丢掉端口' },
  { label: 'anthropic-subdomain', url: 'https://eu.api.anthropic.com', why: '子域也算官方（后缀匹配）' },
  { label: 'claude-ai', url: 'https://api.claude.ai/api', why: 'claude.ai 与 anthropic.com 同族' },
  { label: 'anthropic-lookalike', url: 'https://anthropic.com.evil.example/v1', why: '后缀陷阱：含 anthropic.com 但不是它的域' },
  { label: 'proxy-host-only', url: 'https://my-claude-proxy.example.com/v1', why: 'host 里有 claude-proxy 但路径不是借道路径 → 不是借道' },
  { label: 'zhipu-cn', url: 'https://open.bigmodel.cn/api/anthropic', why: '智谱国内：claude CLI 可以走它，glm 窗口必须能显示' },
  { label: 'zhipu-intl', url: 'https://api.z.ai/api/paas/v4', why: '智谱国际站' },
  { label: 'zhipu-upper', url: 'https://API.Z.AI/api', why: '大写 host 也要认出智谱' },
  { label: 'ark-coding', url: 'https://ark.cn-beijing.volces.com/api/coding/v3', why: '火山 Coding Plan 路径' },
  { label: 'ark-agent-plan', url: 'https://ark.cn-beijing.volces.com/api/plan/v3', why: '火山 Agent Plan 路径（两档窗口不同）' },
  { label: 'ark-lookalike', url: 'https://notvolces.com/api/coding/v3', why: '域名后缀陷阱：不得只 contains("volces.com")' },
  { label: 'deepseek', url: 'https://api.deepseek.com/anthropic', why: 'DeepSeek 预付费余额的唯一宿主' },
  { label: 'moonshot', url: 'https://api.moonshot.cn/v1', why: 'Kimi 的 moonshot 域' },
  { label: 'kimi-coding', url: 'https://api.kimi.com/coding/', why: 'Kimi 的 kimi.com 域' },
  { label: 'relay-claude', url: 'https://relay.example:3000/claude-proxy/glm/remote', why: '借道 claude 协议（被借的可能是 GLM）' },
  { label: 'relay-claude-trailing', url: 'https://relay.example/claude-proxy/abc/remote/', why: '尾斜杠不得改变协议判定' },
  { label: 'relay-claude-incomplete', url: 'https://relay.example/claude-proxy/abc', why: '缺 /remote → 不是 claude 协议透传路径' },
  { label: 'relay-codex-lan', url: 'http://192.168.1.9:3000/codex-proxy/official', why: '借道 codex 协议（局域网 IP + http）' },
  { label: 'relay-codex-tailscale', url: 'https://mac.tail94695a.ts.net/codex-proxy/cx', why: '借道 codex 协议（Tailscale 域名）' },
  { label: 'relay-codex-empty-id', url: 'https://relay.example/codex-proxy/', why: '借道路径缺 provider id → 不算借道' },
  { label: 'relay-loopback-ip', url: 'http://127.0.0.1:3000/claude-proxy/abc/remote', why: '回环是本机自己的转发管道，永远不是借道' },
  { label: 'relay-loopback-name', url: 'http://localhost:3000/codex-proxy/abc', why: 'localhost 同上' },
  { label: 'relay-loopback-ipv6', url: 'http://[::1]:3000/claude-proxy/abc/remote', why: 'IPv6 回环：方括号形式也要认出来' },
  { label: 'non-http-scheme', url: 'ftp://relay.example/claude-proxy/abc/remote', why: '非 http(s) 一律不是借道' },
  { label: 'custom-host', url: 'https://llm.internal.corp/v1', why: '任意第三方端点：既不是官方也不是借道' },
  { label: 'malformed', url: 'not a url', why: '解析失败必须退化成「不是任何东西」，不得抛异常' },
]);

// host/plan traits: one row per baseUrl, boolean-ish except host + relayProtocol.
function traitsFor(api, baseUrl) {
  return {
    host: api.hostFromBaseUrl(baseUrl),
    ark: api.isArkBaseUrl(baseUrl),
    zhipu: api.isZhipuBaseUrl(baseUrl),
    kimi: api.isKimiBaseUrl(baseUrl),
    deepseek: api.isDeepseekBaseUrl(baseUrl),
    claudeProvider: api.isClaudeProvider(baseUrl),
    relayProtocol: api.relayProtocolFromBaseUrl(baseUrl),
    arkPlan: api.arkPlanFromBaseUrl(baseUrl),
  };
}

/**
 * Build the whole fixture from a gating module. [api] must expose the web
 * module's pure predicates (`public/chat-rate-limit.js`); the generator passes
 * the live module, the parity test re-runs the same call to detect staleness.
 */
function buildGatingFixture(api) {
  const providerMatchesCliIn = {};
  for (const kind of WINDOW_KINDS) {
    for (const { label, url } of BASE_URLS) {
      providerMatchesCliIn[`${kind}@${label}`] =
        CLIS.filter((cli) => api.providerMatchesCliIn(kind, cli, url));
    }
  }
  const balanceBarVisibleFor = {};
  for (const { label, url } of BASE_URLS) {
    balanceBarVisibleFor[label] = CLIS.filter((cli) => api.balanceBarVisibleFor(cli, url));
  }
  const baseUrlTraits = {};
  for (const { label, url } of BASE_URLS) baseUrlTraits[label] = traitsFor(api, url);

  return {
    description: '借道/供应商窗口与余额条的门禁矩阵：web 是权威实现，Dart 镜像必须逐格一致',
    authority: 'public/chat-rate-limit.js',
    mirror: 'app/lib/models/vendor_quota.dart',
    generator: 'scripts/generate-quota-gating-fixture.js',
    clis: [...CLIS],
    windowKinds: [...WINDOW_KINDS],
    baseUrls: BASE_URLS.map(({ label, url, why }) => ({ label, url, why })),
    providerMatchesCliIn,
    balanceBarVisibleFor,
    baseUrlTraits,
  };
}

module.exports = { CLIS, WINDOW_KINDS, BASE_URLS, buildGatingFixture };
