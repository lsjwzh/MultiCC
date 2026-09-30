import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/transcript_live_folder.dart';
import 'package:multicc_app/widgets/message_bubble.dart';
import 'package:multicc_app/widgets/tool_card.dart';

// 「模型归属」那一小段字：assistant 消息页脚里说明这条回复是哪个模型产出的。
//
// 两条路必须说出同一句话：历史 JSON 里的 `modelAttribution`（重开会话）与实时
// `result` 事件里的同名键（刚跑完那条气泡）。四个键都可能缺、整个字段也可能不
// 出现（老历史），那种情况整段不渲染 —— 不留空壳。
//
// 落点（与 Web 端同一条规则，见 public/chat-live-ui.js 的 attachModelAttribution）：
// 贴在页脚里那行「⏱ N tools · 时长 wall-clock」的最右端；没有那一行（工具不足
// 两个）就退到 🕐/⏱ 时间行的最右端；两行都没有才自占一行。三种情况下它都跟宿主
// 行的文字**同一行**，绝不为了它多出一行。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  const key = ValueKey('message-model-attribution');
  const trajectoryLabel = Key('tool-trajectory-label');

  const attribution = ModelAttribution(
    cli: 'claude',
    providerId: 'zhipu',
    providerName: 'Zhipu',
    model: 'glm-4.6',
  );
  const attributionText = '由 Claude · Zhipu · glm-4.6 产出';
  const hint = '这条消息由哪个模型产出。同一段会话里可以换过多次，所以逐条标注。';

  group('ModelAttribution 解析', () {
    test('历史 json 的四个键原样读出', () {
      final msg = ChatMessage.fromHistory({
        'id': 'm-1',
        'role': 'assistant',
        'content': '完成',
        'modelAttribution': {
          'cli': 'claude',
          'providerId': 'zhipu',
          'providerName': 'Zhipu',
          'model': 'glm-4.6',
        },
      });
      expect(msg.modelAttribution, isNotNull);
      expect(msg.modelAttribution!.cli, 'claude');
      expect(msg.modelAttribution!.providerId, 'zhipu');
      expect(msg.modelAttribution!.providerName, 'Zhipu');
      expect(msg.modelAttribution!.model, 'glm-4.6');
    });

    test('缺字段 / 畸形字段一律得到 null，绝不抛', () {
      // 老历史：整个字段不出现。
      expect(
        ChatMessage.fromHistory({'role': 'assistant', 'content': 'x'})
            .modelAttribution,
        isNull,
      );
      // 不是 Map。
      expect(
        ChatMessage.fromHistory({
          'role': 'assistant',
          'content': 'x',
          'modelAttribution': 'nope',
        }).modelAttribution,
        isNull,
      );
      // 空 Map / 四个键全是空值 / 服务端的 `_default_` 哨兵。
      expect(ModelAttribution.fromJson(const <String, dynamic>{}), isNull);
      expect(
        ModelAttribution.fromJson(const {
          'cli': '',
          'providerId': null,
          'providerName': '  ',
          'model': '_default_',
        }),
        isNull,
      );
    });

    test('只有部分键时只留那几项，_default_ 当没说', () {
      final partial = ModelAttribution.fromJson(const {
        'model': 'glm-4.6',
        'providerName': '_default_',
      });
      expect(partial, isNotNull);
      expect(partial!.model, 'glm-4.6');
      expect(partial.providerName, isNull);
      expect(partial.cli, isNull);
    });
  });

  group('归属的三个展示名', () {
    test('车道/线路都走既有展示表，未知 id 回落成 id 本身', () {
      expect(
        modelAttributionSegments(
          const ModelAttribution(
            cli: 'claude-exp',
            providerId: 'zhipu',
            providerName: 'Zhipu',
            model: 'glm-4.6',
          ),
        ),
        ['Claude', 'Zhipu', 'glm-4.6'],
      );
      // 表里没有的车道 id：照实写 id，不假借别家的名字。
      expect(
        modelAttributionSegments(
          const ModelAttribution(cli: 'mystery-lane', model: 'x-1'),
        ),
        ['mystery-lane', 'x-1'],
      );
      // 线路没有解析名就退到 id；模型键缺了就不占一段。
      expect(
        modelAttributionSegments(const ModelAttribution(providerId: 'zhipu')),
        ['zhipu'],
      );
      // 没有归属 = 空表（调用方据此整段不渲染）。
      expect(modelAttributionSegments(null), isEmpty);
    });
  });

  group('气泡渲染', () {
    testWidgets('归属贴在轨迹文案行「N tools · 时长 wall-clock」的最右端', (tester) async {
      await tester.pumpWidget(
        _host(
          ChatMessage(
            role: MessageRole.assistant,
            content: '完成',
            toolCalls: _measuredTools(),
            durationMs: 10000,
            modelAttribution: attribution,
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(trajectoryLabel), findsOneWidget);
      expect(find.text('⏱ 2 tools · 10s wall-clock'), findsOneWidget);
      expect(find.byKey(key), findsOneWidget);
      expect(find.text(attributionText), findsOneWidget);
      expect(find.byTooltip(hint), findsOneWidget);

      // 同一行：归属的**最近**那个 Row 祖先同时也是文案所在的 Row ——
      // 它不再自占一行（从前那版是轨迹行下面另起一行）。
      final hostRow = find
          .ancestor(of: find.byKey(key), matching: find.byType(Row))
          .first;
      expect(
        find.descendant(of: hostRow, matching: find.byKey(trajectoryLabel)),
        findsOneWidget,
      );

      // 靠右 + 同一行：两段文字的竖直中心重合，归属顶在这一行的最右端。
      final labelRect = tester.getRect(find.byKey(trajectoryLabel));
      final attrRect = tester.getRect(find.byKey(key));
      expect(attrRect.center.dy, closeTo(labelRect.center.dy, 1.5));
      expect(attrRect.right, closeTo(tester.getRect(hostRow).right, 1.0));
      expect(attrRect.left, greaterThan(labelRect.left));
    });

    testWidgets('工具不足两个（没有轨迹行）时退到 🕐/⏱ 时间行的最右端', (tester) async {
      await tester.pumpWidget(
        _host(
          ChatMessage(
            role: MessageRole.assistant,
            content: '完成',
            // 只有一个工具：轨迹条与它那行文案都不画。
            toolCalls: [_tool('a', 0, 5000)],
            durationMs: 439000,
            modelAttribution: attribution,
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(trajectoryLabel), findsNothing);
      expect(find.byKey(key), findsOneWidget);
      expect(find.byTooltip(hint), findsOneWidget);

      final hostRow = find
          .ancestor(of: find.byKey(key), matching: find.byType(Row))
          .first;
      expect(
        find.descendant(of: hostRow, matching: find.textContaining('🕐')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: hostRow, matching: find.textContaining('⏱')),
        findsOneWidget,
      );

      final rowRect = tester.getRect(hostRow);
      final attrRect = tester.getRect(find.byKey(key));
      // 归属就在这一行的盒子里 —— 不是它下面另起的一行（旧版就是另起一行）。
      // 这里不比较与某一个文本的竖直中心：时钟/时长那两段本身是 Wrap，位子不够
      // 时会在**这一行内部**换到第二个 run（老行为），归属则在行内居中。
      expect(attrRect.center.dy, greaterThan(rowRect.top));
      expect(attrRect.center.dy, lessThan(rowRect.bottom));
      expect(attrRect.right, closeTo(rowRect.right, 1.0));
    });

    testWidgets('两行都不在时才自占一行（右对齐）', (tester) async {
      await tester.pumpWidget(
        _host(
          ChatMessage(
            role: MessageRole.assistant,
            content: '完成',
            modelAttribution: attribution,
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(trajectoryLabel), findsNothing);
      expect(find.textContaining('🕐'), findsNothing);
      expect(find.byKey(key), findsOneWidget);

      // 兜底那行是右对齐的（前面两种落点都贴在宿主行的最右端，同一个视觉语言）。
      final align = tester.widget<Align>(
        find.ancestor(of: find.byKey(key), matching: find.byType(Align)).first,
      );
      expect(align.alignment, Alignment.centerRight);

      final attrRect = tester.getRect(find.byKey(key));
      expect(
        attrRect.right,
        greaterThan(tester.getRect(find.byType(MessageBubble)).center.dx),
      );
    });

    testWidgets('没有归属时整段不出现 —— 轨迹行也不多出一个空 Row', (tester) async {
      await tester.pumpWidget(
        _host(
          ChatMessage(
            role: MessageRole.assistant,
            content: '完成',
            toolCalls: _measuredTools(),
            durationMs: 10000,
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(key), findsNothing);
      expect(find.textContaining('产出'), findsNothing);
      // 轨迹文案行还是从前那一个孤零零的 Text：里面没有为了归属多出来的 Row。
      expect(find.byKey(trajectoryLabel), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const Key('tool-trajectory')),
          matching: find.byType(Row),
        ),
        findsNothing,
      );
    });

    testWidgets('时间行没有归属时也不会多出 Row', (tester) async {
      await tester.pumpWidget(
        _host(
          ChatMessage(
            role: MessageRole.assistant,
            content: '完成',
            toolCalls: [_tool('a', 0, 5000)],
            durationMs: 439000,
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(key), findsNothing);
      expect(
        find.ancestor(
          of: find.textContaining('🕐'),
          matching: find.byType(Row),
        ),
        findsNothing,
      );
    });

    testWidgets('窄屏 320 宽：归属挤在那一行里，不溢出', (tester) async {
      const longAttribution = ModelAttribution(
        cli: 'claude-exp',
        providerId: 'some-extremely-long-provider-id',
        providerName: 'A very long resolved provider name',
        model: 'deepseek-v4-pro-max-ultra-long-model-name',
      );

      // ① 轨迹文案行 + 归属。
      await tester.pumpWidget(
        _host(
          ChatMessage(
            role: MessageRole.assistant,
            content: '完成',
            toolCalls: _measuredTools(),
            durationMs: 10000,
            modelAttribution: longAttribution,
          ),
          width: 320,
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);

      final row = find
          .ancestor(of: find.byKey(key), matching: find.byType(Row))
          .first;
      final rowRect = tester.getRect(row);
      final attrRect = tester.getRect(find.byKey(key));
      // 归属被夹在这一行的一半以内（Flexible 让位 + 省略号），没有越出去。
      expect(attrRect.width, lessThanOrEqualTo(rowRect.width / 2 + 1));
      expect(attrRect.right, closeTo(rowRect.right, 1.0));

      // ② 时间行 + 归属（没有轨迹行的情况）。
      await tester.pumpWidget(
        _host(
          ChatMessage(
            role: MessageRole.assistant,
            content: '完成',
            toolCalls: [_tool('a', 0, 5000)],
            durationMs: 439000,
            modelAttribution: longAttribution,
          ),
          width: 320,
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
      final timingRow = find
          .ancestor(of: find.byKey(key), matching: find.byType(Row))
          .first;
      expect(
        tester.getRect(find.byKey(key)).right,
        closeTo(tester.getRect(timingRow).right, 1.0),
      );
    });

    testWidgets('user / system 消息不渲染这一行', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Column(
              children: [
                MessageBubble(
                  message: ChatMessage(
                    role: MessageRole.user,
                    content: '继续',
                    modelAttribution: attribution,
                  ),
                ),
                MessageBubble(
                  message: ChatMessage(
                    role: MessageRole.system,
                    content: '系统行',
                    modelAttribution: attribution,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.byKey(key), findsNothing);
    });
  });

  test('实时 result 事件把同一份归属挂到当前气泡上', () {
    final folder = TranscriptLiveFolder(
      messages: <ChatMessage>[],
      cliOf: () => SessionCli.claude,
      sessionIdOf: () => 'sess-1',
    );
    folder.messageStart();
    expect(folder.currentMsg, isNotNull);
    expect(folder.currentMsg!.modelAttribution, isNull);

    folder.attachResultUsage({
      'durationMs': 1200,
      'modelAttribution': {
        'cli': 'claude',
        'providerId': 'zhipu',
        'providerName': 'Zhipu',
        'model': 'glm-4.6',
      },
    });
    expect(folder.currentMsg!.durationMs, 1200);
    expect(folder.currentMsg!.modelAttribution, isNotNull);
    expect(folder.currentMsg!.modelAttribution!.model, 'glm-4.6');
    expect(folder.currentMsg!.modelAttribution!.providerName, 'Zhipu');

    // 事件里没有归属（老服务端）→ 保持 null，随后整段不渲染。
    folder.finishStreaming();
    folder.messageStart();
    folder.attachResultUsage({'durationMs': 900});
    expect(folder.currentMsg!.modelAttribution, isNull);
  });
}

/// 两个测量完整的工具 —— 轨迹条与它那行墙钟文案的成立条件。
List<ToolCall> _measuredTools() => [_tool('a', 0, 5000), _tool('b', 7500, 10000)];

ToolCall _tool(String id, int startedAt, int endedAt) => ToolCall(
  id: id,
  name: 'Bash',
  startedAt: startedAt,
  endedAt: endedAt,
  isDone: true,
);

/// 把气泡放在一个固定宽度的车道里（默认够宽；窄屏用例传 320）。
Widget _host(ChatMessage message, {double width = 420}) => MaterialApp(
  home: Scaffold(
    body: Align(
      alignment: Alignment.topLeft,
      child: SizedBox(
        width: width,
        child: MessageBubble(message: message),
      ),
    ),
  ),
);
