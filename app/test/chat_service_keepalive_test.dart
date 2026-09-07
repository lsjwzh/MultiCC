import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/ws_ticket_service.dart';

/// Minimal in-memory WebSocket transport. [incoming] lets the test play the
/// server side (pong, chat_history, …); [sent] records frames the client wrote.
class _FakeSink implements WebSocketSink {
  _FakeSink(this.sent);
  final List<String> sent;
  @override
  void add(dynamic data) => sent.add(data is String ? data : jsonEncode(data));
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future addStream(Stream stream) => Future.value();
  @override
  Future close([int? closeCode, String? closeReason]) => Future.value();
  @override
  Future get done => Future.value();
}

class _FakeChannel extends StreamChannelMixin implements WebSocketChannel {
  _FakeChannel(this.incoming, this.sent);
  final StreamController<dynamic> incoming;
  final List<String> sent;
  @override
  String? get protocol => null;
  @override
  int? get closeCode => null;
  @override
  String? get closeReason => null;
  @override
  Future<void> get ready => Future.value();
  @override
  WebSocketSink get sink => _FakeSink(sent);
  @override
  Stream get stream => incoming.stream;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SettingsService settings;
  Future<void> setupSettings() async {
    SharedPreferences.setMockInitialValues({});
    settings = await SettingsService.getInstance();
    await settings.save(host: 'https://example.test', token: '');
  }

  /// Builds a ChatService whose sockets are [_FakeChannel]s — one per connect,
  /// so a reconnect lands on a fresh live transport (mirroring the real app).
  /// Returns the service plus the list of channels in creation order.
  (ChatService, List<_FakeChannel>) makeService({bool historyArchive = false, http.Client? httpClient, List<Uri>? urls}) {
    final channels = <_FakeChannel>[];
    final service = ChatService(
      settings: settings,
      sessionName: 'chat one',
      sessionCwd: '/tmp/work',
      historyArchive: historyArchive,
      httpClient: httpClient ?? MockClient((_) async => http.Response(
        '{"code":"unsupported_source"}', 400)),
      wsTicketClient: WsTicketClient(
        post: (_, {required headers, required body}) async =>
            http.Response('{"ticket":"t","path":"/ws/chat"}', 200),
      ),
      channelFactory: (uri) {
        urls?.add(uri);
        final ch = _FakeChannel(
          StreamController<dynamic>.broadcast(sync: true),
          <String>[],
        );
        channels.add(ch);
        return ch;
      },
    );
    return (service, channels);
  }

  test('shell reconnect and pagination retain source while execution changes', () async {
    await setupSettings();
    fakeAsync((async) {
      final requests = <http.Request>[];
      final urls = <Uri>[];
      var active = 'task-one';
      final client = MockClient((request) async {
        requests.add(request);
        if (request.method == 'POST') return http.Response('{"id":"shell-one"}', 200);
        if (request.url.path.endsWith('/chat')) {
          return http.Response(jsonEncode({'activeSessionId': active}), 200);
        }
        return http.Response(jsonEncode({'messages': [
          {'id': 'chat one:old', 'sourceSessionId': 'chat one', 'sourceMessageId': 'old',
           'role': 'user', 'content': 'original request', 'ts': 1},
        ], 'hasMore': false}), 200);
      });
      final (service, channels) = makeService(httpClient: client, urls: urls);
      final events = <ChatEvent>[];
      service.events.listen(events.add);
      service.connect();
      async.flushMicrotasks();
      expect(urls.single.queryParameters['session'], 'task-one');
      expect(urls.single.queryParameters['shell'], 'shell-one');
      channels.last.incoming.add(jsonEncode({'type': 'chat_msg_meta', 'id': 'new', 'role': 'assistant'}));
      async.flushMicrotasks();
      expect((events.last.payload as Map)['id'], 'task-one:new');
      active = 'task-two';
      channels.last.incoming.add(jsonEncode({'type': 'task_shell_routed', 'sessionId': active}));
      async.flushMicrotasks();
      expect(urls.last.queryParameters['session'], 'task-two');
      expect(urls.last.queryParameters['shell'], 'shell-one');
      expect(requests.where((r) => r.method == 'POST'), hasLength(1));
      service.fetchHistoryPage(beforeId: 'task-one:new').then((page) {
        expect(page.messages.single.id, 'chat one:old');
      });
      async.flushMicrotasks();
      expect(requests.last.url.path, '/api/task-shells/shell-one/history');
      expect(requests.last.url.queryParameters['before'], 'task-one:new');
      channels.last.incoming.add(jsonEncode({'type': 'shell_history_update',
        'sourceSessionId': 'task-one', 'messages': [{'id': 'task-one:new', 'sourceSessionId': 'task-one'}]}));
      async.flushMicrotasks();
      expect(events.last.type, 'shell_history_update');
      expect((events.last.payload as Map)['messages'][0]['id'], 'task-one:new');
      service.dispose();
    });
  });

