import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/run_config/run_config_sheet.dart';

class HiddenExecutionManager extends SessionManager {
  HiddenExecutionManager(SettingsService settings) : super(settings: settings);
  String? requested;
  @override
  Future<void> loadDashboard() async {}
  @override
  Future<SessionCliConfig> fetchSessionCliConfig(String id) async {
    requested = id;
    return SessionCliConfig(cli: SessionCli.zcode, model: 'fixture-model');
  }
}

class SlowExecutionManager extends SessionManager {
  SlowExecutionManager(SettingsService settings) : super(settings: settings);
  final config = Completer<SessionCliConfig>();
  @override
  Future<void> loadDashboard() async {}
  @override
  Future<SessionCliConfig> fetchSessionCliConfig(String id) => config.future;
}

/// 保存那一趟：第一次 PATCH 像隧道那样在回执前被掐断，第二次正常。
class FlakySaveManager extends SessionManager {
  FlakySaveManager(SettingsService settings, {this.failures = 1})
    : super(settings: settings);
  final int failures;
  int saves = 0;
  final runtime = Completer<SessionCliConfig>();
  @override
  Future<void> loadDashboard() async {}
  @override
  Future<SessionCliConfig> fetchSessionCliConfig(String id) => runtime.future;
  @override
  Future<void> updateSessionAIConfig(
    String id, {
    required String provider,
    required String model,
    required String effort,
    SessionProviderSelection? providerSelection,
    SessionSubagent? subagent,
    bool clearSubagent = false,
    String? agent,
  }) async {
    saves += 1;
    if (saves <= failures) {
      throw http.ClientException(
        'Connection closed before full header was received',
      );
    }
  }
}

Future<void> _pumpEntry(
  WidgetTester tester,
  SessionManager manager,
  SettingsService settings, {
  SessionCli? cli,
  http.Client? httpClient,
}) => tester.pumpWidget(
  ChangeNotifierProvider<SessionManager>.value(
    value: manager,
    child: MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => openRunConfigSheet(
              context,
              settings: settings,
              sessionId: 'task-flaky',
              cli: cli,
              httpClient: httpClient,
            ),
            child: const Text('configure'),
          ),
        ),
      ),
    ),
  ),
);

