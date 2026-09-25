'use strict';

// 一条分类结果要被念到四个地方：推送的锁屏标题、页面通知（client / pwa /
// chat-notifications）、聊天条上的标签与朗读、Flutter 的系统通知与语音电话。
//
// 此前每一处都自己抄了一遍词，于是同一个 B：推送说「等待操作」（vocab 的
// pushTitle 当年就是照抄 W 的）、分类条说「后台等待」、电话里说「正在等待你的
// 下一步指示」——三句话，一件事。而 vocab 的 CLASSIFY_DISPLAY.pushTitle 根本
// 没人读。
//
// 现在每侧只有一个入口：
//   · 服务端 src/push/notification-copy.js（push/runtime.js 用它，state-machine
//     那侧只需把 classifyState 一起传进来）
//   · Web    public/shared/notification-copy.js（client / pwa / chat-live-ui /
//     chat-event-controller / chat-notifications / s2s-session）
//   · App    app/lib/utils/session_status_helpers.dart（chat_provider /
//     session_manager / voice_call_service）
//
// 这个文件把它们钉在一起：字母表必须齐、B 说的必须不是 W 的话、Web 与 App 的表
// 必须逐格相等、每个词都必须来自 vocab 或 i18n 词典本身（而不是各写一遍）。
// Dart 是解析而不是 import 的（app 不在 node lane 里），做法与
// tests/test-status-presentation.js 一致。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SERVER = require('../src/push/notification-copy.js');
const WEB = require('../public/shared/notification-copy.js');
const { CLASSIFY_DISPLAY } = require('../src/classify/vocab.js');
const ZH = require('../app/assets/i18n/zh.json');
const EN = require('../app/assets/i18n/en.json');

const DICT = { zh: ZH, en: EN };
const LOCALES = ['zh', 'en'];
const LETTERS = Object.keys(CLASSIFY_DISPLAY);

// 字母 → 文案行 key（三侧共用的那一个抽象）。B 与 W 的 push type 相同，key 不同。
const KEY_OF_LETTER = {
  D: 'succeeded', C: 'waiting', W: 'waiting', B: 'waiting_background',
  E: 'error', P: 'running',
};
// 推送/旧 notify 帧里带的是 type，不是字母。四个真会被推的 + 两个只作状态。
const TYPE_LETTER = {
  succeeded: 'D', completed: 'D', waiting: 'W', waiting_background: 'B',
  error: 'E', running: 'P',
};
const DARWIN_TITLE_PREFIX = /^MultiCC #\{session\}: /;

/** <script src="…file"> 在 HTML 里的位置（-1 表示没有）；带 ?v= 的缓存戳也算。 */
function scriptTagIndex(html, file) {
  const re = /<script[^>]+src="([^"]+)"/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const src = m[1].split('?')[0].split('#')[0];   // 去掉缓存戳
    if (src === file || src.endsWith(`/${file}`)) return m.index;
  }
  return -1;
}

/** 去掉注释再看代码：注释里引用旧文案（"以前这里是「等待操作」"）是说明，不是漂移。 */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function loadCatalog() {
  const ctx = { window: {} };
  vm.runInNewContext(read('public/i18n-catalog.js'), ctx, { filename: 'i18n-catalog.js' });
  return ctx.window.MULTICC_I18N_CATALOG;
}

/** 页面上的 t()：认得的 key 取词典并替换 {param}，不认得的原样返回（i18n.js 的行为）。 */
function fakeTranslate(dict) {
  return (key, params) => {
    if (!(key in dict)) return key;
    let out = dict[key];
    for (const [name, value] of Object.entries(params || {})) {
      out = out.split(`{${name}}`).join(value);
    }
    return out;
  };
}

/** Web 侧这一格的标题尾句：有 titleKey 用词典，没有（P）用内建兜底列。 */
function webTail(letter, locale) {
  const entry = WEB.notificationCopy(letter);
  return entry.titleKey
    ? DICT[locale][entry.titleKey].replace(DARWIN_TITLE_PREFIX, '')
    : WEB.FALLBACK[entry.key][locale];
}

const serverTail = (letter, locale) => SERVER.notificationCopy(letter, locale).title;

// ── Dart 侧的表：解析，不 import ────────────────────────────────────────────

