'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 上屏的文案由页面的 window.t 提供（本模块自己不带词典，见 error-envelope.js 的 tr）：
// Node 里 root 是 null，取词直接回落成 key —— 不挂词典就断言，测到的是 errEnvRetrySuffix
// 这个 key 本身，而不是用户真正看到的那一句。两份词典都装：中文环境看中文，英文环境
// 看英文（PR #7515 反馈的就是这条 —— 审查容器没有中文 locale，界面却全是中文）。
const CATALOGS = Object.fromEntries(['zh', 'en'].map(locale => [
  locale,
  JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'assets', 'i18n', `${locale}.json`), 'utf8')),
]));
function translator(locale) {
  const dict = CATALOGS[locale];
  return (key, params) => String(dict[key] !== undefined ? dict[key] : key)
    .replace(/\{(\w+)\}/g, (all, name) => (params && name in params ? String(params[name]) : all));
}
// error-envelope 在 require 时就把 root 抓走了，所以 window 必须先有、后 require。
global.window = { t: translator('zh') };

const {
  diagnosticText,
  fromHttpResponse,
  fromWsClose,
  normalize,
  presentation,
  visibleMessage,
} = require('../public/error-envelope');

test('coded HTTP errors keep the original code and message while redacting credentials', () => {
  const envelope = normalize({
    code: 'UPSTREAM_AUTH_403',
    error: { message: 'provider rejected token=super-secret for model glm-5' },
    requestId: 'remote-request-7',
    correlationId: 'correlation-9',
  }, { status: 403, source: 'external_fleet_ws_ticket', scope: 'session' });

  assert.equal(envelope.code, 'UPSTREAM_AUTH_403');
  assert.equal(envelope.message, 'provider rejected token=[redacted] for model glm-5');
  assert.equal(envelope.family, 'auth');
  assert.equal(envelope.retryable, false);
  assert.equal(visibleMessage(envelope),
    '[UPSTREAM_AUTH_403] provider rejected token=[redacted] for model glm-5');
  assert.doesNotMatch(JSON.stringify(envelope), /super-secret/);
});

test('Fleet capability tokens are redacted from original error text', () => {
  const token = `fleet_share_${'x'.repeat(32)}`;
  const envelope = normalize({ code: 'REMOTE_REJECTED', message: `bad capability ${token}` });
  assert.equal(envelope.message, 'bad capability fleet_share_[redacted]');
  assert.equal(diagnosticText(envelope).includes(token), false);
});

test('external Fleet failures are remote and retain cross-instance diagnostics', async () => {
  const response = {
    status: 502,
    headers: new Headers({
      'x-multicc-request-id': 'local-request-2',
      'x-multicc-upstream-request-id': 'remote-request-3',
      'x-correlation-id': 'correlation-4',
    }),
    async text() {
      return JSON.stringify({
        code: 'REMOTE_UNAVAILABLE',
        error: 'connect ECONNREFUSED 10.0.0.5:3000',
        category: 'remote',
        retryable: true,
      });
    },
  };
  const error = await fromHttpResponse(response, {
    source: 'external_fleet_ws_ticket', scope: 'session',
  });

  assert.equal(error.code, 'REMOTE_UNAVAILABLE');
  assert.equal(error.message, 'connect ECONNREFUSED 10.0.0.5:3000');
  assert.equal(error.family, 'remote');
  assert.equal(error.requestId, 'local-request-2');
  assert.equal(error.upstreamRequestId, 'remote-request-3');
  assert.equal(error.correlationId, 'correlation-4');
  assert.match(diagnosticText(error.envelope), /upstreamRequestId: remote-request-3/);
});

test('WebSocket close codes produce actionable connection envelopes', () => {
  const abnormal = fromWsClose({ code: 1006, reason: '' });
  assert.equal(abnormal.code, 'WS_CLOSE_1006');
  assert.equal(abnormal.family, 'network');
  assert.equal(abnormal.retryable, true);
  assert.match(presentation(abnormal, { retrySeconds: 2 }).message, /2s 后重试/);
  // 同一句在英文环境里不能带中文：连接错误页正是英文用户最先看到的那一屏。
  // 信封是「建立时取词」的（fromWsClose 当场就把 errEnvWs1006 翻好了），所以换了语言
  // 要重新建一个信封 —— 拿旧信封再 presentation 只能换掉分类标题，换不掉正文。
  global.window.t = translator('en');
  const english = presentation(fromWsClose({ code: 1006, reason: '' }), { retrySeconds: 2 });
  assert.match(english.message, /retrying in 2s/);
  assert.doesNotMatch(english.message, /[㐀-鿿]/);
  assert.doesNotMatch(english.headline, /[㐀-鿿]/, '英文环境的错误分类标题也不许是中文');
  global.window.t = translator('zh');

  const policy = fromWsClose({ code: 1008, reason: 'grant expired' });
  assert.equal(policy.family, 'auth');
  assert.equal(policy.retryable, false);
  assert.equal(policy.message, 'grant expired');
});
