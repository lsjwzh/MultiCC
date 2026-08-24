import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
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
  (ChatService, List<_FakeChannel>) makeService() {
    final channels = <_FakeChannel>[];
    final service = ChatService(
      settings: settings,
      sessionName: 'chat one',
      sessionCwd: '/tmp/work',
      wsTicketClient: WsTicketClient(
        post: (_, {required headers, required body}) async =>
            http.Response('{"ticket":"t","path":"/ws/chat"}', 200),
      ),
      channelFactory: (_) {
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
}