function parseDart() {
  const src = read('app/lib/utils/session_status_helpers.dart');

  const block = /const Map<String, ClassifyNotificationCopy> _classifyCopy = \{([\s\S]*?)\n\};/
    .exec(src);
  assert.ok(block, '_classifyCopy table not found in session_status_helpers.dart');

  const rows = {};
  const rowRe = /'([A-Z])': ClassifyNotificationCopy\(([\s\S]*?)\n  \),/g;
  for (let m = rowRe.exec(block[1]); m; m = rowRe.exec(block[1])) {
    const body = m[2];
    const str = (name) => {
      const hit = new RegExp(`${name}: '([^']*)'`).exec(body);
      return hit ? hit[1] : null;
    };
    const nullable = (name) => (new RegExp(`${name}: null`).test(body) ? null : str(name));
    rows[m[1]] = {
      type: nullable('type'),
      wordKey: str('wordKey'),
      labelKey: str('labelKey'),
      voiceKey: nullable('voiceKey'),
      ding: nullable('ding'),
      background: /background: true/.test(body),
    };
  }

  const typeBlock = /const Map<String, String> _letterOfNotificationType = \{([\s\S]*?)\n\};/
    .exec(src);
  assert.ok(typeBlock, '_letterOfNotificationType table not found');
  const byType = {};
  for (const m of typeBlock[1].matchAll(/'([^']+)': '([A-Z])'/g)) byType[m[1]] = m[2];

  return { rows, byType };
}

// ── 1. 每个字母在每一侧都有一句话 ───────────────────────────────────────────

test('每个分类字母在服务端 / Web / App 三侧都取得到一句通知词', () => {
  const dart = parseDart();
  assert.deepEqual(
    Object.keys(dart.rows).sort(), [...LETTERS].sort(),
    'App 的字母表和服务端 vocab 漂移了',
  );
  assert.deepEqual(
    Object.keys(WEB.COPY).sort(), [...LETTERS].sort(),
    'Web 的字母表和服务端 vocab 漂移了',
  );

  for (const letter of LETTERS) {
    for (const locale of LOCALES) {
      const title = serverTail(letter, locale);
      assert.ok(
        typeof title === 'string' && title.length > 0,
        `服务端 ${letter}/${locale} 没有通知词`,
      );
      assert.equal(webTail(letter, locale), title, `Web 与服务的 ${letter}/${locale} 说不一致`);
      assert.equal(
        DICT[locale][dart.rows[letter].wordKey], title,
        `App 与服务的 ${letter}/${locale} 说不一致`,
      );
    }
  }
});

test('整条标题（含 MultiCC #<会话>: 前缀）三侧同一个字符串', () => {
  const dart = parseDart();
  const real = globalThis.getLang;
  try {
    for (const locale of LOCALES) {
      globalThis.getLang = () => locale; // 页面的 getLang()，决定内建兜底列取哪一列
      for (const letter of LETTERS) {
        const expected = `MultiCC #s1: ${serverTail(letter, locale)}`;
        assert.equal(
          WEB.notificationTitle(letter, 's1', fakeTranslate(DICT[locale])), expected,
          `Web 整条标题与服务的 ${letter}/${locale} 不一致`,
        );
        assert.equal(
          WEB.notificationTitle(letter, 's1', null), expected,
          `Web 无词典页（终端页）的 ${letter}/${locale} 兜底标题与词典不一致`,
        );
        assert.equal(
          `MultiCC #s1: ${DICT[locale][dart.rows[letter].wordKey]}`, expected,
          `App 拼出来的 ${letter}/${locale} 标题与服务端不一致`,
        );
      }
    }
  } finally {
    if (real === undefined) delete globalThis.getLang;
    else globalThis.getLang = real;
  }
});

// ── 2. B 必须说的不是 W 的话（本次改动的核心） ──────────────────────────────

