import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/widgets/message_bubble.dart';
import 'package:multicc_app/widgets/tool_card.dart';

ToolCall _tool({
  required String id,
  required String name,
  int? startedAt,
  int? endedAt,
  bool isError = false,
}) => ToolCall(
  id: id,
  name: name,
  startedAt: startedAt,
  endedAt: endedAt,
  isDone: true,
  isError: isError,
);

Widget _trajectoryHost(List<ToolCall> tools, {int? turnDurationMs}) => MaterialApp(
  home: Scaffold(
    body: Align(
      alignment: Alignment.topLeft,
      child: SizedBox(
        width: 200,
        child: ToolTrajectory(toolCalls: tools, turnDurationMs: turnDurationMs),
      ),
    ),
  ),
);

void main() {
  testWidgets('matches Web geometry and wall-clock label', (tester) async {
    await tester.pumpWidget(
      _trajectoryHost([
        _tool(id: 'a', name: 'Bash', startedAt: 0, endedAt: 5000),
        _tool(
          id: 'b',
          name: 'Read',
          startedAt: 7500,
          endedAt: 10000,
          isError: true,
        ),
      ]),
    );

    expect(find.byKey(const Key('tool-trajectory')), findsOneWidget);
    expect(find.text('⏱ 2 tools · 10s wall-clock'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('tool-trajectory-segment-0-ok')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('tool-trajectory-segment-1-error')),
      findsOneWidget,
    );

    final track = tester.getRect(
      find.byKey(const Key('tool-trajectory-track')),
    );
    final first = tester.getRect(
      find.byKey(const ValueKey('tool-trajectory-segment-0-ok')),
    );
    final second = tester.getRect(
      find.byKey(const ValueKey('tool-trajectory-segment-1-error')),
    );
    expect(first.left - track.left, closeTo(0, 0.1));
    expect(first.width, closeTo(track.width * 0.5, 0.1));
    expect(second.left - track.left, closeTo(track.width * 0.75, 0.1));
    expect(second.width, closeTo(track.width * 0.25, 0.1));
  });

  testWidgets('legacy and incomplete timing stays hidden', (tester) async {
    await tester.pumpWidget(
      _trajectoryHost([
        _tool(id: 'a', name: 'Bash', startedAt: 0, endedAt: 500),
        _tool(id: 'b', name: 'Read'),
        _tool(id: 'c', name: 'Edit', startedAt: 900, endedAt: 100),
      ]),
    );

    expect(find.byKey(const Key('tool-trajectory')), findsNothing);
    expect(find.textContaining('wall-clock'), findsNothing);
  });

  testWidgets('wall-clock spans the whole turn when the server stamped LLM time', (
    tester,
  ) async {
    await tester.pumpWidget(
      _trajectoryHost(
        [
          _tool(id: 'a', name: 'Bash', startedAt: 0, endedAt: 5000),
          _tool(
            id: 'b',
            name: 'Read',
            startedAt: 7500,
            endedAt: 10000,
            isError: true,
          ),
        ],
        turnDurationMs: 20000,
      ),
    );

    expect(find.byKey(const Key('tool-trajectory')), findsOneWidget);
    // 墙钟含大模型请求时间：标签说 20s，不是工具自己那 10s。
    expect(find.text('⏱ 2 tools · 20s wall-clock'), findsOneWidget);
    final track = tester.getRect(
      find.byKey(const Key('tool-trajectory-track')),
    );
    final first = tester.getRect(
      find.byKey(const ValueKey('tool-trajectory-segment-0-ok')),
    );
    final second = tester.getRect(
      find.byKey(const ValueKey('tool-trajectory-segment-1-error')),
    );
    expect(first.left - track.left, closeTo(0, 0.1));
    expect(first.width, closeTo(track.width * 0.25, 0.1));
    expect(second.left - track.left, closeTo(track.width * 0.375, 0.1));
    expect(second.width, closeTo(track.width * 0.125, 0.1));

    // 比工具窗口还小的 turn 时长不会把条缩到工具之下。
    await tester.pumpWidget(
      _trajectoryHost(
        [
          _tool(id: 'a', name: 'Bash', startedAt: 0, endedAt: 5000),
          _tool(id: 'b', name: 'Read', startedAt: 7500, endedAt: 10000),
        ],
        turnDurationMs: 4000,
      ),
    );
    expect(find.text('⏱ 2 tools · 10s wall-clock'), findsOneWidget);
  });

  testWidgets('assistant bubble includes the trajectory under its tools', (
    tester,
  ) async {
    final message = ChatMessage(
      role: MessageRole.assistant,
      content: 'done',
      toolCalls: [
        _tool(id: 'a', name: 'Bash', startedAt: 1000, endedAt: 2500),
        _tool(id: 'b', name: 'Read', startedAt: 3000, endedAt: 3120),
      ],
      durationMs: 8000,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: MessageBubble(message: message)),
      ),
    );

    expect(find.byType(ToolCallGroup), findsOneWidget);
    expect(find.byType(ToolTrajectory), findsOneWidget);
    expect(find.text('⏱ 2 tools · 8.0s wall-clock'), findsOneWidget);
  });
}