  test('display clear keeps streaming and relays the authoritative reset', () async {
    await setupSettings();
    fakeAsync((async) {
      final (service, channels) = makeService();
      final events = <ChatEvent>[];
      service.events.listen(events.add);
      expect(service.clearHistory(), isFalse);
      service.connect();
      async.flushMicrotasks();
      service.isStreaming = true;
      expect(service.clearHistory(keep: 2), isTrue);
      expect(jsonDecode(channels.single.sent.last), {'type': 'clear_history', 'keep': 2});
      expect(channels.single.sent.any((frame) => jsonDecode(frame)['type'] == 'cancel'), isFalse);
      expect(service.isStreaming, isTrue);
      channels.single.incoming.add(jsonEncode({
        'type': 'chat_history_reset', 'messages': [], 'hasMore': false, 'displayOnly': true,
      }));
      async.flushMicrotasks();
      expect(events.any((event) => event.type == 'chat_history_reset'), isTrue);
      expect(service.isStreaming, isTrue);
      service.dispose();
    });
  });

  group('foreground-return probe (ensureAlive)', () {
    test('probe ping with no pong reconnects after the probe window '
        '(no waiting for the 15s heartbeat)', () async {
      await setupSettings();
      fakeAsync((async) {
        final made = makeService();
        final service = made.$1;
        final channels = made.$2;
        final events = <String>[];
        service.events.listen((e) => events.add(e.type));

        service.connect();
        async.flushMicrotasks();
        expect(service.state, ChatConnectionState.connected);
        final channel = channels.single;

        // Simulate a foreground return: healthy-looking socket, no frames
        // since the OS froze it in the background.
        service.ensureAlive();
        expect(channel.sent, isNotEmpty); // probe ping was sent
        final pingCountBefore = channel.sent.length;

        // Nothing answers within the probe window.
        async.elapse(const Duration(seconds: 4));

        expect(service.state, ChatConnectionState.disconnected);
        expect(events, contains('reconnecting'));
        // A reconnect was scheduled (1s backoff), not a tear-down.
        expect(channels, hasLength(1));
        expect(channel.sent.length, pingCountBefore);

        service.dispose();
        async.flushMicrotasks();
      });
    });

    test('probe ping answered by pong keeps the socket alive', () async {
      await setupSettings();
      fakeAsync((async) {
        final made = makeService();
        final service = made.$1;
        final channels = made.$2;
        final events = <String>[];
        service.events.listen((e) => events.add(e.type));

        service.connect();
        async.flushMicrotasks();
        expect(service.state, ChatConnectionState.connected);
        final channel = channels.single;

        service.ensureAlive();
        expect(channel.sent, isNotEmpty);

        // Server answers the probe immediately.
        channel.incoming.add(jsonEncode({'type': 'pong'}));
        async.elapse(const Duration(seconds: 4));

        // Socket stays up — no reconnect, no disconnect.
        expect(service.state, ChatConnectionState.connected);
        expect(events, isNot(contains('reconnecting')));
        expect(channels, hasLength(1));

        service.dispose();
        async.flushMicrotasks();
      });
    });

    test('ensureAlive reconnects immediately, skipping the backoff wait, '
        'when already dropped', () async {
      await setupSettings();
      fakeAsync((async) {
        final made = makeService();
        final service = made.$1;
        final channels = made.$2;

        service.connect();
        async.flushMicrotasks();
        expect(service.state, ChatConnectionState.connected);

        // Drop the socket (simulates the OS killing it in the background).
        // onDone → _scheduleReconnect arms a 1s backoff timer.
        channels.single.incoming.close();
        async.flushMicrotasks();
        expect(service.state, ChatConnectionState.disconnected);

        // Foreground return while the backoff timer is still pending.
        service.ensureAlive();
        async.flushMicrotasks();
        // ensureAlive cancelled the backoff and reconnected immediately on a
        // fresh channel — not 1s later.
        expect(service.state, ChatConnectionState.connected);
        expect(channels, hasLength(2));

        service.dispose();
        async.flushMicrotasks();
      });
    });
  });

  test(
    'pre-FIFO admission progress and stream start reach the provider',
    () async {
      await setupSettings();
      fakeAsync((async) {
        final made = makeService();
        final service = made.$1;
        final channels = made.$2;
        final events = <ChatEvent>[];
        service.events.listen(events.add);
        service.connect();
        async.flushMicrotasks();

        channels.single.incoming.add(
          jsonEncode({
            'type': 'message_admission_progress',
            'state': 'waiting',
            'stage': 'memory_distill',
            'message': 'hello',
            'clientMsgId': 'app-1',
          }),
        );
        channels.single.incoming.add(jsonEncode({'type': 'stream_start'}));
        async.flushMicrotasks();

        final progress = events.singleWhere(
          (event) => event.type == 'message_admission_progress',
        );
        expect((progress.payload as Map)['clientMsgId'], 'app-1');
        expect(service.isStreaming, isTrue);
        expect(events.any((event) => event.type == 'stream_start'), isTrue);
        service.dispose();
        async.flushMicrotasks();
      });
    },
  );

