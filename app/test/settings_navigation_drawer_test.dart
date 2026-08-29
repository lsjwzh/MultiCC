import 'dart:ui' show SemanticsFlag;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/theme.dart';
import 'package:multicc_app/widgets/settings_navigation_drawer.dart';

const _destinations = <SettingsDestination>[
  SettingsDestination.voice,
  SettingsDestination.goal,
  SettingsDestination.provider,
  SettingsDestination.global,
  SettingsDestination.push,
  SettingsDestination.tunnel,
  SettingsDestination.bridges,
  SettingsDestination.resources,
  SettingsDestination.skillSync,
  SettingsDestination.storage,
];

Future<GlobalKey<ScaffoldState>> _pumpDrawer(
  WidgetTester tester, {
  SettingsDestination selected = SettingsDestination.global,
  ValueChanged<SettingsDestination>? onSelected,
  VoidCallback? onExit,
  double height = 844,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(390, height);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  final scaffoldKey = GlobalKey<ScaffoldState>();
  await tester.pumpWidget(
    MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        key: scaffoldKey,
        appBar: AppBar(title: const Text('Settings host')),
        drawer: SettingsNavigationDrawer(
          selected: selected,
          serverLabel: 'macbook.local:3000',
          onSelected: onSelected,
          onExit: onExit,
        ),
      ),
    ),
  );
  scaffoldKey.currentState!.openDrawer();
  await tester.pumpAndSettle();
  return scaffoldKey;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('en'));
  tearDown(() => I18n.switchLang('en'));

  testWidgets('matches the web Settings destination order', (tester) async {
    await _pumpDrawer(tester);

    expect(SettingsDestination.values, _destinations);
    final expectedKeys = _destinations
        .map((destination) => 'settings-nav-${destination.name}')
        .toList(growable: false);
    final expectedKeySet = expectedKeys.toSet();
    final actualKeys = tester.allWidgets
        .map((widget) => widget.key)
        .whereType<ValueKey<String>>()
        .map((key) => key.value)
        .where(expectedKeySet.contains)
        .toList(growable: false);

    expect(actualKeys, expectedKeys);
    expect(find.text(t('settingsTitle').toUpperCase()), findsOneWidget);
  });

  testWidgets('marks the active item and keeps 44dp touch targets', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await _pumpDrawer(tester, selected: SettingsDestination.push);

    final selected = tester.getSemantics(
      find.byKey(const ValueKey('settings-nav-push')),
    );
    final unselected = tester.getSemantics(
      find.byKey(const ValueKey('settings-nav-global')),
    );
    expect(selected.hasFlag(SemanticsFlag.isSelected), isTrue);
    expect(unselected.hasFlag(SemanticsFlag.isSelected), isFalse);

    for (final destination in _destinations) {
      expect(
        tester
            .getSize(find.byKey(ValueKey('settings-nav-${destination.name}')))
            .height,
        greaterThanOrEqualTo(44),
      );
    }
    semantics.dispose();
  });

  testWidgets('closes the drawer and delegates destination selection', (
    tester,
  ) async {
    SettingsDestination? chosen;
    final scaffoldKey = await _pumpDrawer(
      tester,
      onSelected: (destination) => chosen = destination,
    );

    await tester.tap(find.byKey(const ValueKey('settings-nav-provider')));
    await tester.pumpAndSettle();

    expect(chosen, SettingsDestination.provider);
    expect(scaffoldKey.currentState!.isDrawerOpen, isFalse);
  });

  testWidgets('replaces settings routes while preserving workspace back', (
    tester,
  ) async {
    final globalKey = GlobalKey<ScaffoldState>();
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        routes: {
          SettingsRoutes.global: (_) => Scaffold(
            key: globalKey,
            appBar: AppBar(title: const Text('Global page')),
            drawer: const SettingsNavigationDrawer(
              selected: SettingsDestination.global,
              serverLabel: 'macbook.local:3000',
            ),
          ),
          SettingsRoutes.provider: (_) => Scaffold(
            appBar: AppBar(title: const Text('Provider page')),
            drawer: const SettingsNavigationDrawer(
              selected: SettingsDestination.provider,
              serverLabel: 'macbook.local:3000',
            ),
          ),
        },
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () =>
                  Navigator.pushNamed(context, SettingsRoutes.global),
              child: const Text('Workspace'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Workspace'));
    await tester.pumpAndSettle();
    globalKey.currentState!.openDrawer();
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('settings-nav-provider')));
    await tester.pumpAndSettle();

    expect(find.text('Provider page'), findsOneWidget);
    expect(find.text('Global page'), findsNothing);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Workspace'), findsOneWidget);
  });

  testWidgets('keeps the fixed footer reachable on a short phone', (
    tester,
  ) async {
    var exited = 0;
    await _pumpDrawer(tester, height: 620, onExit: () => exited++);

    expect(tester.takeException(), isNull);
    expect(
      tester.getSize(find.byType(SettingsNavigationDrawer)).width,
      SettingsNavigationDrawer.width,
    );
    final footerRect = tester.getRect(
      find.byKey(const ValueKey('settings-nav-exit')),
    );
    expect(footerRect.bottom, lessThanOrEqualTo(620));

    await tester.tap(find.byKey(const ValueKey('settings-nav-exit')));
    await tester.pumpAndSettle();
    expect(exited, 1);
  });
}