test('B（后台等待）与 W（等待操作）在每一侧都不是同一句话', () => {
  const dart = parseDart();

  for (const locale of LOCALES) {
    assert.notEqual(serverTail('B', locale), serverTail('W', locale), `服务端 B/W 同词 (${locale})`);
  }
  assert.notEqual(WEB.notificationCopy('B').key, WEB.notificationCopy('W').key);
  assert.notEqual(WEB.notificationCopy('B').titleKey, WEB.notificationCopy('W').titleKey);
  assert.notEqual(WEB.notificationCopy('B').voiceKey, WEB.notificationCopy('W').voiceKey);
  assert.notEqual(dart.rows.B.wordKey, dart.rows.W.wordKey, 'App 里 B/W 同词');
  assert.notEqual(dart.rows.B.voiceKey, dart.rows.W.voiceKey, 'App 里 B/W 同一句播报');

  // B 的对外词就是 vocab 给 B 的 label（卡片徽章上那一句），W 的才是 pushTitle。
  assert.equal(serverTail('B', 'zh'), CLASSIFY_DISPLAY.B.label);
  assert.equal(serverTail('W', 'zh'), CLASSIFY_DISPLAY.W.pushTitle);
  assert.notEqual(serverTail('B', 'zh'), CLASSIFY_DISPLAY.W.pushTitle, 'B 又在借用 W 的话');

  // background 这一格就是三侧区分「等你」和「等后台」的唯一依据。
  assert.equal(WEB.notificationCopy('B').background, true);
  assert.equal(WEB.notificationCopy('W').background, false);
  assert.equal(dart.rows.B.background, true);
  assert.equal(dart.rows.W.background, false);
});

// ── 3. Web 与 App 的表逐格相等，且都服从 vocab / 词典 ───────────────────────

test('Web 与 App 的字母表逐格相等，词都来自 vocab 与 i18n 词典', () => {
  const dart = parseDart();

  for (const letter of LETTERS) {
    const web = WEB.notificationCopy(letter);
    const app = dart.rows[letter];

    assert.equal(web.key, KEY_OF_LETTER[letter], `Web ${letter} 的词条 key 不对`);
    assert.equal(web.type, app.type, `${letter} 的 push type 两端不一致`);
    assert.equal(web.voiceKey, app.voiceKey, `${letter} 的播报 key 两端不一致`);
    assert.equal(web.ding, app.ding, `${letter} 的提示音桶两端不一致`);
    assert.equal(web.background, app.background, `${letter} 的 background 标记两端不一致`);
    assert.equal(web.labelKey, app.labelKey, `${letter} 的短标签 key 两端不一致`);

    // 标签是 vocab 的 label，短标签两侧同一串词。
    assert.equal(DICT.zh[web.labelKey], CLASSIFY_DISPLAY[letter].label, `${letter} 的标签不是 vocab 的 label`);

    // 播报句是 vocab 的 voiceText（中英两列都必须与词典对上）。
    if (web.voiceKey) {
      assert.equal(
        DICT.zh[web.voiceKey], CLASSIFY_DISPLAY[letter].voiceText,
        `${letter} 的播报词不是 vocab 的 voiceText`,
      );
      assert.equal(WEB.FALLBACK[web.key].voiceZh, DICT.zh[web.voiceKey]);
      assert.equal(WEB.FALLBACK[web.key].voiceEn, DICT.en[web.voiceKey]);
      assert.equal(WEB.notificationVoice(letter, null), DICT.zh[web.voiceKey]);
    } else {
      assert.equal(WEB.notificationVoice(letter, null), '', `${letter} 不该有播报句`);
    }

    // 内建兜底列（无 i18n 页）必须就是词典里的同一句话。
    for (const locale of LOCALES) {
      assert.equal(
        WEB.FALLBACK[web.key][locale], webTail(letter, locale),
        `${letter}/${locale} 的内建兜底与词典不一致`,
      );
    }
    assert.equal(WEB.notificationDing(letter), web.ding);
  }

  // 分类徽章的短标签（_classifyLabelKey）与通知表必须同词：同一个字母，卡片上
  // 写「后台等待」而锁屏写别的，就是这次要收掉的那种漂移。
  const badgeBlock = /const Map<String, String> _classifyLabelKey = \{([\s\S]*?)\n\};/
    .exec(read('app/lib/utils/session_status_helpers.dart'));
  assert.ok(badgeBlock, '_classifyLabelKey not found');
  const badge = {};
  for (const m of badgeBlock[1].matchAll(/'([A-Z])': '([^']+)'/g)) badge[m[1]] = m[2];
  assert.deepEqual(badge, Object.fromEntries(LETTERS.map(l => [l, dart.rows[l].labelKey])),
    '徽章短标签与通知表的标签 key 漂移了');

  // vocab 的 pushTitle 不再只是摆设：服务端推送词就是它（B 见上，用 B 的 label）。
  for (const letter of ['D', 'W', 'E']) {
    assert.equal(serverTail(letter, 'zh'), CLASSIFY_DISPLAY[letter].pushTitle);
  }
  // 没有推送种类的那两档（C 已退役、P 进行中）绝不冒充成功。
  for (const letter of ['C', 'P']) {
    assert.equal(CLASSIFY_DISPLAY[letter].pushType, null, `vocab ${letter}.pushType 不再是 null`);
    assert.notEqual(SERVER.copyKeyFor(letter), 'succeeded', `${letter} 被念成了成功`);
  }
});

