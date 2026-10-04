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

  testWidgets('server timeline draws request/thinking/output from the turn origin', (tester) async {
    final timeline = TurnTimeline.fromJson({
      'origin': 1000,
      'spans': [
        {'k': 'request', 's': 1000, 'e': 3000},
        {'k': 'thinking', 's': 3000, 'e': 6000},
        {'k': 'request', 's': 8000, 'e': 9000},
        {'k': 'output', 's': 9000, 'e': 11000},
        {'k': 'bogus', 's': 0, 'e': 1},
      ],
    });
    expect(timeline!.spans, hasLength(4), reason: 'unknown kinds are dropped');
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: 200,
            child: ToolTrajectory(
              toolCalls: [
                _tool(id: 'th', name: 'Thinking', startedAt: 3000, endedAt: 6000),
                _tool(id: 'a', name: 'Bash', startedAt: 6000, endedAt: 8000),
              ],
              turnDurationMs: 10000,
              timeline: timeline,
            ),
          ),
        ),
      ),
    ));
    expect(
      find.text('⏱ 1 tools · 10s wall-clock · request 3.0s · thinking 3.0s · output 2.0s'),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('timeline-segment-0-request')), findsOneWidget);
    expect(find.byKey(const ValueKey('timeline-segment-1-thinking')), findsOneWidget);
    expect(find.byKey(const ValueKey('timeline-segment-3-output')), findsOneWidget);
    // The Thinking pseudo-tool is deduped: only Bash is a tool segment.
    expect(find.byKey(const ValueKey('tool-trajectory-segment-0-ok')), findsOneWidget);
    expect(find.byKey(const ValueKey('tool-trajectory-segment-1-ok')), findsNothing);
    final first = tester.widget<Positioned>(find.descendant(
      of: find.byKey(const ValueKey('timeline-segment-0-request')),
      matching: find.byType(Positioned),
    ).first);
    expect(first.left, 0, reason: 'origin is the submit time');
    expect(first.width, closeTo(40, 0.001));
    final bash = tester.widget<Positioned>(find.descendant(
      of: find.byKey(const ValueKey('tool-trajectory-segment-0-ok')),
      matching: find.byType(Positioned),
    ).first);
    expect(bash.left, closeTo(100, 0.001));
  });

  testWidgets('history message with only a timeline still shows the strip', (tester) async {
    final message = ChatMessage.fromHistory({
      'role': 'assistant',
      'content': 'hi',
      'durationMs': 4000,
      'timeline': {
        'origin': 0,
        'spans': [
          {'k': 'request', 's': 0, 'e': 1500},
          {'k': 'output', 's': 1500, 'e': 4000},
        ],
      },
    });
    expect(message.timeline, isNotNull);
    expect(hasTrajectoryContent(const [], message.timeline), isTrue);
    expect(hasTrajectoryContent(const []), isFalse);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: MessageBubble(message: message))));
    expect(find.byType(ToolTrajectory), findsOneWidget);
    expect(find.text('⏱ 0 tools · 4.0s wall-clock · request 1.5s · output 2.5s'), findsOneWidget);
  });
}
