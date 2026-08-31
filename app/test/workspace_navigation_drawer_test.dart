import 'dart:io';
import 'dart:ui' show SemanticsFlag;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/theme.dart';
import 'package:multicc_app/widgets/workspace_navigation_drawer.dart';

const _destinations = <WorkspaceDestination>[
  WorkspaceDestination.overview,
  WorkspaceDestination.cron,
  WorkspaceDestination.memory,
  WorkspaceDestination.voice,
  WorkspaceDestination.goal,
  WorkspaceDestination.provider,
  WorkspaceDestination.global,
  WorkspaceDestination.push,
  WorkspaceDestination.tunnel,
  WorkspaceDestination.bridges,
  WorkspaceDestination.resources,
  WorkspaceDestination.skillSync,
  WorkspaceDestination.storage,
];

Future<GlobalKey<ScaffoldState>> _pumpDrawer(
  WidgetTester tester, {
  WorkspaceDestination selected = WorkspaceDestination.overview,
  ValueChanged<WorkspaceDestination>? onSelected,
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
        appBar: AppBar(title: const Text('Workspace host')),
        drawer: WorkspaceNavigationDrawer(
          selected: selected,
          serverLabel: 'macbook.local:3000',
          workspaceCount: 4,
          cronCount: 2,
          onSelected: onSelected ?? (_) {},
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

  test('workspace owns the drawer while settings screens stay standalone', () {
    final homeSource = File('lib/screens/main_shell.dart').readAsStringSync();
    expect(homeSource, contains('drawer: WorkspaceNavigationDrawer('));
    expect(homeSource, contains("ValueKey('workspace-menu-button')"));

    for (final path in [
      'lib/screens/settings_screen.dart',
      'lib/screens/provider_screen.dart',
      'lib/screens/push_settings_screen.dart',
      'lib/screens/tunnel_settings_screen.dart',
      'lib/screens/bridge_settings_screen.dart',
      'lib/screens/voice_settings_screen.dart',
      'lib/screens/agent_resources_screen.dart',
    ]) {
      final source = File(path).readAsStringSync();
      expect(source, isNot(contains('drawer:')), reason: path);
    }
  });

  testWidgets('matches the web Workspace and Settings destination order', (
    tester,
  ) async {
    await _pumpDrawer(tester);

    expect(
      WorkspaceNavigationDrawer.workspaceDestinations,
      _destinations.take(3),
    );
    expect(
      WorkspaceNavigationDrawer.settingsDestinations,
      _destinations.skip(3),
    );
    final expectedKeys = _destinations
        .map((destination) => 'workspace-nav-${destination.name}')
        .toList(growable: false);
    final expectedKeySet = expectedKeys.toSet();
    final actualKeys = tester.allWidgets
        .map((widget) => widget.key)
        .whereType<ValueKey<String>>()
        .map((key) => key.value)
        .where(expectedKeySet.contains)
        .toList(growable: false);

    expect(actualKeys, expectedKeys);
    expect(find.text(t('workspace').toUpperCase()), findsOneWidget);
    expect(find.text(t('settingsTitle').toUpperCase()), findsOneWidget);
    expect(find.text('4'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
  });

  testWidgets('marks Overview active and keeps 44dp touch targets', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await _pumpDrawer(tester);

    final selected = tester.getSemantics(
      find.byKey(const ValueKey('workspace-nav-overview')),
    );
    final unselected = tester.getSemantics(
      find.byKey(const ValueKey('workspace-nav-global')),
    );
    expect(selected.hasFlag(SemanticsFlag.isSelected), isTrue);
    expect(unselected.hasFlag(SemanticsFlag.isSelected), isFalse);

    for (final destination in _destinations) {
      expect(
        tester
            .getSize(find.byKey(ValueKey('workspace-nav-${destination.name}')))
            .height,
        greaterThanOrEqualTo(44),
      );
    }
    semantics.dispose();
  });

  testWidgets('closes the home drawer and delegates destination selection', (
    tester,
  ) async {
    WorkspaceDestination? chosen;
    final scaffoldKey = await _pumpDrawer(
      tester,
      onSelected: (destination) => chosen = destination,
    );

    await tester.tap(find.byKey(const ValueKey('workspace-nav-provider')));
    await tester.pumpAndSettle();

    expect(chosen, WorkspaceDestination.provider);
    expect(scaffoldKey.currentState!.isDrawerOpen, isFalse);
  });

  testWidgets('keeps the connected-server footer reachable on a short phone', (
    tester,
  ) async {
    await _pumpDrawer(tester, height: 620);

    expect(tester.takeException(), isNull);
    expect(
      tester.getSize(find.byType(WorkspaceNavigationDrawer)).width,
      WorkspaceNavigationDrawer.width,
    );
    final footerRect = tester.getRect(
      find.byKey(const ValueKey('workspace-nav-server')),
    );
    expect(footerRect.bottom, lessThanOrEqualTo(620));
    expect(find.text('macbook.local:3000'), findsOneWidget);
  });
}
