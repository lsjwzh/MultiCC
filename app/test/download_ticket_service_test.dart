import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:multicc_app/services/download_ticket_service.dart';

void main() {
  group('authenticated download request', () {
    test('keeps the access token in a header, never in the URL', () {
      final request = buildMulticcDownloadRequest(
        host: 'https://example.test:9443/',
        path: '/tmp/report one.pdf',
        accessToken: 'long-lived-token',
        inline: true,
      );

      expect(request.uri.scheme, 'https');
      expect(request.uri.port, 9443);
      expect(request.uri.path, '/api/download');
      expect(request.uri.queryParameters['path'], '/tmp/report one.pdf');
      expect(request.uri.queryParameters['inline'], '1');
      expect(request.uri.queryParameters.containsKey('token'), isFalse);
      expect(request.uri.toString(), isNot(contains('long-lived-token')));
      expect(request.headers, {'X-Access-Token': 'long-lived-token'});
    });

    test('local no-token mode omits the auth header', () {
      final request = buildMulticcDownloadRequest(
        host: '127.0.0.1:3000',
        path: '/tmp/image.png',
        accessToken: '',
        inline: true,
      );
      expect(request.uri.scheme, 'http');
      expect(request.headers, isEmpty);
    });
  });

  group('download ticket exchange', () {
    test('uses header auth and returns a scoped browser URL', () async {
      Uri? endpoint;
      Map<String, String>? sentHeaders;
      String? sentBody;
      final client = DownloadTicketClient(
        post: (uri, {required headers, required body}) async {
          endpoint = uri;
          sentHeaders = Map.of(headers);
          sentBody = body;
          return http.Response(
            jsonEncode({
              'ticket': 'short-lived-ticket',
              'target': '/api/download?path=%2Ftmp%2Freport+one.pdf&inline=1',
            }),
            200,
          );
        },
      );
      final request = buildMulticcDownloadRequest(
        host: 'https://example.test',
        path: '/tmp/report one.pdf',
        accessToken: 'normal-rest-token',
        inline: true,
      );

      final authorized = await client.authorize(
        request: request,
        ticketEndpoint: Uri.parse(
          'https://example.test/api/auth/download-ticket',
        ),
      );

      expect(endpoint?.path, '/api/auth/download-ticket');
      expect(sentHeaders?['X-Access-Token'], 'normal-rest-token');
      expect(sentHeaders?['Content-Type'], 'application/json');
      expect(jsonDecode(sentBody!)['path'], '/tmp/report one.pdf');
      expect(jsonDecode(sentBody!)['inline'], isTrue);
      expect(
        authorized.queryParameters['download_ticket'],
        'short-lived-ticket',
      );
      expect(authorized.queryParameters.containsKey('token'), isFalse);
      expect(authorized.toString(), isNot(contains('normal-rest-token')));
    });

    test('rejects a cross-origin endpoint before posting the token', () async {
      var posted = false;
      final client = DownloadTicketClient(
        post: (_, {required headers, required body}) async {
          posted = true;
          return http.Response('{}', 200);
        },
      );
      final request = buildMulticcDownloadRequest(
        host: 'https://multicc.example',
        path: '/tmp/image.png',
        accessToken: 'normal-rest-token',
      );

      await expectLater(
        client.authorize(
          request: request,
          ticketEndpoint: Uri.parse(
            'https://attacker.example/api/auth/download-ticket',
          ),
        ),
        throwsA(isA<DownloadTicketException>()),
      );
      expect(posted, isFalse);
    });

    test('rejects a ticket rebound to a different path', () async {
      final client = DownloadTicketClient(
        post: (_, {required headers, required body}) async => http.Response(
          '{"ticket":"ticket","target":"/api/download?path=%2Ftmp%2Fother.png"}',
          200,
        ),
      );
      final request = buildMulticcDownloadRequest(
        host: 'https://multicc.example',
        path: '/tmp/image.png',
        accessToken: 'normal-rest-token',
      );

      await expectLater(
        client.authorize(
          request: request,
          ticketEndpoint: Uri.parse(
            'https://multicc.example/api/auth/download-ticket',
          ),
        ),
        throwsA(
          isA<DownloadTicketException>().having(
            (error) => error.code,
            'code',
            'invalid_ticket_response',
          ),
        ),
      );
    });
  });

  test('Flutter call sites contain no legacy download token query', () {
    for (final path in [
      'lib/screens/file_browser_screen.dart',
      'lib/widgets/message_bubble.dart',
    ]) {
      final source = File(path).readAsStringSync();
      expect(source, isNot(contains("'&token=")), reason: path);
      expect(source, isNot(contains(r'token=${')), reason: path);
    }
    final browser = File(
      'lib/screens/file_browser_screen.dart',
    ).readAsStringSync();
    expect(browser, contains('DownloadTicketClient'));
    final bubble = File('lib/widgets/message_bubble.dart').readAsStringSync();
    expect(bubble, contains('headers: localRequest?.headers'));
    expect(bubble, contains('headers: widget.headers'));
  });
}
