import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/screens/remote_screen_screen.dart';
import 'package:multicc_app/services/remote_screen_service.dart';
import 'package:multicc_app/services/remote_screen_region.dart';
import 'package:multicc_app/services/remote_screen_source.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Source with ScreenInputMixin implements ScreenSource {
  final events = <List<int>>[];
  @override
  int get width => 400;
  @override
  int get height => 300;
  @override
  Uint8List framebuffer = Uint8List(400 * 300 * 4);
  @override
  void sendInput(Uint8List bytes) => events.add(bytes.toList());
}

class _Service extends RemoteScreenService {
  _Service(SettingsService settings, {this.fallback = false})
    : super(settings: settings);
  final bool fallback;
  final requests = <Map<String, dynamic>>[];
  final input = _Source();
  final frames = StreamController<void>.broadcast();
  @override
  ScreenSource? get source => fallback ? null : input;
  @override
  Stream<void> get onFrame => frames.stream;
  @override
  Future<bool?> supportsRemoteScreen() async => true;
  @override
  Future<Map<String, dynamic>> agentPermissions() async => {
    'ok': true,
    'applicable': true,
    'accessibility': true,
    'screenRecording': true,
  };
  @override
  Future<Map<String, dynamic>> wakeScreen({bool request = false}) async => {};
  @override
  Future<Map<String, dynamic>> inputOp(Map<String, dynamic> body) async {
    requests.add(body);
    return {'ok': true};
  }

  @override
  void connectLive() {
    mode = fallback ? RemoteScreenMode.fallback : RemoteScreenMode.live;
    if (fallback) {
      fallbackWidth = 1000;
      fallbackHeight = 700;
      viewRegion = const ScreenRegion(200, 100, 400, 300);
      fallbackJpeg = base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
      );
    }
    frames.add(null);
  }

  @override
  void dispose() {
    unawaited(frames.close());
    super.dispose();
  }
}

Future<_Service> _openLive(WidgetTester tester, {bool trackpad = false}) async {
  SharedPreferences.setMockInitialValues({'remote_screen_trackpad': trackpad});
  final settings = await SettingsService.getInstance();
  final service = _Service(settings);
  await tester.pumpWidget(
    MaterialApp(
      home: RemoteScreenScreen(
        settings: settings,
        service: service,
        initialControl: true,
      ),
    ),
  );
  await tester.pump();
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 30)),
  );
  await tester.pump();
  return service;
}

