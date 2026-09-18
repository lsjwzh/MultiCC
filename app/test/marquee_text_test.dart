import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/widgets/marquee_text.dart';

/// 线路胶囊（Web `.mc-composer__pill--ai`）与 App 的 Provider chip 用的是同一套
/// 规则：有上限宽度，装不下就走跑马灯，装得下什么都不发生。三件事都得锁住 ——
/// 「装得下也动」会让每一颗胶囊都在屏幕上晃，「装不下不动」则等于把名字切掉。
Widget _host(
  String text, {
  double maxWidth = 120,
  bool reduceMotion = false,
}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(disableAnimations: reduceMotion),
    child: Scaffold(
      body: Center(
        child: SizedBox(
          width: 400,
          child: MarqueeText(
            text: text,
            maxWidth: maxWidth,
            style: const TextStyle(fontSize: 12),
          ),
        ),
      ),
    ),
  ),
);

double? _translationX(WidgetTester tester) {
  final matches = find.descendant(
    of: find.byType(MarqueeText),
    matching: find.byType(Transform),
  );
  if (matches.evaluate().isEmpty) return null;
  return tester
      .widget<Transform>(matches.first)
      .transform
      .getTranslation()
      .x;
}

void main() {
  testWidgets('装得下就原样显示：没有裁剪框，也没有动画', (tester) async {
    await tester.pumpWidget(_host('短名字', maxWidth: 200));
    // pumpAndSettle 会一直等动画结束 —— 这里能返回本身就说明没在跑。
    await tester.pumpAndSettle();
    expect(find.text('短名字'), findsOneWidget);
    expect(_translationX(tester), isNull);
  });

  testWidgets('装不下就走跑马灯：位移来自真实溢出，文字本身保持完整', (tester) async {
    const long = 'Lab Responses via a very long relay account name';
    await tester.pumpWidget(_host(long, maxWidth: 120));
    await tester.pump();
    final first = _translationX(tester);
    expect(first, isNotNull, reason: '溢出时才有滚动层');
    // 文字没有被截断成半句话：整串还在树里（find.text 匹配的是完整字符串）。
    expect(find.text(long), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 400));
    final later = _translationX(tester);
    expect(later, isNotNull);
    expect(later, isNot(equals(first)), reason: '跑马灯要真的在走');
    expect(later!, lessThanOrEqualTo(0), reason: '只往左走，文字不会飘出左边框');
    // 收工：把树换掉，让 ticker 随 dispose 一起停。
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('系统要求减少动效时退回省略号：不跑，也不切', (tester) async {
    await tester.pumpWidget(
      _host('Lab Responses via a very long relay account name', reduceMotion: true),
    );
    await tester.pumpAndSettle();
    expect(_translationX(tester), isNull);
    expect(
      tester.widget<Text>(find.byType(Text)).overflow,
      TextOverflow.ellipsis,
    );
  });
}
