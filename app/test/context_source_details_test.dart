import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/widgets/context_source_details.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await I18n.init('zh');
  });
  testWidgets(
    'memory sources show scope, version, truncation and managed budget omissions',
    (tester) async {
      expect(contextSourceLabel('memory:skill'), '记忆·技能');
      expect(
        contextSourceMeta({'version': 'abcdef', 'truncated': true}),
        contains('已截断'),
      );
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: ContextBudgetDetails(
              trace: {
                'budget': {'used': 300, 'limit': 8000},
                'omitted': [
                  {'id': 'memory:large', 'reason': 'budget'},
                ],
                'retained': [
                  {'id': 'memory:prior', 'taskName': '沿用资料'},
                ],
              },
            ),
          ),
        ),
      );
      expect(find.text('托管上下文：约 300 / 8000 tokens'), findsOneWidget);
      expect(find.text('沿用 1 项 · 省略 1 项'), findsOneWidget);
      await tester.tap(find.byType(ExpansionTile));
      await tester.pumpAndSettle();
      expect(find.text('budget'), findsOneWidget);
      expect(find.text('此前已注入，本轮未重复发送'), findsOneWidget);
    },
  );
}
