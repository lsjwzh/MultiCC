import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/services/dashboard_workspace_coordinator.dart';
import 'package:multicc_app/services/dashboard_workspace_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/workspace_service.dart';

class _FakeDirectorySource extends ChangeNotifier {
  List<String> ids;

  _FakeDirectorySource(this.ids);

  void replace(List<String> next) {
    ids = next;
    notifyListeners();
  }

  void ping() => notifyListeners();
}

class _FakeWorkspaceService extends WorkspaceService {
  int connectCalls = 0;
  int disposeCalls = 0;

  _FakeWorkspaceService({required super.settings, required super.dirId});

  @override
  void connect() {
    connectCalls++;
  }

  void publishStatus(String sessionId, String status) {
    statuses[sessionId] = SessionStatus(status: status);
    notifyListeners();
  }

  void publishNotification(String sessionId) {
    onNotify?.call(sessionId, 'done', 'finished');
  }

  @override
  void dispose() {
    disposeCalls++;
    super.dispose();
  }
}

class _ManualReplayScheduler {
  final List<VoidCallback> pending = [];

  void schedule(VoidCallback callback) => pending.add(callback);

  void flush() {
    final callbacks = List<VoidCallback>.of(pending);
    pending.clear();
    for (final callback in callbacks) {
      callback();
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late DashboardWorkspaceStore store;
  late DashboardWorkspaceCoordinator coordinator;
  late Map<String, _FakeWorkspaceService> services;
  late _FakeDirectorySource source;
  late List<String> snapshots;
  late List<String> notifications;
  late _ManualReplayScheduler replayScheduler;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final settings = await SettingsService.getInstance();
    services = {};
    snapshots = [];
    notifications = [];
    replayScheduler = _ManualReplayScheduler();
    source = _FakeDirectorySource(['alpha']);
    store = DashboardWorkspaceStore(
      settings: settings,
      createService: (settings, dirId) {
        final service = _FakeWorkspaceService(settings: settings, dirId: dirId);
        services[dirId] = service;
        return service;
      },
    );
    coordinator = DashboardWorkspaceCoordinator(
      store: store,
      scheduleReplay: replayScheduler.schedule,
    );
  });

  tearDown(() {
    coordinator.dispose();
    store.dispose();
    source.dispose();
  });

  void attach() {
    coordinator.attach(
      source: source,
      readDirectoryIds: () => source.ids,
      onDirectorySnapshot: (dirId, snapshot) {
        snapshots.add('$dirId:${snapshot.statuses.length}');
      },
      onNotify: (sessionId, state, message) {
        notifications.add('$sessionId:$state:$message');
      },
    );
  }

  test('first attachment synchronizes the current directory set', () {
    attach();

    expect(store.directoryIds, {'alpha'});
    expect(services['alpha']!.connectCalls, 1);
  });

  test(
    'directory notifications add and dispose only changed connections',
    () async {
      attach();
      source.replace(['alpha', 'beta']);
      source.replace(['beta']);
      await Future<void>.delayed(Duration.zero);

      expect(store.directoryIds, {'beta'});
      expect(services['alpha']!.connectCalls, 1);
      expect(services['alpha']!.disposeCalls, 1);
      expect(services['beta']!.connectCalls, 1);
      expect(snapshots, contains('alpha:0'));
    },
  );

  test('duplicate source notifications and attachments never reconnect', () {
    attach();
    source.ping();
    source.replace(['alpha', 'alpha']);
    attach(); // mirrors a repeated dependency lifecycle callback
    source.ping();

    expect(store.connectionCount, 1);
    expect(services['alpha']!.connectCalls, 1);
  });

  test('snapshot and notification callbacks flow through the binding', () {
    attach();
    services['alpha']!.publishStatus('session-1', 'running');
    services['alpha']!.publishNotification('session-1');

    expect(snapshots, ['alpha:1']);
    expect(notifications, ['session-1:done:finished']);
  });