void main() {
  testWidgets(
    'JPEG crop drag sends logical input continuously before finger lift',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final settings = await SettingsService.getInstance();
      final service = _Service(settings, fallback: true);
      await tester.pumpWidget(
        MaterialApp(
          home: RemoteScreenScreen(
            settings: settings,
            service: service,
            initialControl: true,
          ),
        ),
      );
      await tester.pump();
      final stage = find.byType(InteractiveViewer);
      final gesture = await tester.startGesture(tester.getCenter(stage));
      await gesture.moveBy(const Offset(30, 0));
      await tester.pump(const Duration(milliseconds: 16));
      final held = service.requests
          .where((r) => r['op'] == 'pointer' && r['mask'] == 1)
          .toList();
      expect(held.length, greaterThanOrEqualTo(2));
      expect(held.first['x'], closeTo(400, 1));
      expect(held.first['y'], closeTo(250, 1));
      expect(held.last['x'], greaterThan(held.first['x'] as int));
      await gesture.up();
      await tester.pump();
      expect(service.requests.last['mask'], 0);
      expect(service.requests.where((r) => r['op'] == 'drag'), isEmpty);
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    },
  );

  testWidgets(
    'single-finger remote drag keeps zoom fixed; pinch takes over until all fingers lift',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final settings = await SettingsService.getInstance();
      final service = _Service(settings);
      await tester.pumpWidget(
        MaterialApp(
          home: RemoteScreenScreen(
            settings: settings,
            service: service,
            initialControl: true,
          ),
        ),
      );
      await tester.pump();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pump();
      final stage = find.byType(InteractiveViewer);
      expect(stage, findsOneWidget);
      final center = tester.getCenter(stage);
      final transform = tester
          .widget<InteractiveViewer>(stage)
          .transformationController!;
      transform.value = Matrix4.identity()..scale(2.0);
      await tester.pump();
      final before = transform.value.clone();
      final first = await tester.startGesture(
        center - const Offset(60, 0),
        pointer: 1,
      );
      await first.moveBy(const Offset(25, 0));
      await tester.pump(const Duration(milliseconds: 16));
      expect(
        service.input.events.where((e) => e[0] == 5 && e[1] == 1).length,
        greaterThanOrEqualTo(2),
      );
      expect(transform.value, before);

      final second = await tester.startGesture(
        center + const Offset(60, 0),
        pointer: 2,
      );
      expect(service.input.events.last[1], 0);
      final count = service.input.events.length;
      await first.moveBy(const Offset(-25, 0));
      await second.moveBy(const Offset(35, 0));
      await tester.pump();
      await second.up();
      await first.moveBy(const Offset(20, 0));
      await first.up();
      await tester.pump();
      expect(service.input.events.length, count);
      expect(transform.value.getMaxScaleOnAxis(), greaterThan(2.0));
      // The pinch has now enabled local panning in InteractiveViewer. A new
      // single-finger drag must still operate the remote without panning it.
      final afterPinch = transform.value.clone();
      service.input.events.clear();
      final next = await tester.startGesture(center, pointer: 3);
      await next.moveBy(const Offset(30, 0));
      await tester.pump(const Duration(milliseconds: 16));
      expect(transform.value, afterPinch);
      expect(
        service.input.events.where((e) => e[0] == 5 && e[1] == 1),
        isNotEmpty,
      );
      await next.up();
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    },
  );

  testWidgets(
    'trackpad swipe at 100% keeps the view centred and moves the cursor',
    (tester) async {
      final service = await _openLive(tester, trackpad: true);
      final stage = find.byType(InteractiveViewer);
      final transform = tester
          .widget<InteractiveViewer>(stage)
          .transformationController!;
      final g = await tester.startGesture(tester.getCenter(stage));
      for (var i = 0; i < 5; i++) {
        await g.moveBy(const Offset(10, 4));
        await tester.pump(const Duration(milliseconds: 16));
      }
      await g.up();
      await tester.pumpAndSettle();
      // The content fills the width exactly: the clamp used to throw on -0.0.
      expect(tester.takeException(), isNull);
      expect(transform.value, Matrix4.identity());
      final hovers = service.input.events.where((e) => e[0] == 5 && e[1] == 0);
      expect(hovers.length, greaterThanOrEqualTo(3));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    },
  );

  testWidgets(
    'a view moved outside the gesture callbacks is re-centred at 100%',
    (tester) async {
      await _openLive(tester);
      final transform = tester
          .widget<InteractiveViewer>(find.byType(InteractiveViewer))
          .transformationController!;
      // What InteractiveViewer's post-release inertia does: write the matrix directly.
      transform.value = Matrix4.translationValues(31, 68, 0);
      await tester.pump();
      expect(transform.value, Matrix4.identity());
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    },
  );

  testWidgets(
    'a fast single-finger remote drag on a zoomed view does not fling it',
    (tester) async {
      final service = await _openLive(tester);
      final stage = find.byType(InteractiveViewer);
      final transform = tester
          .widget<InteractiveViewer>(stage)
          .transformationController!;
      // Zoom with a real pinch, the way a user gets into the zoomed state.
      final center = tester.getCenter(stage);
      final a = await tester.startGesture(
        center - const Offset(20, 0),
        pointer: 7,
      );
      final b = await tester.startGesture(
        center + const Offset(20, 0),
        pointer: 8,
      );
      for (var i = 0; i < 6; i++) {
        await a.moveBy(const Offset(-10, 0));
        await b.moveBy(const Offset(10, 0));
        await tester.pump(const Duration(milliseconds: 16));
      }
      await tester.pump(const Duration(milliseconds: 200));
      await a.up();
      await b.up();
      await tester.pumpAndSettle();
      expect(transform.value.getMaxScaleOnAxis(), greaterThan(1.5));
      service.input.events.clear();
      final before = transform.value.clone();
      await tester.flingFrom(
        tester.getCenter(stage),
        const Offset(-120, 0),
        2000,
      );
      await tester.pumpAndSettle();
      expect(transform.value, before);
      expect(
        service.input.events.where((e) => e[0] == 5 && e[1] == 1),
        isNotEmpty,
      );
      expect(service.input.events.last[1], 0);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    },
  );
}
