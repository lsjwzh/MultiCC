import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/ws_ticket_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('credential-free WebSocket URI', () {
    test('encodes business query values without credentials', () {
      final uri = buildMulticcWebSocketUri(
        host: 'https://example.test:9443/',
        path: MulticcWsPath.chat,
        query: const {
          'session': '会话 & one',
          'cwd': '/tmp/a b',
          'resume': 'r?1',
        },
      );

      expect(uri.scheme, 'wss');
      expect(uri.host, 'example.test');
      expect(uri.port, 9443);
      expect(uri.path, '/ws/chat');
      expect(uri.queryParameters['session'], '会话 & one');
      expect(uri.queryParameters['cwd'], '/tmp/a b');
      expect(uri.queryParameters['resume'], 'r?1');
      expect(uri.queryParameters.containsKey('token'), isFalse);
      expect(uri.queryParameters.containsKey('ticket'), isFalse);
    });

    test(
      'rejects credentials and non-origin hosts at the builder boundary',
      () {
        expect(
          () => buildMulticcWebSocketUri(
            host: 'https://example.test',
            path: '/ws/chat',
            query: const {'token': 'long-lived'},
          ),
          throwsFormatException,
        );
        expect(
          () => buildMulticcWebSocketUri(
            host: 'https://user:pass@example.test',
            path: '/ws/chat',
          ),
          throwsFormatException,
        );
      },
    );
  });

  group('ticket exchange', () {
    test('uses REST header auth and binds the exact socket path', () async {
      Uri? endpoint;
      Map<String, String>? sentHeaders;
      String? sentBody;
      final client = WsTicketClient(
        post: (uri, {required headers, required body}) async {
          endpoint = uri;
          sentHeaders = Map.of(headers);
          sentBody = body;
          return http.Response(
            jsonEncode({
              'ticket': 'short-lived-ticket',
              'path': '/ws/workspace',
            }),
            200,
          );
        },
      );

      final authorized = await client.authorize(
        socketUri: Uri.parse(
          'wss://example.test/ws/workspace?dirId=fleet%20one&token=legacy&ticket=old',
        ),
        ticketEndpoint: Uri.parse('https://example.test/api/auth/ws-ticket'),
        accessToken: 'normal-rest-token',
      );

      expect(endpoint.toString(), 'https://example.test/api/auth/ws-ticket');
      expect(sentHeaders?['Content-Type'], 'application/json');
      expect(sentHeaders?['X-Access-Token'], 'normal-rest-token');
      expect(jsonDecode(sentBody!)['path'], '/ws/workspace');
      expect(authorized.queryParameters['dirId'], 'fleet one');
      expect(authorized.queryParameters['ticket'], 'short-lived-ticket');
      expect(authorized.queryParameters.containsKey('token'), isFalse);
    });

    test(
      'local/no-token mode omits the header but still gets a fresh ticket',
      () async {
        var calls = 0;
        final client = WsTicketClient(
          post: (uri, {required headers, required body}) async {
            calls++;
            expect(uri.host, '127.0.0.1');
            expect(headers.containsKey('X-Access-Token'), isFalse);
            expect(jsonDecode(body)['path'], MulticcWsPath.aux);
            return http.Response(
              jsonEncode({'ticket': 'local-$calls', 'path': MulticcWsPath.aux}),
              200,
            );
          },
        );
        final socket = buildMulticcWebSocketUri(
          host: '127.0.0.1:3000',
          path: MulticcWsPath.aux,
        );
        final endpoint = Uri.parse('http://127.0.0.1:3000/api/auth/ws-ticket');

        final first = await client.authorize(
          socketUri: socket,
          ticketEndpoint: endpoint,
          accessToken: '',
        );
        final second = await client.authorize(
          socketUri: socket,
          ticketEndpoint: endpoint,
          accessToken: '',
        );

        expect(calls, 2);
        expect(first.queryParameters['ticket'], 'local-1');
        expect(second.queryParameters['ticket'], 'local-2');
      },
    );

    test('rejects wrong-path and malformed responses', () async {
      final wrongPath = WsTicketClient(
        post: (_, {required headers, required body}) async =>
            http.Response(jsonEncode({'ticket': 't', 'path': '/ws/chat'}), 200),
      );
      final malformed = WsTicketClient(
        post: (_, {required headers, required body}) async =>
            http.Response('not-json', 200),
      );
      final socket = Uri.parse('wss://example.test/ws/tts');
      final endpoint = Uri.parse('https://example.test/api/auth/ws-ticket');

      await expectLater(
        wrongPath.authorize(
          socketUri: socket,
          ticketEndpoint: endpoint,
          accessToken: '',
        ),
        throwsA(
          isA<WsTicketException>().having(
            (error) => error.code,
            'code',
            'invalid_ticket_response',
          ),
        ),
      );
      await expectLater(
        malformed.authorize(
          socketUri: socket,
          ticketEndpoint: endpoint,
          accessToken: '',
        ),
        throwsA(isA<WsTicketException>()),
      );
    });

    test('never posts the REST token across origins', () async {
      var posted = false;
      final client = WsTicketClient(
        post: (_, {required headers, required body}) async {
          posted = true;
          return http.Response('{}', 200);
        },
      );

      await expectLater(
        client.authorize(
          socketUri: Uri.parse('wss://multicc.example/ws/chat'),
          ticketEndpoint: Uri.parse(
            'https://attacker.example/api/auth/ws-ticket',
          ),
          accessToken: 'normal-rest-token',
        ),
        throwsA(
          isA<WsTicketException>().having(
            (error) => error.code,
            'code',
            'invalid_ticket_endpoint',
          ),
        ),
      );
      expect(posted, isFalse);
    });

    test(
      'error text never includes response bodies, token or ticket',
      () async {
        final client = WsTicketClient(
          post: (_, {required headers, required body}) async => http.Response(
            '{"error":"normal-rest-token short-lived-ticket"}',
            403,
          ),
        );

        Object? failure;
        try {
          await client.authorize(
            socketUri: Uri.parse('wss://example.test/ws/chat'),
            ticketEndpoint: Uri.parse(
              'https://example.test/api/auth/ws-ticket',
            ),
            accessToken: 'normal-rest-token',
          );
        } catch (error) {
          failure = error;
        }

        expect(failure, isA<WsTicketException>());
        expect('$failure', contains('ticket_http_error'));
        expect('$failure', isNot(contains('normal-rest-token')));
        expect('$failure', isNot(contains('short-lived-ticket')));
      },
    );
  });

  group('connect generation gate', () {
    test('late first ticket cannot supersede a newer reconnect', () async {
      final responses = <Completer<http.Response>>[];
      final client = WsTicketClient(
        post: (_, {required headers, required body}) {
          final response = Completer<http.Response>();
          responses.add(response);
          return response.future;
        },
      );
      final gate = WsTicketConnectionGate(client);
      final socket = Uri.parse('wss://example.test/ws/chat?session=one');
      final endpoint = Uri.parse('https://example.test/api/auth/ws-ticket');

      final first = gate.begin(
        socketUri: socket,
        ticketEndpoint: endpoint,
        accessToken: 'rest-token',
      );
      final second = gate.begin(
        socketUri: socket,
        ticketEndpoint: endpoint,
        accessToken: 'rest-token',
      );
      expect(responses, hasLength(2));

      responses[1].complete(
        http.Response('{"ticket":"new","path":"/ws/chat"}', 200),
      );
      expect((await second.authorizedUri).queryParameters['ticket'], 'new');
      expect(second.isCurrent, isTrue);

      responses[0].complete(
        http.Response('{"ticket":"old","path":"/ws/chat"}', 200),
      );
      expect((await first.authorizedUri).queryParameters['ticket'], 'old');
      expect(first.isCurrent, isFalse);
      expect(second.isCurrent, isTrue);
    });

    test('cancel/dispose invalidates an outstanding ticket response', () async {
      final response = Completer<http.Response>();
      final gate = WsTicketConnectionGate(
        WsTicketClient(
          post: (_, {required headers, required body}) => response.future,
        ),
      );
      final attempt = gate.begin(
        socketUri: Uri.parse('wss://example.test/ws/tts'),
        ticketEndpoint: Uri.parse('https://example.test/api/auth/ws-ticket'),
        accessToken: 'rest-token',
      );
      gate.invalidate();
      response.complete(
        http.Response('{"ticket":"late","path":"/ws/tts"}', 200),
      );

      await attempt.authorizedUri;
      expect(attempt.isCurrent, isFalse);
    });

    test(
      'Chat reconnect ignores a stale ticket before opening a socket',
      () async {
        SharedPreferences.setMockInitialValues({});
        final settings = await SettingsService.getInstance();
        await settings.save(
          host: 'https://example.test',
          token: 'normal-rest-token',
        );

        final responses = <Completer<http.Response>>[];
        final opened = <Uri>[];
        final service = ChatService(
          settings: settings,
          sessionName: 'chat one',
          sessionCwd: '/tmp/work',
          wsTicketClient: WsTicketClient(
            post: (_, {required headers, required body}) {
              final response = Completer<http.Response>();
              responses.add(response);
              return response.future;
            },
          ),
          channelFactory: (uri) {
            opened.add(uri);
            throw StateError('test stops before transport creation');
          },
        );

        service.connect();
        service.connect();
        expect(responses, hasLength(2));

        responses[0].complete(
          http.Response('{"ticket":"stale","path":"/ws/chat"}', 200),
        );
        await Future<void>.delayed(Duration.zero);
        expect(opened, isEmpty);

        responses[1].complete(
          http.Response('{"ticket":"current","path":"/ws/chat"}', 200),
        );
        await Future<void>.delayed(Duration.zero);
        expect(opened, hasLength(1));
        expect(opened.single.queryParameters['ticket'], 'current');
        expect(opened.single.queryParameters.containsKey('token'), isFalse);

        service.dispose();
      },
    );
  });

  test('all Flutter socket transports use the ticket gate', () {
    const files = [
      'lib/services/chat_service.dart',
      'lib/services/workspace_service.dart',
      'lib/services/terminal_service.dart',
      'lib/services/voice_call_service.dart',
    ];
    for (final path in files) {
      final source = File(path).readAsStringSync();
      expect(source, contains('WsTicketConnectionGate'), reason: path);
      expect(source, contains('.begin('), reason: path);
      expect(source, isNot(contains("params['token']")), reason: path);
      expect(source, isNot(contains("'?token=")), reason: path);
      expect(source, isNot(contains('settings.token)}')), reason: path);
    }
  });
}
