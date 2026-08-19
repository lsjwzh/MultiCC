import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/services/dashboard_workspace_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/workspace_service.dart';

class _FakeWorkspaceService extends WorkspaceService {
  int connectCalls = 0;
  int disposeCalls = 0;

  _FakeWorkspaceService({required super.settings, required super.dirId});

  @override
  void connect() {
    connectCalls++;
  }

  void publish({
    Map<String, SessionStatus> nextStatuses = const {},
    Map<String, int> nextPendingNotes = const {},
    List<Map<String, dynamic>> nextEvents = const [],
  }) {
    statuses
      ..clear()
      ..addAll(nextStatuses);
    pendingNotes
      ..clear()
      ..addAll(nextPendingNotes);
    events
      ..clear()
      ..addAll(nextEvents);
    notifyListeners();
  }

  void publishNotification(String sessionId, String state, String message) {
    onNotify?.call(sessionId, state, message);
  }

  @override
  void dispose() {
    disposeCalls++;
    super.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SettingsService settings;
  late Map<String, _FakeWorkspaceService> services;
  late DashboardWorkspaceStore store;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    settings = await SettingsService.getInstance();
    services = {};
    store = DashboardWorkspaceStore(
      settings: settings,
      createService: (settings, dirId) {
        final service = _FakeWorkspaceService(settings: settings, dirId: dirId);
        services[dirId] = service;
        return service;
      },
    );
  });

  tearDown(() {
    store.dispose();
  });

  test('owns exactly one connection per dashboard directory', () {
    store.syncDirectories(['alpha', 'beta']);
    store.syncDirectories(['beta', 'alpha', 'alpha']);

    expect(store.directoryIds, {'alpha', 'beta'});
    expect(store.connectionCount, 2);
    expect(services['alpha']!.connectCalls, 1);
    expect(services['beta']!.connectCalls, 1);
    expect(store.listenableFor('alpha'), isNotNull);
    expect(
      identical(store.listenableFor('alpha'), store.listenableFor('alpha')),
      isTrue,
    );
  });

  test('publishes immutable projections and aggregate status sets', () {
    final observed = <DirectoryWorkspaceSnapshot>[];
    store.configureCallbacks(
      onDirectorySnapshot: (dirId, snapshot) {
        expect(dirId, 'alpha');
        observed.add(snapshot);
      },
      onNotify: (_, _, _) {},
    );
    store.syncDirectories(['alpha']);

    services['alpha']!.publish(
      nextStatuses: const {
        'waiting': SessionStatus(status: 'waiting'),
        'running': SessionStatus(status: 'running'),
        'editing': SessionStatus(status: 'editing'),
        'idle': SessionStatus(status: 'idle'),
      },
      nextPendingNotes: const {'waiting': 2},
      nextEvents: const [
        {'type': 'status', 'sessionId': 'running'},
      ],
    );

    final snapshot = store.snapshotFor('alpha');
    expect(observed, hasLength(1));
    expect(snapshot.waitingSessionIds, {'waiting'});
    expect(snapshot.runningSessionIds, {'running', 'editing'});
    expect(snapshot.pendingNotes['waiting'], 2);
    expect(
      () => snapshot.statuses['new'] = const SessionStatus(status: 'idle'),
      throwsUnsupportedError,
    );
    expect(
      () => snapshot.events.first['type'] = 'mutated',
      throwsUnsupportedError,
    );
  });

  test('forwards notifications and disposes removed connections', () async {
    final notifications = <String>[];
    final cleared = <String>[];
    store.configureCallbacks(
      onNotify: (sessionId, state, message) {
        notifications.add('$sessionId:$state:$message');
      },
      onDirectorySnapshot: (dirId, snapshot) {
        if (snapshot.statuses.isEmpty) cleared.add(dirId);
      },
    );
    store.syncDirectories(['alpha', 'beta']);
    services['alpha']!.publishNotification('session-1', 'done', 'finished');

    store.syncDirectories(['beta']);
    await Future<void>.delayed(Duration.zero);

    expect(notifications, ['session-1:done:finished']);
    expect(services['alpha']!.disposeCalls, 1);
    expect(services['beta']!.disposeCalls, 0);
    expect(cleared, ['alpha']);
  });

  test(
    'remove then same-tick re-add invalidates the old empty report',
    () async {
      final observed = <String>[];
      store.configureCallbacks(
        onNotify: (_, _, _) {},
        onDirectorySnapshot: (dirId, snapshot) {
          observed.add('$dirId:${snapshot.statuses.keys.join(',')}');
        },
      );
      store.syncDirectories(['alpha']);
      final removedService = services['alpha']!;
      store.syncDirectories(const []);
      store.syncDirectories(['alpha']);
      final replacementService = services['alpha']!;
      replacementService.publish(
        nextStatuses: const {'new': SessionStatus(status: 'running')},
      );

      await Future<void>.delayed(Duration.zero);

      expect(identical(removedService, replacementService), isFalse);
      expect(observed, ['alpha:new']);
      expect(store.snapshotFor('alpha').statuses.keys, {'new'});
    },
  );

  test('removed service clears and guards its notification callback', () {
    final notifications = <String>[];
    store.configureCallbacks(
      onDirectorySnapshot: (_, _) {},
      onNotify: (sessionId, state, message) {
        notifications.add('$sessionId:$state:$message');
      },
    );
    store.syncDirectories(['alpha']);
    final removedService = services['alpha']!;
    final staleNotify = removedService.onNotify!;

    store.syncDirectories(const []);
    store.syncDirectories(['alpha']);
    final replacementService = services['alpha']!;
    staleNotify('stale', 'done', 'old service');
    replacementService.publishNotification('current', 'done', 'new service');

    expect(removedService.onNotify, isNull);
    expect(notifications, ['current:done:new service']);
  });

  test('task run stream events surface on a per-directory listenable', () {
    store.syncDirectories(['alpha']);
    final listenable = store.taskRunEventsFor('alpha');
    expect(listenable, isNotNull);

    final received = <String>[];
    listenable!.addListener(() => received.add(listenable.value!.taskId));

    services['alpha']!.onTaskRunEvent?.call(
      const TaskRunStreamEvent(taskId: 'task-1', runId: 'run-9'),
    );
    expect(received, ['task-1']);

    // Removal detaches the service callback and disposes the notifier — a
    // stale service can never reach a disposed listenable.
    final removedService = services['alpha']!;
    store.syncDirectories(const []);
    expect(removedService.onTaskRunEvent, isNull);
    expect(store.taskRunEventsFor('alpha'), isNull);

    // A re-added directory gets a fresh listenable, not the disposed one.
    store.syncDirectories(['alpha']);
    final replacement = store.taskRunEventsFor('alpha');
    expect(replacement, isNotNull);
    expect(identical(replacement, listenable), isFalse);
  });

  test('store disposal closes every remaining connection once', () {
    store.syncDirectories(['alpha', 'beta']);
    store.dispose();

    expect(services['alpha']!.disposeCalls, 1);
    expect(services['beta']!.disposeCalls, 1);
    expect(store.connectionCount, 0);

    // Idempotent shutdown and no resurrection after disposal.
    store.dispose();
    store.syncDirectories(['gamma']);
    expect(services.containsKey('gamma'), isFalse);
  });

  test('dashboard widgets cannot instantiate workspace transports', () {
    final shell = File('lib/screens/main_shell.dart').readAsStringSync();
    final owner = File(
      'lib/services/dashboard_workspace_store.dart',
    ).readAsStringSync();

    expect(RegExp(r'WorkspaceService\s*\(').allMatches(shell), isEmpty);
    expect(RegExp(r'\.connect\s*\(').allMatches(shell), isEmpty);
    expect(RegExp(r'WorkspaceService\s*\(').allMatches(owner).length, 1);
  });
}
