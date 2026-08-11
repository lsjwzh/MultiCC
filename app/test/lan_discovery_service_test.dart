import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nsd/nsd.dart' as nsd;

import 'package:multicc_app/models/discovered_server.dart';
import 'package:multicc_app/services/lan_discovery_service.dart';

void main() {
  test('discovered endpoint formats IPv4 and IPv6 URLs', () {
    const ipv4 = DiscoveredServer(
      name: 'Office Mac',
      address: '192.168.1.23',
      port: 3000,
    );
    const ipv6 = DiscoveredServer(
      name: 'Office Mac',
      address: 'fd00::23',
      port: 3000,
    );

    expect(ipv4.httpUrl, 'http://192.168.1.23:3000');
    expect(ipv4.endpointLabel, '192.168.1.23:3000');
    expect(ipv6.httpUrl, 'http://[fd00::23]:3000');
    expect(ipv6.endpointLabel, '[fd00::23]:3000');
  });

  test(
    'scan uses MultiCC DNS-SD, resolves IPs, de-duplicates, and stops',
    () async {
      late String requestedType;
      late bool requestedAutoResolve;
      late nsd.IpLookupType requestedLookupType;
      var stopCount = 0;
      final discovery = nsd.Discovery('test-discovery');
      discovery.add(
        nsd.Service(
          name: 'Office Mac',
          type: multiccServiceType,
          port: 3000,
          addresses: [
            InternetAddress('fd00::23'),
            InternetAddress('100.118.172.84'),
            InternetAddress('192.168.1.23'),
          ],
        ),
      );
      // A repeated answer for the same endpoint must not add another row.
      discovery.add(
        nsd.Service(
          name: 'Office Mac',
          type: multiccServiceType,
          port: 3000,
          addresses: [InternetAddress('192.168.1.23')],
        ),
      );
      // Loopback and malformed records are not useful LAN endpoints.
      discovery.add(
        nsd.Service(
          name: 'Local only',
          type: multiccServiceType,
          port: 3000,
          addresses: [InternetAddress.loopbackIPv4],
        ),
      );
      discovery.add(
        const nsd.Service(name: 'Missing port', type: multiccServiceType),
      );

      final service = NsdLanDiscoveryService(
        startDiscovery:
            (
              type, {
              autoResolve = true,
              ipLookupType = nsd.IpLookupType.none,
            }) async {
              requestedType = type;
              requestedAutoResolve = autoResolve;
              requestedLookupType = ipLookupType;
              return discovery;
            },
        stopDiscovery: (_) async => stopCount++,
      );

      final results = await service.scan(timeout: Duration.zero);

      expect(requestedType, multiccServiceType);
      expect(requestedAutoResolve, isTrue);
      expect(requestedLookupType, nsd.IpLookupType.any);
      // One DNS-SD service becomes one row. RFC1918 Wi-Fi wins over a
      // Tailscale address and IPv6 alternatives returned by the same record.
      expect(results.map((server) => server.endpointLabel), [
        '192.168.1.23:3000',
      ]);
      expect(stopCount, 1);
    },
  );

  test(
    'filters link-local addresses and keeps IPv6 as a valid fallback',
    () async {
      final discovery = nsd.Discovery('ipv6-fallback');
      discovery.add(
        nsd.Service(
          name: 'IPv6 Mac',
          type: multiccServiceType,
          port: 3000,
          addresses: [InternetAddress('fe80::23'), InternetAddress('fd00::23')],
        ),
      );
      final service = NsdLanDiscoveryService(
        startDiscovery:
            (
              _, {
              autoResolve = true,
              ipLookupType = nsd.IpLookupType.none,
            }) async => discovery,
        stopDiscovery: (_) async {},
      );

      final results = await service.scan(timeout: Duration.zero);

      expect(results.single.endpointLabel, '[fd00::23]:3000');
    },
  );

  test(
    'numeric resolved host is a fallback when address list is absent',
    () async {
      final discovery = nsd.Discovery('numeric-host');
      discovery.add(
        const nsd.Service(
          name: 'Living Room Mac',
          type: multiccServiceType,
          host: '10.0.0.8',
          port: 3456,
        ),
      );
      final service = NsdLanDiscoveryService(
        startDiscovery:
            (
              _, {
              autoResolve = true,
              ipLookupType = nsd.IpLookupType.none,
            }) async => discovery,
        stopDiscovery: (_) async {},
      );

      final results = await service.scan(timeout: Duration.zero);

      expect(results.single.httpUrl, 'http://10.0.0.8:3456');
    },
  );

  test('security errors become retryable permission failures', () async {
    final service = NsdLanDiscoveryService(
      startDiscovery:
          (
            _, {
            autoResolve = true,
            ipLookupType = nsd.IpLookupType.none,
          }) async => throw nsd.NsdError(
            nsd.ErrorCause.securityIssue,
            'permission denied',
          ),
      stopDiscovery: (_) async {},
    );

    await expectLater(
      service.scan(timeout: Duration.zero),
      throwsA(
        isA<LanDiscoveryException>().having(
          (error) => error.failure,
          'failure',
          LanDiscoveryFailure.permissionDenied,
        ),
      ),
    );
  });

  test('explicit stop ends an active bounded scan and releases once', () async {
    final discovery = nsd.Discovery('active');
    final started = Completer<void>();
    var stopCount = 0;
    final service = NsdLanDiscoveryService(
      startDiscovery:
          (
            _, {
            autoResolve = true,
            ipLookupType = nsd.IpLookupType.none,
          }) async {
            started.complete();
            return discovery;
          },
      stopDiscovery: (_) async => stopCount++,
    );

    final scan = service.scan(timeout: const Duration(minutes: 1));
    await started.future;
    // Let scan store the returned native handle before stopping it.
    await Future<void>.delayed(Duration.zero);
    await service.stop();

    expect(await scan, isEmpty);
    expect(stopCount, 1);
  });
}
