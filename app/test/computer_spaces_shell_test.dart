import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/screens/main_shell.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/machine_service.dart';
import 'package:multicc_app/services/onboarding_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_computers.dart';
import 'package:multicc_app/widgets/air/air_mobile_workspace.dart';
import 'package:multicc_app/widgets/computer_spaces_shell.dart';
import 'package:multicc_app/widgets/input_bar.dart';

const _local = ManagedComputer(id: 'machine_entry', name: '入口 Mac', local: true);
const _remote = ManagedComputer(id: 'machine_a', name: '工作 Mac',
  origin: 'https://remote.example');

// MainShell has continuous connection animations. Use bounded frames throughout.
Future<void> _frames(WidgetTester tester, [int count = 30]) async {
  for (var i = 0; i < count; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

SpacesScope _scope(WidgetTester tester) =>
    tester.widget<SpacesScope>(find.byType(SpacesScope).first);

Finder _shell(String? machineId, {bool offstage = false}) => find.byWidgetPredicate(
  (w) => w is MainShell && w.settings.machineId == machineId,
  skipOffstage: !offstage,
);

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:1', OnboardingStore.doneKey: '1',
  });
  final settings = await SettingsService.getInstance();
  await settings.save(host: 'http://127.0.0.1:1', token: '', session: '', cwd: '');
  return settings;
}

http.Client _transport(List<String> requests, {int remoteCount = 1,
    bool failList = false}) => MockClient((request) async {
  requests.add('${request.method} ${request.url.path}');
  Object body = <String, dynamic>{};
  if (request.url.path == '/api/machines') {
    if (failList) return http.Response('{"error":"offline"}', 503);
    body = {
      'self': {'id': _local.id, 'name': _local.name, 'local': true},
      'machines': [for (var i = 0; i < remoteCount; i++) {
        'id': 'machine_${String.fromCharCode(97 + i)}',
        'name': i == 0 ? _remote.name : '远端 $i',
        'origin': _remote.origin,
      }],
    };
  } else if (request.url.path.endsWith('/api/air')) {
    body = {'directories': [], 'tasks': [], 'sessions': [], 'clis': []};
  }
  return http.Response(jsonEncode(body), 200,
    headers: {'content-type': 'application/json; charset=utf-8'});
});

Future<void> _pump(WidgetTester tester, http.Client transport) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(390, 844);
  addTearDown(tester.view.reset);
  final settings = await _settings();
  await tester.pumpWidget(MaterialApp(home:
    ComputerSpacesShell(settings: settings, httpClient: transport)));
  await _frames(tester);
}

Future<void> _dispose(WidgetTester tester, http.Client transport) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await _frames(tester);
  transport.close();
}