  test(
    'provider-route gate filters before emit and reconnect init restores the active tuple',
    () async {
      await setupSettings();
      fakeAsync((async) {
        final made = makeService();
        final service = made.$1;
        final channels = made.$2;
        final events = <ChatEvent>[];
        service.events.listen(events.add);

        Map<String, dynamic> route(int generation, String attemptId) => {
          'type': 'provider_route_event',
          'version': 1,
          'phase': 'selected',
          'providerRouteScope': 'attempt',
          'runtimeEpoch': 'epoch-1',
          'turnId': 'turn-1',
          'decisionId': 'decision-1',
          'routeAttemptId': attemptId,
          'routeGeneration': generation,
          'attemptNo': generation,
          'providerId': 'provider-a',
          'providerRevision': 'revision-a',
        };
        Map<String, dynamic> delta(
          int generation,
          String attemptId,
          String text,
        ) => {
          ...route(generation, attemptId),
          'type': 'part_delta',
          'delta': {'type': 'text', 'text': text},
        };

        service.connect();
        async.flushMicrotasks();
        final first = channels.single;
        final active = route(2, 'attempt-2')..remove('type');
        first.incoming.add(
          jsonEncode({
            'type': 'system',
            'subtype': 'init',
            'session_id': 'session-1',
            'is_streaming': true,
            'providerRouteProtocolVersion': 1,
            'providerRoute': active,
          }),
        );
        first.incoming.add(jsonEncode(delta(2, 'attempt-2', 'accepted')));
        first.incoming.add(
          jsonEncode({...route(2, 'attempt-2'), 'phase': 'succeeded'}),
        );
        first.incoming.add(jsonEncode(delta(2, 'attempt-2', 'late')));
        first.incoming.add(
          jsonEncode({
            'type': 'error',
            'providerRouteScope': 'host',
            'error': 'host failure',
          }),
        );
        async.flushMicrotasks();

        expect(
          events
              .where((event) => event.type == 'part_delta')
              .map((event) => (event.payload as Map)['delta']['text']),
          ['accepted'],
        );
        expect(
          events
              .where((event) => event.type == 'error')
              .map((event) => event.payload),
          ['host failure'],
          reason: 'ordinary host errors are not provider-attempt frames',
        );

        first.incoming.close();
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 1));
        async.flushMicrotasks();
        expect(channels, hasLength(2));
        final second = channels.last;
        final resumed = route(4, 'attempt-4')..remove('type');
        second.incoming.add(
          jsonEncode({
            'type': 'system',
            'subtype': 'init',
            'session_id': 'session-1',
            'is_streaming': true,
            'providerRouteProtocolVersion': 1,
            'providerRoute': resumed,
          }),
        );
        second.incoming.add(jsonEncode(delta(4, 'attempt-4', 'resumed')));
        async.flushMicrotasks();
        expect(
          events
              .where((event) => event.type == 'part_delta')
              .map((event) => (event.payload as Map)['delta']['text']),
          ['accepted', 'resumed'],
        );

        service.dispose();
        async.flushMicrotasks();
      });
    },
  );
  test(
    'shell sends retain their key across reconnect and follow the routed execution',
    () async {
      await setupSettings();
      fakeAsync((async) {
        final (service, channels) = makeService();
        final events = <ChatEvent>[];
        service.events.listen(events.add);
        service.connect();
        async.flushMicrotasks();
        channels.last.incoming.add(
          jsonEncode({
            'type': 'system',
            'subtype': 'init',
            'is_streaming': false,
            'session': 'chat one',
            'taskShell': true,
            'turnId': 'turn-original',
          }),
        );
        final id = service.send('independent work');
        final original = jsonDecode(channels.last.sent.last) as Map;
        expect(original['taskShell'], isTrue);
        expect(original['clientMsgId'], id);
        expect(service.send('must not duplicate'), isNull);
        service.connect();
        async.flushMicrotasks();
        expect(jsonDecode(channels.last.sent.last), original);
        channels.last.incoming.add(
          jsonEncode({
            'type': 'task_shell_routed',
            'sessionId': 'task-fork',
            'receiptId': 'sr_one',
            'clientMsgId': id,
            'taskId': 'tsk_fork',
          }),
        );
        async.flushMicrotasks();
        expect(service.executionSessionName, 'task-fork');
        expect(events.any((e) => e.type == 'task_shell_routed'), isTrue);
        channels.last.incoming.add(
          jsonEncode({
            'type': 'system',
            'subtype': 'init',
            'is_streaming': true,
            'session': 'task-fork',
            'taskShell': true,
            'turnId': 'fork-turn',
          }),
        );
        service.cancel();
        final cancel = jsonDecode(channels.last.sent.last) as Map;
        expect(cancel['taskShell'], isTrue);
        expect(cancel['turnId'], 'fork-turn');
        service.connect();
        async.flushMicrotasks();
        expect(jsonDecode(channels.last.sent.last), cancel);
        service.dispose();
      });
    },
  );
}