// ── 4. type ↔ letter 的换算三侧一致 ─────────────────────────────────────────

test('粗粒度 type 折回字母的规则：服务端 / Web / App 一致', () => {
  const dart = parseDart();
  assert.deepEqual(dart.byType, TYPE_LETTER, 'App 的 type→字母表与 Web/服务端漂移了');

  for (const [type, letter] of Object.entries(TYPE_LETTER)) {
    assert.equal(SERVER.copyKeyFor(type), KEY_OF_LETTER[letter], `服务端 ${type} 折算错了`);
    assert.equal(WEB.notificationCopy(type).letter, letter, `Web ${type} 折算错了`);
    assert.equal(WEB.notificationCopy(type).key, KEY_OF_LETTER[letter]);
    assert.equal(SERVER.copyKeyFor(type.toUpperCase()), KEY_OF_LETTER[letter], `${type} 大写后折算错了`);
    // 字母本身走的是同一条路。
    assert.equal(SERVER.copyKeyFor(letter), KEY_OF_LETTER[letter]);
    assert.equal(WEB.notificationCopy(letter).letter, letter);
  }

  // 认不出的东西绝不冒充成功：单字母落 W，整词沿用运行时老规矩落成功档。
  assert.equal(SERVER.copyKeyFor('X'), 'waiting');
  assert.equal(WEB.notificationCopy('X').letter, 'W');
  assert.equal(SERVER.copyKeyFor(''), 'succeeded');
  assert.equal(WEB.notificationCopy('').letter, 'W');
  assert.equal(SERVER.copyKeyFor('info'), 'succeeded');
});

// ── 5. 接线：各处只调用入口，不自己写词 ────────────────────────────────────