void main() {
  setUpAll(() => I18n.init('zh'));

  for (final gesture in ['tap', 'long press', 'swipe up']) {
    testWidgets('phone dock enters overview by $gesture', (tester) async {
      final transport = _transport([]);
      await _pump(tester, transport);
      final dock = find.byKey(const ValueKey('air-space-dock-handle'));
      expect(dock, findsOneWidget);
      expect(find.descendant(of: dock, matching: find.text(_local.name)), findsOneWidget);
      expect(find.byKey(ValueKey('space-dock-dot-${_local.id}')), findsOneWidget);
      expect(find.byKey(ValueKey('space-dock-dot-${_remote.id}')), findsOneWidget);
      if (gesture == 'tap') {
        await tester.tap(dock);
      } else if (gesture == 'long press') {
        await tester.longPress(dock);
      } else {
        await tester.fling(dock, const Offset(0, -70), 500);
      }
      await _frames(tester);
      expect(_scope(tester).inOverview, isTrue);
      expect(find.text(t('spacesAllComputers')), findsOneWidget);
      expect(find.byKey(ValueKey('space-overview-card-${_local.id}')), findsOneWidget);
      // System back exits overview; it must leave the active desktop intact.
      final original = tester.state(_shell(null));
      await tester.binding.handlePopRoute();
      await _frames(tester);
      expect(_scope(tester).inOverview, isFalse);
      expect(tester.state(_shell(null)), same(original));
      await _dispose(tester, transport);
    });
  }

  testWidgets('gallery opens a full remote MainShell and proxies to that computer', (tester) async {
    final requests = <String>[];
    final transport = _transport(requests);
    await _pump(tester, transport);
    _scope(tester).enterOverview();
    await _frames(tester);
    final gallery = tester.widget<PageView>(find.byKey(const ValueKey('spaces-overview-gallery')));
    expect(gallery.controller!.viewportFraction, .76);
    await tester.tap(find.byKey(const ValueKey('space-overview-dot-1')));
    await _frames(tester);
    await tester.tap(find.byKey(ValueKey('space-overview-card-${_remote.id}')));
    await _frames(tester);
    expect(_scope(tester).activeMachine.id, _remote.id);
    final shell = tester.widget<MainShell>(_shell(_remote.id));
    expect(shell.settings.machineDirectoryId, isNull);
    expect(shell.settings.buildHttpUrl('/api/directories'),
      'http://127.0.0.1:1/api/machines/machine_a/proxy/api/directories');
    expect(requests, contains('GET /api/machines/machine_a/proxy/api/air'));
    expect(find.byType(ComputerTargetShell), findsNothing);
    expect(find.byType(NavigationBar), findsOneWidget);
    expect(find.byType(AppBar), findsOneWidget);
    for (final label in ['控制台', '定时任务', '工作目录']) {
      expect(find.text(label), findsWidgets);
    }
    _scope(tester).enterOverview();
    await _frames(tester);
    await tester.tap(find.byKey(const ValueKey('space-overview-dot-2')));
    await _frames(tester);
    await tester.tap(find.byKey(const ValueKey('space-overview-add-card')));
    await _frames(tester);
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(find.byType(TextFormField), findsNWidgets(3));
    await tester.tap(find.text(t('cancel')));
    await _frames(tester);
    await _dispose(tester, transport);
  });

  testWidgets('warm desktops retain navigation, live chat, draft and private routes', (tester) async {
    final transport = _transport([]);
    await _pump(tester, transport);
    final originalState = tester.state(_shell(null));
    await tester.tap(find.text('工作目录').last);
    await _frames(tester);
    final mgr = tester.element(_shell(null)).read<SessionManager>();
    mgr.openSession(Session(id: 'spaces-chat', cwd: '/projects/a',
      kind: SessionKind.chat, createdAt: DateTime.now()));
    mgr.switchToSession('spaces-chat');
    await _frames(tester);
    final input = find.descendant(of: find.byType(InputBar), matching: find.byType(TextField));
    await tester.enterText(input, '尚未发送的草稿');
    // Chat title is the auxiliary hot spot, including fullscreen chat.
    await tester.longPress(find.textContaining('spaces-chat').first);
    await _frames(tester);
    expect(_scope(tester).inOverview, isTrue);
    _scope(tester).switchToMachine(_remote);
    await _frames(tester);
    expect(mgr.activeSessionId, 'spaces-chat');
    _scope(tester).switchToMachine(_local);
    await _frames(tester);
    expect(tester.state(_shell(null)), same(originalState));
    expect(tester.element(_shell(null)).read<SessionManager>(), same(mgr));
    expect(find.text('尚未发送的草稿'), findsOneWidget);
    // Back on B must not close the parked chat on A.
    _scope(tester).switchToMachine(_remote);
    await _frames(tester);
    final bContext = tester.element(_shell(_remote.id));
    Navigator.of(bContext).push(MaterialPageRoute<void>(builder: (_) =>
      const Scaffold(body: Text('B 的独立路由'))));
    await _frames(tester);
    await tester.binding.handlePopRoute();
    await _frames(tester);
    expect(find.text('B 的独立路由'), findsNothing);
    expect(mgr.activeSessionId, 'spaces-chat');
    _scope(tester).switchToMachine(_local);
    await _frames(tester);
    mgr.goToSessionList();
    await _frames(tester);
    final nav = tester.widget<NavigationBar>(find.byType(NavigationBar));
    expect(nav.selectedIndex, 2);
    await _dispose(tester, transport);
  });

  testWidgets('fourth desktop evicts and disposes only the least recently used slot', (tester) async {
    final transport = _transport([], remoteCount: 3);
    await _pump(tester, transport);
    final original = tester.state(_shell(null));
    final evictedManager = tester.element(_shell(null)).read<SessionManager>();
    for (final machine in _scope(tester).machines.where((m) => !m.local).toList()) {
      _scope(tester).switchToMachine(machine);
      await _frames(tester);
    }
    expect(find.byType(MainShell, skipOffstage: false), findsNWidgets(3));
    expect(_shell(null, offstage: true), findsNothing);
    expect(() => evictedManager.addListener(() {}), throwsFlutterError,
      reason: 'LRU eviction must dispose the provider, not only hide its widget');
    _scope(tester).switchToMachine(_local);
    await _frames(tester);
    expect(tester.state(_shell(null)), isNot(same(original)));
    expect(find.byType(MainShell, skipOffstage: false), findsNWidgets(3));
    await _dispose(tester, transport);
  });

  testWidgets('refresh updates a warm remote identity without recreating its desktop', (tester) async {
    var renamed = false;
    final transport = MockClient((request) async => http.Response(jsonEncode(
      request.url.path == '/api/machines' ? {
        'self': {'id': _local.id, 'name': _local.name, 'local': true},
        'machines': [{'id': _remote.id,
          'name': renamed ? '新名称' : _remote.name,
          'origin': renamed ? 'https://new.example' : _remote.origin}],
      } : {'directories': [], 'tasks': [], 'sessions': [], 'clis': []}),
      200, headers: {'content-type': 'application/json'}));
    await _pump(tester, transport);
    _scope(tester).switchToMachine(_remote);
    await _frames(tester);
    final original = tester.state(_shell(_remote.id));
    renamed = true;
    await _scope(tester).refreshMachines();
    await _frames(tester);
    expect(tester.state(_shell(_remote.id)), same(original));
    final settings = tester.widget<MainShell>(_shell(_remote.id)).settings;
    expect(settings.machineName, '新名称');
    expect(settings.machineOrigin, 'https://new.example');
    await _dispose(tester, transport);
  });

  testWidgets('machine list failure still mounts a usable entry desktop', (tester) async {
    final transport = _transport([], failList: true);
    await _pump(tester, transport);
    expect(_shell(null), findsOneWidget);
    expect(_scope(tester).machines, hasLength(1));
    expect(find.byType(NavigationBar), findsOneWidget);
    await tester.longPress(find.byKey(const ValueKey('air-mobile-project-picker')));
    await _frames(tester);
    expect(_scope(tester).inOverview, isTrue);
    await _dispose(tester, transport);
  });

  testWidgets('task row long press keeps its own action inside SpacesScope', (tester) async {
    var overview = 0, actions = 0;
    final task = AirTask.fromJson({'id': 'task-one', 'dirId': 'one',
      'title': '长按任务', 'status': 'active', 'runState': 'waiting'});
    final snapshot = AirSnapshot(directories: const [], tasks: [task],
      clis: const [], sessions: const []);
    await tester.pumpWidget(MaterialApp(home: SpacesScope(
      machines: const [_local, _remote], activeMachine: _local, inOverview: false,
      enterOverview: () => overview++, exitOverview: () {},
      switchToMachine: (_) {}, openAddMachineDialog: (_) async {},
      refreshMachines: () async {}, setPressed: (_) {},
      child: Scaffold(body: AirMobileWorkspace(data: snapshot, directoryId: null,
        recentTasks: [task], onOpenTask: (_) {}, onRefresh: () async {},
        onResource: (_) {}, onTaskAction: (_) => actions++)),
    )));
    await _frames(tester);
    await tester.longPress(find.text('长按任务').first);
    await _frames(tester);
    expect(actions, 1);
    expect(overview, 0);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
