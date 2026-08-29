import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/widgets/thinking_indicator.dart';

void main() {
  testWidgets('thinking indicator renders a bounded admission-stage label', (
    tester,
  ) async {
    const label = '已收到消息 · 正在整理会话记忆，完成后自动继续';
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 280, child: ThinkingIndicator(label: label)),
        ),
      ),
    );

    expect(find.text(label), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(milliseconds: 321));
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });
}