test('web 的各通知面都走同一张表', () => {
  // chat-event-controller 不直接拿表：它经 chat-live-ui 的 classifyDisplay（标签 +
  // 播报 + 提示音都在那一个对象里），所以两种接法都算数。
  const consumers = [
    'public/client.js',
    'public/pwa.js',
    'public/chat-live-ui.js',
    'public/chat-event-controller.js',
    'public/chat-notifications.js',
    'public/s2s-session.js',
  ];
  for (const file of consumers) {
    const src = read(file);
    assert.ok(
      /notification-copy\.js|MultiCCNotificationCopy|classifyDisplay\(/.test(src),
      `${file} 没有用共享文案表`,
    );
    // 自己抄的中文（含引号）就是漂移的开始。
    assert.ok(
      !/'(执行成功|本轮执行成功|等待操作|等待你的操作|出现异常|任务异常|后台等待|正在等待你的下一步指示。)'/.test(code(file)),
      `${file} 还留着自己写的中文通知词`,
    );
  }

  // C 已退役（服务端 parseClassifyResult 折成 W）：那条死分支不许回来。
  assert.ok(
    !/classifyState === 'C'/.test(read('public/chat-event-controller.js')),
    'chat-event-controller 又出现了死掉的 C 分支',
  );

  // 页面必须真的把这张表加载进来，且在第一个用它的脚本之前。
  const order = [
    ['public/chat.html', 'chat-live-ui.js'],
    ['public/index.html', 'client.js'],
    ['public/air.html', 'pwa.js'],
  ];
  for (const [page, firstConsumer] of order) {
    const html = read(page);
    const table = html.indexOf('shared/notification-copy.js');
    assert.ok(table !== -1, `${page} 没有加载 shared/notification-copy.js`);
    const consumer = scriptTagIndex(html, firstConsumer);
    assert.ok(consumer !== -1, `${page} 里找不到 ${firstConsumer} 的 script 标签`);
    assert.ok(table < consumer, `${page} 在 ${firstConsumer} 之后才加载文案表`);
  }
});

test('服务端推送的词只在一处；拿到字母时 B 才说自己的话，只剩 type 时退回 W', () => {
  const runtime = read('src/push/runtime.js');
  assert.ok(runtime.includes("require('./notification-copy')"), 'push/runtime.js 没接上文案表');
  assert.ok(
    !/'(执行成功|等待操作|出现异常)'/.test(runtime),
    'push/runtime.js 又自己写了一份通知词',
  );

  // notify() 必须能从调用方拿到精确的字母（options.classifyState）；只拿到粗粒度
  // type 时 B 与 W 就分不开了 —— 这时推送只能退回 W 的话（下面这条断言把这个降级
  // 行为写死，免得有人以为 B 的推送词已经生效）。state-machine.js 的
  // triggerPush(sessionId, pushType, waitMsg) 目前没传第四个参数，是本次留下的
  // 唯一缺口（该文件由另一个 agent 持有，只在报告里交接）。
  assert.match(runtime, /function notify\(|classifyState/, 'notify() 拿不到精确字母');
  assert.equal(
    SERVER.notificationCopy('waiting', 'zh').title,
    SERVER.notificationCopy('W', 'zh').title,
    '只给粗粒度 type 时应当退到 W 的话',
  );
  assert.notEqual(SERVER.notificationCopy('waiting_background', 'zh').title,
    SERVER.notificationCopy('waiting', 'zh').title);
});

test('App 的三个通知面都走 session_status_helpers 的表', () => {
  const consumers = {
    'app/lib/providers/chat_provider.dart': /classifyNotificationWord\(/,
    'app/lib/providers/session_manager.dart': /classifyNotificationWord\(/,
    'app/lib/services/voice_call_service.dart': /classifyNotification(Voice|Word)\(/,
  };
  for (const [file, pattern] of Object.entries(consumers)) {
    assert.match(read(file), pattern, `${file} 没有用共享文案表`);
  }

  const dart = read('app/lib/utils/session_status_helpers.dart');
  assert.match(dart, /ClassifyNotificationCopy classifyNotificationCopy\(/);
  assert.match(dart, /String classifyNotificationWord\(/);
  assert.match(dart, /String classifyNotificationVoice\(/);

  // 旧的三份手抄词都不许回来。
  for (const file of Object.keys(consumers)) {
    assert.ok(
      !read(file).includes('正在等待你的下一步指示'),
      `${file} 还留着自己写的播报句`,
    );
  }
  for (const key of ['apiError', 'waitingInteraction', 'waitingBackground']) {
    assert.ok(
      !new RegExp(`t\\('${key}'\\)`).test(dart + Object.keys(consumers).map(read).join('\n')),
      `${key} 这条同义 key 又被引用了`,
    );
  }
});

// ── 6. 词典：新 key 在，同义的孤儿 key 不在 ────────────────────────────────

test('i18n 词典与生成物：新增的 B 标题在，被替换掉的同义 key 已清掉', () => {
  const catalog = loadCatalog();
  const required = [
    'notificationSucceededTitle', 'notificationWaitingTitle',
    'notificationWaitingBackgroundTitle', 'notificationErrorStateTitle',
  ];
  for (const key of required) {
    for (const locale of LOCALES) {
      assert.ok(
        catalog[locale][key],
        `i18n-catalog.js (${locale}) 缺 ${key}：页面上会直接渲染出 key 本身`,
      );
      assert.equal(DICT[locale][key], catalog[locale][key], `${key}/${locale} 词典与生成物不一致`);
    }
  }
  assert.equal(
    DICT.zh.notificationWaitingBackgroundTitle.replace(DARWIN_TITLE_PREFIX, ''),
    DICT.zh.classifyWaitingBackground,
    'B 的标题尾句必须就是 B 的词',
  );

  // 这些 key 当年各自表述同一件事，现在没有任何引用点了。
  const orphans = [
    'apiError', 'waitingInteraction', 'waitingBackground',
    'tbRunRunning', 'tbRunWaiting', 'tbRunError', 'tbRunDone', 'tbRunIdle',
    'tbClassWaitingReply', 'tbClassPending', 'tbClassRunning', 'tbClassRetryWait',
    'tbClassFailed', 'queueIdle', 'queueQueued', 'queueRunning', 'queueWaiting',
    'queueError',
  ];
  for (const key of orphans) {
    for (const locale of LOCALES) {
      assert.ok(!(key in catalog[locale]), `i18n-catalog.js (${locale}) 还留着孤儿 key ${key}`);
      assert.ok(!(key in DICT[locale]), `i18n/${locale}.json 还留着孤儿 key ${key}`);
    }
  }
});
