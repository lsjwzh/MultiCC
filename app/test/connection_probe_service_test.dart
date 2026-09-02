import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/connection_probe_service.dart';

http.Response _json(int status, Map<String, dynamic> body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

void main() {
  test(
    'verifies identity, token, readiness, and returns canonical host',
    () async {
      final calls = <Uri>[];
      final client = MockClient((request) async {
        calls.add(request.url);
        expect(request.headers['X-Access-Token'], 'secret');
        if (request.url.path == '/api/server-info') {
          return _json(200, {
            'product': 'multicc',
            'appProtocolVersion': 1,
            'version': '1.6.7',
          });
        }
        return _json(200, {'status': 'ready'});
      });

      final result = await ConnectionProbeService(
        client: client,
      ).probe(host: '192.168.1.8:3000/', token: ' secret ');

      expect(result.ok, isTrue);
      expect(result.normalizedHost, 'http://192.168.1.8:3000');
      expect(result.serverVersion, '1.6.7');
      expect(result.insecureLan, isTrue);
      expect(calls.map((uri) => uri.path), ['/api/server-info', '/readyz']);
    },
  );

  test('rejects wrong credentials without probing readiness', () async {
    var calls = 0;
    final client = MockClient((_) async {
      calls++;
      return _json(403, {'error': 'Forbidden'});
    });
    final result = await ConnectionProbeService(
      client: client,
    ).probe(host: 'http://10.0.0.8:3000', token: 'wrong');
    expect(result.failure, ConnectionProbeFailure.authentication);
    expect(calls, 1);
  });

  test('rejects a reachable non-MultiCC endpoint', () async {
    final client = MockClient((_) async => _json(200, {'status': 'ok'}));
    final result = await ConnectionProbeService(
      client: client,
    ).probe(host: 'http://10.0.0.8:3000', token: '');
    expect(result.failure, ConnectionProbeFailure.notMulticc);
  });

  test('rejects incompatible native protocol before saving', () async {
    final client = MockClient(
      (_) async => _json(200, {'product': 'multicc', 'appProtocolVersion': 2}),
    );
    final result = await ConnectionProbeService(
      client: client,
    ).probe(host: 'https://multicc.example.com', token: '');
    expect(result.failure, ConnectionProbeFailure.incompatible);
  });

  test(
    'allows plain HTTP only for local, private, and tailnet hosts',
    () async {
      for (final host in ['http://example.com:3000', 'http://8.8.8.8:3000']) {
        final result = await ConnectionProbeService(
          client: MockClient((_) async => throw StateError('must not fetch')),
        ).probe(host: host, token: '');
        expect(result.failure, ConnectionProbeFailure.insecureAddress);
      }
    },
  );

  test('separates a booting host from a network failure', () async {
    final client = MockClient((request) async {
      if (request.url.path == '/api/server-info') {
        return _json(200, {'product': 'multicc', 'appProtocolVersion': 1});
      }
      return _json(503, {'status': 'not_ready'});
    });
    final result = await ConnectionProbeService(
      client: client,
    ).probe(host: 'http://multicc.local:3000', token: '');
    expect(result.failure, ConnectionProbeFailure.notReady);
  });
}
