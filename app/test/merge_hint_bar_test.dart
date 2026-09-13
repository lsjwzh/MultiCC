import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/chat_screen.dart';

/// 「有可合并内容」提示条：默认是横幅（查看 Diff / 合并），可以收起成右边缘的
/// 贴边药丸再点回来。对齐 web 的 `#merge-hint` + `chat-merge-hint.js`。
Widget _host(Widget child) => MaterialApp(
  home: Scaffold(
    body: SizedBox(width: 360, child: Column(children: [child])),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  testWidgets('展开态给查看 Diff / 合并 / 收起三个动作', (tester) async {
    var merges = 0;
    var diffs = 0;
    await tester.pumpWidget(
      _host(
        MergeHintBar(
          text: '有未提交改动，可合并回 main',
          onMerge: () => merges++,
          onDiff: () => diffs++,
        ),
      ),
    );

    expect(find.text('有未提交改动，可合并回 main'), findsOneWidget);
    expect(find.byKey(const Key('merge-hint-fab')), findsNothing);

    await tester.tap(find.text('查看 Diff'));
    await tester.pump();
    await tester.tap(find.text('合并'));
    await tester.pump();
    expect(diffs, 1);
    expect(merges, 1);
  });

  testWidgets('收起后只剩贴边药丸，点它可以展开回来', (tester) async {
    await tester.pumpWidget(
      _host(
        MergeHintBar(
          text: '有未提交改动，可合并回 main',
          onMerge: () {},
          onDiff: () {},
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('merge-hint-collapse')));
    await tester.pump();

    // 横幅让开了：文字与两个动作都不在，只剩那颗药丸。
    expect(find.text('有未提交改动，可合并回 main'), findsNothing);
    expect(find.text('查看 Diff'), findsNothing);
    expect(find.text('合并'), findsNothing);
    expect(find.byKey(const Key('merge-hint-fab')), findsOneWidget);

    await tester.tap(find.byKey(const Key('merge-hint-fab')));
    await tester.pump();

    expect(find.text('有未提交改动，可合并回 main'), findsOneWidget);
    expect(find.byKey(const Key('merge-hint-fab')), findsNothing);
  });
}
