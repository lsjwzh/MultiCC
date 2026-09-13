import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/widgets/air/air_destinations.dart';
import 'package:multicc_app/widgets/workspace_navigation_drawer.dart';

/// 这一页是长列表，默认 800×600 的测试画布装不下 —— ListView 不会构建看不见
/// 的那些行，断言会以为它们不存在。给一块足够高的画布，让整页一次铺开。
Future<void> _pump(
  WidgetTester tester,
  Widget Function(BuildContext context) build,
) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(800, 2600);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(MaterialApp(home: Builder(builder: build)));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('全部功能列出老抽屉里的每一个目的地，除了当前这一页', (tester) async {
    final picked = <WorkspaceDestination>[];
    await _pump(
      tester,
      (_) => AirAllDestinations(onSelected: picked.add, onOpenVoiceCall: () {}),
    );

    // Air 侧栏只摆常用的几个，剩下的必须从这里一个不少地进得去。
    for (final destination in WorkspaceDestination.values) {
      if (destination == WorkspaceDestination.overview) continue;
      expect(
        find.byKey(ValueKey('air-dest-${destination.name}')),
        findsOneWidget,
        reason: '${destination.name} 应该能在「全部功能」里找到',
      );
      expect(find.text(t(destination.labelKey)), findsOneWidget);
    }
    // 「概览」就是当前这一页，不再列一遍。
    expect(find.byKey(const ValueKey('air-dest-overview')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('原生独占的四件事都能在这里找到出处', (tester) async {
    var voiceCallOpened = false;
    await _pump(
      tester,
      (_) => AirAllDestinations(
        onSelected: (_) {},
        onOpenVoiceCall: () => voiceCallOpened = true,
      ),
    );

    expect(find.text('语音通话（BETA）'), findsOneWidget);
    expect(find.text('文件浏览'), findsOneWidget);
    expect(find.text('局域网发现'), findsOneWidget);
    expect(find.text('原生通知与后台常驻'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('air-native-voice-call')));
    await tester.pumpAndSettle();
    expect(voiceCallOpened, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('选一个目的地就把选择交回宿主', (tester) async {
    final picked = <WorkspaceDestination>[];
    await _pump(
      tester,
      (_) => Navigator(
        onGenerateRoute: (_) => MaterialPageRoute<void>(
          builder: (routeContext) => AirAllDestinations(
            onSelected: (destination) {
              picked.add(destination);
              Navigator.of(routeContext).pop(destination);
            },
            onOpenVoiceCall: () {},
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const ValueKey('air-dest-push')));
    await tester.pumpAndSettle();
    expect(picked, [WorkspaceDestination.push]);
    expect(tester.takeException(), isNull);
  });
}
