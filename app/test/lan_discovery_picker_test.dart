import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/discovered_server.dart';
import 'package:multicc_app/services/lan_discovery_service.dart';
import 'package:multicc_app/widgets/lan_discovery_picker.dart';

class _FakeDiscoveryService implements LanDiscoveryService {
  List<DiscoveredServer> results;
  Object? error;
  int scans = 0;
  int stops = 0;

  _FakeDiscoveryService({this.results = const [], this.error});

  @override
  Future<List<DiscoveredServer>> scan({
    Duration timeout = defaultLanDiscoveryDuration,
  }) async {
    scans++;
    if (error case final value?) throw value;
    return results;
  }

  @override
  Future<void> stop() async {
    stops++;
  }
}

Widget _host({
  required LanDiscoveryService service,
  required ValueChanged<DiscoveredServer> onSelected,
}) => MaterialApp(
  home: Scaffold(
    body: SingleChildScrollView(
      child: LanDiscoveryPicker(
        discoveryService: service,
        scanDuration: Duration.zero,
        onSelected: onSelected,
      ),
    ),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  testWidgets('does not scan until the user taps discovery', (tester) async {
    final service = _FakeDiscoveryService();
    await tester.pumpWidget(_host(service: service, onSelected: (_) {}));

    expect(service.scans, 0);
    expect(find.byKey(const Key('lan-discovery-button')), findsOneWidget);
  });

  testWidgets('lists endpoints and selection only emits the chosen server', (
    tester,
  ) async {
    const server = DiscoveredServer(
      name: 'Office Mac',
      address: '192.168.1.23',
      port: 3000,
    );
    final selected = <DiscoveredServer>[];
    final service = _FakeDiscoveryService(results: const [server]);
    await tester.pumpWidget(_host(service: service, onSelected: selected.add));

    await tester.tap(find.byKey(const Key('lan-discovery-button')));
    await tester.pump();

    expect(find.text('Office Mac'), findsOneWidget);
    expect(find.text('192.168.1.23:3000'), findsOneWidget);
    expect(selected, isEmpty);

    await tester.tap(find.byKey(const Key('lan-server-192.168.1.23:3000')));
    expect(selected, const [server]);
    // The picker owns no save/connect/token callback; its sole output is the
    // selected endpoint above.
    expect(service.scans, 1);
  });

  testWidgets('empty result retains a retry action and manual-entry fallback', (
    tester,
  ) async {
    final service = _FakeDiscoveryService();
    await tester.pumpWidget(_host(service: service, onSelected: (_) {}));

    await tester.tap(find.byKey(const Key('lan-discovery-button')));
    await tester.pump();

    expect(find.byKey(const Key('lan-discovery-empty')), findsOneWidget);
    expect(find.text('重新发现'), findsOneWidget);

    await tester.tap(find.byKey(const Key('lan-discovery-button')));
    await tester.pump();
    expect(service.scans, 2);
  });

  testWidgets('permission error can be retried after access is restored', (
    tester,
  ) async {
    const server = DiscoveredServer(
      name: 'Office Mac',
      address: '192.168.1.23',
      port: 3000,
    );
    final service = _FakeDiscoveryService(
      error: const LanDiscoveryException(LanDiscoveryFailure.permissionDenied),
    );
    await tester.pumpWidget(_host(service: service, onSelected: (_) {}));

    await tester.tap(find.byKey(const Key('lan-discovery-button')));
    await tester.pump();
    expect(find.byKey(const Key('lan-discovery-error')), findsOneWidget);

    service
      ..error = null
      ..results = const [server];
    await tester.tap(find.byKey(const Key('lan-discovery-button')));
    await tester.pump();
    expect(find.text('Office Mac'), findsOneWidget);
    expect(service.scans, 2);
  });

  testWidgets('disposing the picker stops any native discovery', (
    tester,
  ) async {
    final service = _FakeDiscoveryService();
    await tester.pumpWidget(_host(service: service, onSelected: (_) {}));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();

    expect(service.stops, 1);
  });
}
