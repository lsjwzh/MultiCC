import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/transcript_live_folder.dart';
import 'package:multicc_app/widgets/message_bubble.dart';
import 'package:multicc_app/widgets/tool_card.dart';
import 'package:shared_preferences/shared_preferences.dart';

// 「模型归属」那一小段字：assistant 消息页脚里说明这条回复是哪个模型产出的。
//
// 两条路必须说出同一句话：历史 JSON 里的 `modelAttribution`（重开会话）与实时
// `result` 事件里的同名键（刚跑完那条气泡）。四个键都可能缺、整个字段也可能不
// 出现（老历史），那种情况整段不渲染 —— 不留空壳。
//
// 落点（与 Web 端同一条规则，见 public/chat-live-ui.js 的 attachModelAttribution）：
// 贴在页脚里那行「⏱ N tools · 时长 wall-clock」的最右端；没有那一行（工具不足
// 两个、或基本模式不画轨迹条）就退到 🕐/⏱ 时间行的最右端（时间行不分基本/高级
// 模式）；两行都没有才自占一行。三种情况下它都跟宿主行的文字**同一行**，绝不为了
// 它多出一行。
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

    testWidgets('没有轨迹行也没有时长：归属仍落在时间行的最右端', (tester) async {
      // 老历史（没有工具、没有 durationMs）从前会落到「自占一行」那一档 —— 那条
      // 时间行当时既要 advancedMode、又要 durationMs 非空才画。现在时间行两种
      // 模式都建，而 ChatMessage.timestamp 是非空的（构造时兜 DateTime.now()），
      // 所以时钟段总有内容、时间行必定在场 —— 兜底那一行（_ModelAttributionLine）
      // 在 App 里已经够不到，它只留给「时间戳为空」这种模型上不存在的组合。
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
      expect(find.byKey(key), findsOneWidget);

      // 时间行只有时钟段（没有 ⏱），归属贴在这一行的最右端。
      final hostRow = find
          .ancestor(of: find.byKey(key), matching: find.byType(Row))
          .first;
      expect(
        find.descendant(of: hostRow, matching: find.textContaining('🕐')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: hostRow, matching: find.textContaining('⏱')),
        findsNothing,
      );
      expect(
        tester.getRect(find.byKey(key)).right,
        closeTo(tester.getRect(hostRow).right, 1.0),
      );

      // 走的不是兜底那一档（那是一段 centerRight 的 Align 直接包着归属）。
      expect(
        tester
            .widgetList<Align>(
              find.ancestor(of: find.byKey(key), matching: find.byType(Align)),
            )
            .any((align) => align.alignment == Alignment.centerRight),
        isFalse,
      );

      final attrRect = tester.getRect(find.byKey(key));
      expect(
        attrRect.right,
        greaterThan(tester.getRect(find.byType(MessageBubble)).center.dx),
      );
    });

    testWidgets('流式进行中不画时间行（与 Web 活体气泡一致）', (tester) async {
      // 回复还在写的时候页脚不冒出时钟：Web 的活体气泡就是这样
      // （public/chat-event-controller.js 只在 result 事件里补 .msg-timing），
      // 否则两端在流式期间对不上，收尾时那一行还要跳一下。
      //
      // 注意判据不是「有没有时间戳」—— ChatMessage.timestamp 非空，那个条件恒真。
      // 是 timingShown 里的 isStreaming && durationMs == null：durationMs 落地的
      // 那一刻（result 事件）流式已经结束，两个条件同时翻转。
      await tester.pumpWidget(
        _host(
          ChatMessage(
            role: MessageRole.assistant,
            content: '正在写',
            isStreaming: true,
          ),
        ),
      );
      await tester.pump();

      expect(find.textContaining('🕐'), findsNothing);
      expect(find.textContaining('⏱'), findsNothing);
      expect(find.byKey(key), findsNothing);
    });

    testWidgets('流式收尾（result 落地）后时间行立刻出现', (tester) async {
      // 上一条的对照面：同一份消息只是不再流式，时间行就该在。
      await tester.pumpWidget(
        _host(
          ChatMessage(
            role: MessageRole.assistant,
            content: '正在写',
            isStreaming: false,
            modelAttribution: attribution,
          ),
        ),
      );
      await tester.pump();

      expect(find.textContaining('🕐'), findsOneWidget);
      expect(find.byKey(key), findsOneWidget);
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

    testWidgets('基本模式：时间行照画，归属贴在它的最右端（不再自占一行）', (tester) async {
      // 基本模式（SettingsService.current.advancedMode == false）。从前时间行整条
      // 被 advancedMode 挡掉，归属没有宿主行、只能自占一行 —— 用户不要多那一行。
      SharedPreferences.setMockInitialValues(const {});
      final settings = await SettingsService.getInstance();
      settings.advancedMode.value = false;
      // 这个文件的其余用例走的是「没有 SettingsService → 默认高级模式」那条路，
      // 跑完把开关交回去，别让后面的用例落到基本模式里。
      addTearDown(() => settings.advancedMode.value = true);

      await tester.pumpWidget(
        _host(
          ChatMessage(
            role: MessageRole.assistant,
            content: '完成',
            // 只有一个工具：基本模式画的是「处理步骤」摘要卡，没有轨迹文案行，
            // 于是归属只能落在时间行上。
            toolCalls: [_tool('a', 0, 5000)],
            durationMs: 439000,
            modelAttribution: attribution,
          ),
        ),
      );
      await tester.pump();

      // 基本模式：不是轨迹条，而是摘要卡；轨迹文案行不在（所以走不到那个落点）。
      expect(find.byKey(const ValueKey('basic-tool-summary')), findsOneWidget);
      expect(find.byKey(trajectoryLabel), findsNothing);

      // 时间行两种模式都画。
      expect(find.textContaining('🕐'), findsOneWidget);
      expect(find.textContaining('⏱'), findsOneWidget);
      expect(find.text(attributionText), findsOneWidget);
      expect(find.byTooltip(hint), findsOneWidget);

      // 归属贴在时间行里：它最近的 Row 祖先同时也是时钟/时长所在的 Row。
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

      // 而且是那一行的**最后一个**子节点（最右端）：钟面/时长 + 间隔 + 归属。
      final row = tester.widget<Row>(hostRow);
      expect(row.children.length, 3);
      expect(
        find.descendant(
          of: find.byWidget(row.children.last),
          matching: find.byKey(key),
        ),
        findsOneWidget,
      );

      final rowRect = tester.getRect(hostRow);
      final attrRect = tester.getRect(find.byKey(key));
      // 就在这一行里（不是它下面另起的一行），且顶到右边界。
      expect(attrRect.center.dy, greaterThan(rowRect.top));
      expect(attrRect.center.dy, lessThan(rowRect.bottom));
      expect(attrRect.right, closeTo(rowRect.right, 1.0));

      // 没走兜底那一档：气泡内容列里没有「一个 centerRight 的 Align 直接当子节点」
      // 那种自占一行的归属（`_ModelAttributionLine` 就是那个形状）。
      final alignAncestors = tester.widgetList<Align>(
        find.ancestor(of: find.byKey(key), matching: find.byType(Align)),
      );
      expect(
        alignAncestors.any((align) => align.alignment == Alignment.centerRight),
        isFalse,
      );
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
