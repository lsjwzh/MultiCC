import 'dart:async';
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
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/chat_loading_view.dart';

class _Manager extends SessionManager {
  _Manager(SettingsService settings) : super(settings: settings);
  final opened = <String>[];
  @override
  Future<void> loadDashboard() async {}
  @override
  void openSessionWithFocus(
    Session session, {
    String? focusMessageId,
    bool historyArchive = false,
  }) {
    opened.add(session.id);
    expect(historyArchive, true);
  }
}

Session _session(String id) =>
    Session(id: id, kind: SessionKind.chat, createdAt: DateTime(2026));
http.Response _json(Map<String, dynamic> body, [int status = 200]) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:1',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  test(
    'chat open needs one small request, without task details or another session lookup',
    () async {
      final requests = <String>[];
      final client = MockClient((request) async {
        requests.add(request.url.path);
        return _json({
          'ok': true,
          'session': {
            'id': 'bound',
            'kind': 'chat',
            'cli': 'codex',
            'label': '库存同步',
            'autoCommit': false,
            'taskBoundTaskId': 'stock',
          },
        });
      });
      final service = AirService(
        settings: await _settings(),
        httpClient: client,
      );
      final session = await service.openTaskSession('stock');
      expect(requests, ['/api/air/tasks/stock/open']);
      expect(session.id, 'bound');
      expect(session.label, '库存同步');
      expect(session.autoCommit, false);
      client.close();
    },
  );

  test(
    'old host fallback retains read-only source bindings; permission failures never downgrade',
    () async {
      final requests = <String>[];
      final client = MockClient((request) async {
        requests.add(request.url.path);
        if (request.url.path.endsWith('/open')) {
          return http.Response('Cannot GET', 404);
        }
        return _json({
          'ok': true,
          'readOnly': true,
          'sourceSessionId': 'source',
          'sessionId': 'reserved',
        });
      });
      final service = AirService(
        settings: await _settings(),
        httpClient: client,
      );
      final session = await service.openTaskSession(
        'old',
        cachedSession: (id) => id == 'source' ? _session(id) : null,
      );
      expect(session.id, 'source');
      expect(requests.length, 2);
      client.close();
      final denied = MockClient(
        (request) async => _json({'ok': false, 'code': 'forbidden'}, 403),
      );
      await expectLater(
        AirService(
          settings: await _settings(),
          httpClient: denied,
        ).openTaskSession('denied'),
        throwsException,
      );
      denied.close();
    },
  );

  test(
    'cancelled, superseded and disposed opens cannot activate a late result',
    () async {
      final manager = _Manager(await _settings());
      final first = Completer<Session>(), second = Completer<Session>();
      final pending = manager.openChatAfterLoad(
        title: 'old',
        load: () => first.future,
      );
      expect(manager.pendingChatOpen?.title, 'old');
      manager.cancelPendingChatOpen();
      final next = manager.openChatAfterLoad(
        title: 'new',
        load: () => second.future,
      );
      first.complete(_session('old'));
      expect(await pending, false);
      expect(manager.pendingChatOpen?.title, 'new');
      second.complete(_session('new'));
      expect(await next, true);
      expect(manager.opened, ['new']);
      final late = Completer<Session>();
      final disposed = manager.openChatAfterLoad(
        title: 'disposed',
        load: () => late.future,
      );
      manager.dispose();
      late.complete(_session('disposed'));
      expect(await disposed, false);
      expect(manager.opened, ['new']);
    },
  );

  test('retry replaces the failed request', () async {
    final manager = _Manager(await _settings());
    final retried = Completer<Session>();
    var calls = 0;
    await manager.openChatAfterLoad(
      title: '库存同步',
      load: () {
        calls++;
        if (calls == 1) return Future.error(StateError('offline'));
        return retried.future;
      },
    );
    expect(manager.pendingChatOpen?.error, contains('offline'));
    manager.retryPendingChatOpen();
    expect(manager.pendingChatOpen?.error, isNull);
    retried.complete(_session('stock'));
    await Future<void>.delayed(Duration.zero);
    expect(manager.opened, ['stock']);
    manager.dispose();
  });

  test('retrying a stalled load ignores the original response', () async {
    final manager = _Manager(await _settings());
    final first = Completer<Session>(), second = Completer<Session>();
    var calls = 0;
    final opening = manager.openChatAfterLoad(
      title: 'slow',
      load: () => ++calls == 1 ? first.future : second.future,
    );
    manager.retryPendingChatOpen();
    second.complete(_session('retried'));
    await Future<void>.delayed(Duration.zero);
    first.complete(_session('stale'));
    expect(await opening, false);
    expect(manager.opened, ['retried']);
    expect(manager.pendingChatOpen, isNull);
    manager.dispose();
  });

  testWidgets(
    'the real shell paints a loading page before a slow request completes and Back cancels it',
    (tester) async {
      final settings = await _settings();
      final manager = _Manager(settings);
      final response = Completer<Session>();
      await tester.pumpWidget(
        ChangeNotifierProvider<SessionManager>.value(
          value: manager,
          child: MaterialApp(home: MainShell(settings: settings)),
        ),
      );
      final opening = manager.openChatAfterLoad(
        title: '慢网任务',
        load: () => response.future,
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('pending-chat-open')), findsOneWidget);
      expect(find.text('慢网任务'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(ChatLoadingView),
          matching: find.byType(CircularProgressIndicator),
        ),
        findsOneWidget,
      );
      await tester.tap(
        find.descendant(
          of: find.byType(ChatLoadingView),
          matching: find.byType(BackButton),
        ),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('pending-chat-open')), findsNothing);
      response.complete(_session('late'));
      await tester.pump();
      expect(await opening, false);
      expect(manager.opened, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      manager.dispose();
    },
  );
}
