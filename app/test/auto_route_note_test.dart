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
}