Future<void> _saveSheet(WidgetTester tester) async {
  final save = find.widgetWithText(ElevatedButton, '保存');
  await tester.ensureVisible(save);
  await tester.tap(save);
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));
  testWidgets(
    'hidden task execution can open the run-config sheet without a Fleet record',
    (tester) async {
      SharedPreferences.setMockInitialValues({
        'multicc_host': 'http://127.0.0.1:1',
      });
      final settings = await SettingsService.getInstance();
      final manager = HiddenExecutionManager(settings);
      try {
        await tester.pumpWidget(
          ChangeNotifierProvider<SessionManager>.value(
            value: manager,
            child: MaterialApp(
              home: Scaffold(
                body: Builder(
                  builder: (context) => TextButton(
                    onPressed: () => openRunConfigSheet(
                      context,
                      settings: settings,
                      sessionId: 'task-hidden',
                    ),
                    child: const Text('configure'),
                  ),
                ),
              ),
            ),
          ),
        );
        expect(manager.sessions, isEmpty);
        await tester.tap(find.text('configure'));
        await tester.pumpAndSettle();
        expect(manager.requested, 'task-hidden');
        expect(find.byType(RunConfigSheet), findsOneWidget);
        expect(find.text(I18n.of('sessionNotLoaded')), findsNothing);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        manager.dispose();
      }
    },
  );

  testWidgets(
    'run-config route opens before a slow runtime/model request finishes',
    (tester) async {
      SharedPreferences.setMockInitialValues({
        'multicc_host': 'http://127.0.0.1:1',
      });
      final settings = await SettingsService.getInstance();
      final manager = SlowExecutionManager(settings);
      try {
        await tester.pumpWidget(
          ChangeNotifierProvider<SessionManager>.value(
            value: manager,
            child: MaterialApp(
              home: Scaffold(
                body: Builder(
                  builder: (context) => TextButton(
                    onPressed: () => openRunConfigSheet(
                      context,
                      settings: settings,
                      sessionId: 'slow-task',
                    ),
                    child: const Text('configure slow'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('configure slow'));
        await tester.pump();
        expect(
          find.byKey(const ValueKey('ai-config-loading')),
          findsOneWidget,
          reason: '点击后下一帧就要看到弹层，不等网络',
        );
        expect(find.byType(RunConfigSheet), findsNothing);

        manager.config.complete(
          SessionCliConfig(cli: SessionCli.zcode, model: 'fixture-model'),
        );
        await tester.pumpAndSettle();
        expect(find.byType(RunConfigSheet), findsOneWidget);
      } finally {
        if (!manager.config.isCompleted) {
          manager.config.complete(
            SessionCliConfig(cli: SessionCli.zcode, model: 'fixture-model'),
          );
        }
        await tester.pumpWidget(const SizedBox.shrink());
        manager.dispose();
      }
    },
  );

  testWidgets('调用方给了车道：Provider 池与会话运行时并行取，不等运行时回来', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:1',
    });
    final settings = await SettingsService.getInstance();
    final manager = FlakySaveManager(settings);
    final providerRequests = <String>[];
    final client = MockClient((request) async {
      providerRequests.add(request.url.query);
      return http.Response('{"providers":[]}', 200);
    });
    try {
      await _pumpEntry(
        tester,
        manager,
        settings,
        cli: SessionCli.zcode,
        httpClient: client,
      );
      await tester.tap(find.text('configure'));
      await tester.pump();
      expect(providerRequests, ['cli=zcode'], reason: '运行时还没回来，池子已经在取');
      manager.runtime.complete(SessionCliConfig(cli: SessionCli.zcode));
      await tester.pumpAndSettle();
      expect(find.byType(RunConfigSheet), findsOneWidget);
      expect(providerRequests, ['cli=zcode'], reason: '猜对了车道就不再补取');
    } finally {
      if (!manager.runtime.isCompleted) {
        manager.runtime.complete(SessionCliConfig(cli: SessionCli.zcode));
      }
      await tester.pumpWidget(const SizedBox.shrink());
      manager.dispose();
    }
  });

  testWidgets('车道猜错（会话刚在别处换了车道）按真实车道补取一次', (tester) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:1',
    });
    final settings = await SettingsService.getInstance();
    final manager = FlakySaveManager(settings);
    final providerRequests = <String>[];
    final client = MockClient((request) async {
      if (request.url.path == '/api/providers') {
        providerRequests.add(request.url.query);
      }
      return http.Response('{"providers":[]}', 200);
    });
    try {
      await _pumpEntry(
        tester,
        manager,
        settings,
        cli: SessionCli.opencode,
        httpClient: client,
      );
      await tester.tap(find.text('configure'));
      await tester.pump();
      manager.runtime.complete(SessionCliConfig(cli: SessionCli.zcode));
      await tester.pumpAndSettle();
      expect(providerRequests, ['cli=opencode', 'cli=zcode']);
      expect(find.byType(RunConfigSheet), findsOneWidget);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      manager.dispose();
    }
  });

  testWidgets('保存回执被隧道掐断：原样重发一次，成功就报已保存', (tester) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:1',
    });
    final settings = await SettingsService.getInstance();
    final manager = FlakySaveManager(settings);
    manager.runtime.complete(SessionCliConfig(cli: SessionCli.zcode));
    final client = MockClient(
      (_) async => http.Response('{"providers":[]}', 200),
    );
    try {
      await _pumpEntry(tester, manager, settings, httpClient: client);
      await tester.tap(find.text('configure'));
      await tester.pumpAndSettle();
      await _saveSheet(tester);
      expect(manager.saves, 2);
      expect(find.textContaining('✓ 运行配置已保存'), findsOneWidget);
      expect(find.textContaining('ClientException'), findsNothing);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      manager.dispose();
    }
  });

  testWidgets('重发也断：说人话，不甩传输层原文', (tester) async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:1',
    });
    final settings = await SettingsService.getInstance();
    final manager = FlakySaveManager(settings, failures: 2);
    manager.runtime.complete(SessionCliConfig(cli: SessionCli.zcode));
    final client = MockClient(
      (_) async => http.Response('{"providers":[]}', 200),
    );
    try {
      await _pumpEntry(tester, manager, settings, httpClient: client);
      await tester.tap(find.text('configure'));
      await tester.pumpAndSettle();
      await _saveSheet(tester);
      expect(manager.saves, 2, reason: '只重发一次');
      expect(find.textContaining('网络连接中断'), findsOneWidget);
      expect(find.textContaining('ClientException'), findsNothing);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      manager.dispose();
    }
  });

  test('非网络错误不重发，去掉 Exception: 前缀后原样给出服务端的话', () {
    expect(isTransientNetworkError(Exception('invalid provider')), isFalse);
    expect(isTransientNetworkError(TimeoutException('slow')), isTrue);
    expect(
      runConfigSaveFailureText(Exception('invalid provider')),
      '运行配置保存失败：invalid provider',
    );
  });
}
