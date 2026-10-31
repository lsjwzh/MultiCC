import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/widgets/remote_wheel_rail.dart';

/// 竖条落点：三种几何（左右黑边 / 上下黑边 / 全屏铺满）。
void main() {
  group('remoteWheelRailRect', () {
    test('横屏：落进右侧黑边，不压内容', () {
      const vp = Size(800, 400);
      // contain 后内容 615×400 => 左右各 92.5 的黑边。
      const content = Rect.fromLTWH(92.5, 0, 615, 400);
      final rail = remoteWheelRailRect(vp, 92.5, 0);
      expect(rail.width, remoteWheelRailWidth);
      expect(rail.left, greaterThanOrEqualTo(800 - 92.5));
      expect(rail.right, lessThanOrEqualTo(800));
      expect(rail.overlaps(content), isFalse);
      expect(rail.center.dy, closeTo(200, 0.001)); // 垂直居中
      expect(rail.height, 240); // min(260, 60% of 400)
    });

    test('竖屏：落进下方黑边右下角，不压内容', () {
      const vp = Size(390, 600);
      // contain 后内容 390×254 => 上下各 173 的黑边。
      const content = Rect.fromLTWH(0, 173, 390, 254);
      final rail = remoteWheelRailRect(vp, 0, 173);
      expect(rail.top, greaterThanOrEqualTo(600 - 173));
      expect(rail.bottom, lessThanOrEqualTo(600));
      expect(rail.overlaps(content), isFalse);
      expect(rail.height, 157); // min(220, 173-16)
      expect(rail.right, lessThanOrEqualTo(390));
    });

    test('全屏铺满：贴右边缘浮动，高度至少 120', () {
      const vp = Size(800, 400);
      final rail = remoteWheelRailRect(vp, 0, 0);
      expect(rail.width, remoteWheelRailWidth);
      expect(rail.right, lessThanOrEqualTo(800));
      expect(rail.left, 800 - remoteWheelRailWidth - 6);
      expect(rail.height, greaterThanOrEqualTo(120));
      expect(rail.center.dy, closeTo(200, 0.001));
    });
  });

  group('RemoteWheelRail', () {
    Future<List<bool>> pumpRail(WidgetTester tester) async {
      final notches = <bool>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: remoteWheelRailWidth,
                height: 220,
                child: RemoteWheelRail(
                  onNotch: notches.add,
                  semanticLabel: 'wheel',
                  upLabel: 'up',
                  downLabel: 'down',
                ),
              ),
            ),
          ),
        ),
      );
      return notches;
    }

    testWidgets('握把向下拖 60px = 3 格向上滚，向上拖 39px = 2 格向下滚', (tester) async {
      final notches = await pumpRail(tester);
      final rail = find.byType(RemoteWheelRail);

      final down = await tester.startGesture(tester.getCenter(rail));
      for (var i = 0; i < 20; i++) {
        await down.moveBy(const Offset(0, 3));
        await tester.pump();
      }
      await down.up();
      await tester.pump();
      expect(notches.length, 3);
      expect(notches.every((up) => up), isTrue);

      notches.clear();
      final upDrag = await tester.startGesture(tester.getCenter(rail));
      for (var i = 0; i < 13; i++) {
        await upDrag.moveBy(const Offset(0, -3));
        await tester.pump();
      }
      await upDrag.up();
      await tester.pump();
      expect(notches.length, 2);
      expect(notches.every((isUp) => !isUp), isTrue);

      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('轻点 ▲ 只发一格向上', (tester) async {
      final notches = await pumpRail(tester);
      await tester.tap(find.byIcon(Icons.keyboard_arrow_up_rounded));
      await tester.pump();
      expect(notches.length, 1);
      expect(notches.single, isTrue);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('按住 ▼ 连发，松手后停', (tester) async {
      final notches = await pumpRail(tester);
      final grip = await tester.startGesture(
        tester.getCenter(find.byIcon(Icons.keyboard_arrow_down_rounded)),
      );
      // 按下立即一格。
      expect(notches.length, 1);
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(notches.length, greaterThanOrEqualTo(5));
      expect(notches.every((up) => !up), isTrue);
      final held = notches.length;
      await grip.up();
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(notches.length, held);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
