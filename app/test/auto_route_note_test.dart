import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/chat_provider.dart';

Map<String, dynamic> _route(
  Map<String, dynamic> routing, [
  Map<String, dynamic> extra = const {},
]) => {
  'phase': 'selected',
  'providerId': 'p-glm',
  'providerName': '智谱',
  'model': 'glm-4.6',
  'tier': 'strong',
  'preferredTier': 'strong',
  'routing': {'tierCount': 2, ...routing},
  ...extra,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));
  tearDown(() => I18n.switchLang('zh'));

  test('a routing wait frame reads as Jev judging, not memory distill', () {
    expect(
      admissionProgressI18nKey({
        'stage': 'auto_provider_routing',
        'state': 'waiting',
      }),
      'autoRouteJudging',
    );
    expect(
      admissionProgressI18nKey({'state': 'waiting'}),
      'admissionMemoryWaiting',
    );
  });

  test('the note names the verdict and the line that answers', () {
    expect(
      autoRouteNote(
        _route({
          'source': 'jev',
          'code': 'jev_choice',
          'tierIndex': 1,
          'latencyMs': 840,
        }),
      ),
      '🧭 Jev 判定为复杂任务 · 选用 智谱（glm-4.6） · 用时 0.8 秒',
    );
    expect(
      autoRouteNote(
        _route(
          {'source': 'jev', 'code': 'jev_low_confidence', 'tierIndex': 1},
          {'model': '_default_'},
        ),
      ),
      '🧭 Jev 判定为复杂任务（不太有把握，已往强的提一档） · 选用 智谱',
    );
    expect(
      autoRouteNote(
        _route({
          'source': 'jev',
          'code': 'jev_choice',
          'tierIndex': 1,
          'tierCount': 3,
        }),
      ),
      startsWith('🧭 Jev 判定为中等任务'),
    );
    expect(
      autoRouteNote(
        _route(
          {'source': 'jev', 'code': 'jev_choice', 'tierIndex': 0},
          {'tier': 'strong', 'preferredTier': 'weak'},
        ),
      ),
      '🧭 Jev 判定为简单任务 · 选用 智谱（glm-4.6）（简单任务的线路暂不可用，改用这条）',
    );
    expect(
      autoRouteNote(
        _route({
          'source': 'fallback',
          'code': 'jev_http_502',
          'onUnknown': 'priority',
        }),
      ),
      '🧭 Jev 没判断出来（网关返回 502）· 按线路顺序来 · 选用 智谱（glm-4.6）',
    );
    expect(
      autoRouteNote(_route({'source': 'fallback', 'code': 'jev_key_missing'})),
      contains('还没配置 Jev key'),
    );
    I18n.switchLang('en');
    expect(
      autoRouteNote(
        _route({'source': 'jev', 'code': 'jev_choice', 'tierIndex': 0}),
      ),
      startsWith('🧭 Jev rated this a simple task'),
    );
  });

  test('a price-ranked pick draws no price: it is routing input, not UI', () {
    // 价格只喂给服务端的 Jev 分层，不在界面上外显 —— 事件带不带 price、
    // price 是数字还是对象，文案都必须一个字符不差。
    const plain = '🧭 Jev 判定为复杂任务 · 选用 智谱（glm-4.6）';
    expect(
      autoRouteNote(_route(
        {'source': 'jev', 'code': 'jev_choice', 'tierIndex': 1},
        {'price': 2.5, 'priceSource': 'price_table'},
      )),
      plain,
    );
    expect(
      autoRouteNote(_route(
        {'source': 'jev', 'code': 'jev_choice', 'tierIndex': 1},
        {
          'price': {'input': 3, 'output': 15, 'blended': 6, 'source': 'seed'},
        },
      )),
      plain,
    );
    I18n.switchLang('en');
    expect(
      autoRouteNote(_route(
        {'source': 'jev', 'code': 'jev_choice', 'tierIndex': 1},
        {'price': 2.5},
      )),
      startsWith('🧭 Jev rated this a complex task'),
    );
    expect(autoRouteNote(_route(
      {'source': 'jev', 'code': 'jev_choice', 'tierIndex': 1},
      {'price': 2.5},
    )).contains('1M'), isFalse);
  });

  test('a planned lane switch names the two lanes', () {
    expect(
      autoRouteNote({
        'routePhase': 'cli_switch_planned',
        'fromCli': 'claude',
        'cli': 'codex',
      }),
      'Auto 换道：Claude → Codex',
    );
    // 服务端在计划的帧里也带 reasonCode，但那是给日志看的，聊天里不说。
    expect(
      autoRouteNote({
        'routePhase': 'cli_switch_planned',
        'fromCli': 'opencode',
        'cli': 'kimi',
        'reasonCode': 'price',
      }),
      'Auto 换道：OpenCode → Kimi Code',
    );
    // 同一条车道 = 什么都没动；说不出的车道名不值得发一条聊天；老键 `phase` 也认。
    expect(
      autoRouteNote({
        'routePhase': 'cli_switch_planned',
        'fromCli': 'claude',
        'cli': 'claude',
      }),
      isEmpty,
    );
    expect(
      autoRouteNote({'routePhase': 'cli_switch_planned', 'cli': 'codex'}),
      isEmpty,
    );
    expect(
      autoRouteNote({
        'phase': 'cli_switch_planned',
        'fromCli': 'codex-exp',
        'cli': 'zcode',
      }),
      'Auto 换道：Codex → ZCode',
    );
  });

  test('the lane plan leaves the verdict line alone', () {
    // 换道是**计划**：`cli_switched` 会自己画一条，判断行不该跟着改写，也不该
    // 把等着的那条判断行扔掉。
    final line = AutoRouteLine();
    final messages = <ChatMessage>[];
    line.judging(messages);
    expect(
      line.settle(messages, {
        'routePhase': 'cli_switch_planned',
        'fromCli': 'claude',
        'cli': 'opencode',
      }),
      isFalse,
    );
    expect(messages.single.content, '🧭 Jev 正在判断这条消息的难度…');
    expect(
      line.settle(
        messages,
        _route({'source': 'jev', 'code': 'jev_choice', 'tierIndex': 1}),
      ),
      isTrue,
    );
    expect(messages, hasLength(1));
    expect(messages.single.content, startsWith('🧭 Jev 判定为复杂任务'));
  });

  test('only a selected route with a routing verdict speaks', () {
    expect(autoRouteNote({'phase': 'switched', 'routing': {}}), isEmpty);
    expect(autoRouteNote({'phase': 'selected', 'providerName': 'x'}), isEmpty);
  });

  test('the judging line is rewritten in place into the verdict', () {
    final line = AutoRouteLine();
    final messages = <ChatMessage>[
      ChatMessage(role: MessageRole.user, content: '重构一下'),
    ];
    line.judging(messages);
    line.judging(messages); // a repeated frame keeps one line
    expect(messages.map((m) => m.content), ['重构一下', '🧭 Jev 正在判断这条消息的难度…']);
    expect(
      line.settle(
        messages,
        _route({'source': 'jev', 'code': 'jev_choice', 'tierIndex': 1}),
      ),
      isTrue,
    );
    expect(messages, hasLength(2));
    expect(messages.last.role, MessageRole.system);
    expect(messages.last.content, startsWith('🧭 Jev 判定为复杂任务'));

    // A later turn nobody judged (continuation, nudge) stays silent.
    expect(
      line.settle(
        messages,
        _route({'source': 'fallback', 'code': 'jev_not_prepared'}),
      ),
      isFalse,
    );
    expect(messages, hasLength(2));

    // A turn whose message was judged elsewhere still gets its line.
    expect(
      line.settle(
        messages,
        _route({'source': 'fallback', 'code': 'jev_timeout'}),
      ),
      isTrue,
    );
    expect(messages.last.content, contains('超时'));
  });

  test('a message that never got admitted drops its judging line', () {
    final line = AutoRouteLine();
    final messages = <ChatMessage>[];
    line.judging(messages);
    line.drop(messages);
    expect(messages, isEmpty);
    expect(
      line.settle(
        messages,
        _route({'source': 'fallback', 'code': 'jev_not_prepared'}),
      ),
      isFalse,
    );
  });

  test('a persisted Auto route note parses as a system line', () {
    final message = historyRecordMessage({
      'id': 'm1a2b3-7',
      'role': 'system',
      'kind': 'auto_route',
      // The server's plain fallback for readers that don't know `autoRoute`.
      'content': 'Auto → 智谱 · glm-4.6',
      'ts': 1790000000000,
      'clientMsgId': 'auto-route-t1-1',
      'autoRoute': _route({
        'source': 'jev',
        'code': 'jev_choice',
        'tierIndex': 1,
      }),
    });
    expect(message, isNotNull);
    expect(message!.role, MessageRole.system);
    expect(message.content, '🧭 Jev 判定为复杂任务 · 选用 智谱（glm-4.6）');
    expect(message.id, 'm1a2b3-7');
    expect(message.clientMsgId, 'auto-route-t1-1');
    expect(message.timestamp.millisecondsSinceEpoch, 1790000000000);
  });

  test('a note with no verdict to show is dropped, not shown raw', () {
    // `source: jev` without a tier verdict formats empty.
    expect(
      historyRecordMessage({
        'id': 'm1a2b3-8',
        'role': 'system',
        'content': 'Auto → 智谱 · glm-4.6',
        'autoRoute': _route({'source': 'jev', 'code': 'jev_choice'}),
      }),
      isNull,
    );
    // Records that carry their own content are untouched.
    final plain = historyRecordMessage({
      'id': 'm1a2b3-9',
      'role': 'system',
      'content': '上下文已清空',
    });
    expect(plain!.content, '上下文已清空');
    expect(plain.role, MessageRole.assistant);
  });

  test('settling stamps the persisted note key onto the live line', () {
    final event = _route(
      {'source': 'jev', 'code': 'jev_choice', 'tierIndex': 1},
      {'noteClientMsgId': 'auto-route-t1-1'},
    );
    // The judging line is rewritten in place, so it adopts the key too.
    final line = AutoRouteLine();
    final messages = <ChatMessage>[];
    line.judging(messages);
    expect(messages.single.clientMsgId, isNull);
    line.settle(messages, event);
    expect(messages.single.clientMsgId, 'auto-route-t1-1');

    // A turn with no judging line (judged elsewhere) gets one, keyed.
    final fresh = AutoRouteLine();
    final other = <ChatMessage>[];
    fresh.settle(other, event);
    expect(other.single.role, MessageRole.system);
    expect(other.single.clientMsgId, 'auto-route-t1-1');
  });

  test('a replayed note record yields to the live line that owns it', () {
    final line = AutoRouteLine();
    final messages = <ChatMessage>[];
    line.judging(messages);
    line.settle(
      messages,
      _route(
        {'source': 'jev', 'code': 'jev_choice', 'tierIndex': 1},
        {'noteClientMsgId': 'auto-route-t1-1'},
      ),
    );
    final replay = [
      historyRecordMessage({
        'id': 'm1a2b3-7',
        'role': 'system',
        'content': 'Auto → 智谱 · glm-4.6',
        'clientMsgId': 'auto-route-t1-1',
        'autoRoute': _route({
          'source': 'jev',
          'code': 'jev_choice',
          'tierIndex': 1,
        }),
      })!,
      historyRecordMessage({
        'id': 'm1a2b3-8',
        'role': 'system',
        'content': 'Auto → 智谱 · glm-4.6',
        'clientMsgId': 'auto-route-t0-1',
        'autoRoute': _route({
          'source': 'jev',
          'code': 'jev_choice',
          'tierIndex': 0,
        }),
      })!,
    ];
    line.adoptReplay(replay, messages);
    // Another turn's note stays; ours is already on screen.
    expect(replay.map((m) => m.clientMsgId), ['auto-route-t0-1']);
    expect(messages, hasLength(1));

    // Once that line is gone from the transcript, the record is authoritative.
    messages.clear();
    line.adoptReplay(replay, messages);
    expect(replay, hasLength(1));

    // And a line with no key of its own claims nothing.
    final idle = AutoRouteLine();
    idle.settle(
      messages,
      _route({'source': 'jev', 'code': 'jev_choice', 'tierIndex': 1}),
    );
    idle.adoptReplay(replay, messages);
    expect(replay, hasLength(1));
  });
}