  test('manager replacement replays state after the lifecycle frame', () {
    attach();
    services['alpha']!.publishStatus('session-1', 'running');
    snapshots.clear();
    final replacement = _FakeDirectorySource(['alpha']);

    coordinator.attach(
      source: replacement,
      readDirectoryIds: () => replacement.ids,
      onDirectorySnapshot: (dirId, snapshot) {
        snapshots.add('$dirId:${snapshot.statuses.length}');
      },
      onNotify: (_, _, _) {},
    );
    source.replace(['alpha', 'beta']);

    expect(snapshots, isEmpty);
    replayScheduler.flush();

    expect(snapshots, ['alpha:1']);
    expect(services['alpha']!.connectCalls, 1);
    expect(services.containsKey('beta'), isFalse);
    coordinator.dispose();
    replacement.dispose();
  });

  test('manager replacement replays empty snapshots to clear aggregates', () {
    attach();
    final replacement = _FakeDirectorySource(['alpha']);

    coordinator.attach(
      source: replacement,
      readDirectoryIds: () => replacement.ids,
      onDirectorySnapshot: (dirId, snapshot) {
        snapshots.add('$dirId:${snapshot.statuses.length}');
      },
      onNotify: (_, _, _) {},
    );

    expect(snapshots, isEmpty);
    replayScheduler.flush();
    expect(snapshots, ['alpha:0']);
    coordinator.dispose();
    replacement.dispose();
  });

  test('stale scheduled replay is invalidated by a newer attachment', () {
    attach();
    services['alpha']!.publishStatus('session-1', 'running');
    snapshots.clear();
    final firstReplacement = _FakeDirectorySource(['alpha']);
    final secondReplacement = _FakeDirectorySource(['alpha']);
    final firstSnapshots = <String>[];
    final secondSnapshots = <String>[];

    coordinator.attach(
      source: firstReplacement,
      readDirectoryIds: () => firstReplacement.ids,
      onDirectorySnapshot: (dirId, snapshot) {
        firstSnapshots.add('$dirId:${snapshot.statuses.length}');
      },
      onNotify: (_, _, _) {},
    );
    coordinator.attach(
      source: secondReplacement,
      readDirectoryIds: () => secondReplacement.ids,
      onDirectorySnapshot: (dirId, snapshot) {
        secondSnapshots.add('$dirId:${snapshot.statuses.length}');
      },
      onNotify: (_, _, _) {},
    );
    replayScheduler.flush();

    expect(firstSnapshots, isEmpty);
    expect(secondSnapshots, ['alpha:1']);
    coordinator.dispose();
    firstReplacement.dispose();
    secondReplacement.dispose();
  });

  test('dispose invalidates a scheduled manager replay', () {
    attach();
    final replacement = _FakeDirectorySource(['alpha']);
    coordinator.attach(
      source: replacement,
      readDirectoryIds: () => replacement.ids,
      onDirectorySnapshot: (dirId, snapshot) {
        snapshots.add('$dirId:${snapshot.statuses.length}');
      },
      onNotify: (_, _, _) {},
    );

    coordinator.dispose();
    replayScheduler.flush();

    expect(snapshots, isEmpty);
    replacement.dispose();
  });

  test('dispose detaches the source and suppresses later callbacks', () {
    attach();
    coordinator.dispose();

    source.replace(['alpha', 'beta']);
    services['alpha']!.publishStatus('session-1', 'running');
    services['alpha']!.publishNotification('session-1');

    expect(store.directoryIds, {'alpha'});
    expect(services.containsKey('beta'), isFalse);
    expect(snapshots, isEmpty);
    expect(notifications, isEmpty);
  });

  test('MainShell build has no workspace lifecycle side effects', () {
    final sourceText = File('lib/screens/main_shell.dart').readAsStringSync();

    expect(sourceText, isNot(contains('syncDirectories(')));
    expect(sourceText, isNot(contains('configureCallbacks(')));
    expect(sourceText, isNot(contains('.onNotify =')));
    expect(sourceText, contains('mgr.applyWorkspaceSnapshot('));
    expect(sourceText, isNot(contains('mgr.reportWaiting(')));
    expect(sourceText, isNot(contains('mgr.reportRunning(')));
    expect(sourceText, isNot(contains('mgr.reportStatuses(')));
  });
}
