import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/remote_screen_screen.dart';
import 'package:multicc_app/services/remote_screen_service.dart';
import 'package:multicc_app/services/remote_screen_region.dart';
import 'package:multicc_app/services/remote_screen_source.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Source with ScreenInputMixin implements ScreenSource {
  _Source([this.width = 400, this.height = 300])
    : framebuffer = Uint8List(width * height * 4);
  final events = <List<int>>[];
  @override
  final int width;
  @override
  final int height;
  @override
  Uint8List framebuffer;
  @override
  void sendInput(Uint8List bytes) => events.add(bytes.toList());
}

class _Service extends RemoteScreenService {
  _Service(
    SettingsService settings, {
    this.fallback = false,
    int width = 400,
    int height = 300,
  }) : input = _Source(width, height),
       super(settings: settings);
  final bool fallback;
  final requests = <Map<String, dynamic>>[];
  final _Source input;
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

Future<_Service> _openLive(
  WidgetTester tester, {
  bool trackpad = false,
  int width = 400,
  int height = 300,
}) async {
  SharedPreferences.setMockInitialValues({'remote_screen_trackpad': trackpad});
  final settings = await SettingsService.getInstance();
  final service = _Service(settings, width: width, height: height);
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
  // The status bar strings come from the dictionary; without it only keys show.
  setUpAll(() => I18n.init('zh'));

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

  // A frozen picture used to keep showing its last fps reading, which read as
  // "my taps are not getting through" while they were. The status bar now says
  // how old the picture is.
  final frameAge = RegExp(r'(最近一帧|Last frame) (\d+)');
  String? ageShown(WidgetTester tester) {
    for (final w in tester.widgetList<Text>(find.byType(Text))) {
      final m = frameAge.firstMatch(w.data ?? '');
      if (m != null) return m.group(2);
    }
    return null;
  }

  testWidgets(
    'a still picture reports its age after 10s; a new frame clears it',
    (tester) async {
      final service = await _openLive(tester);
      await tester.pump(const Duration(seconds: 9));
      expect(
        ageShown(tester),
        isNull,
        reason: 'healthy still screens stay quiet',
      );
      await tester.pump(const Duration(seconds: 1));
      expect(ageShown(tester), '10');
      service.frames.add(null);
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pump();
      expect(ageShown(tester), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    },
  );

  testWidgets('input with no new frame flags the picture after 5s, in amber', (
    tester,
  ) async {
    await _openLive(tester);
    final stage = find.byType(InteractiveViewer);
    await tester.tap(stage);
    await tester.pump(const Duration(seconds: 4));
    expect(ageShown(tester), isNull);
    await tester.pump(const Duration(seconds: 1));
    expect(ageShown(tester), '5');
    final status = tester
        .widgetList<Text>(find.byType(Text))
        .firstWhere((w) => frameAge.hasMatch(w.data ?? ''));
    expect(status.style?.color, const Color(0xFFe0b45a));
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  // The geometry matrix: every combination a real phone can be in. A tap must
  // reach the remote as press + release at the source pixel under the finger,
  // and nothing may throw or push the picture out of the viewport. The -0.0
  // clamp bug only existed when the picture exactly fills one axis — true on
  // a portrait phone, never in the default 800×600 test window.
  const viewports = <String, (Size, double)>{
    'iPhone portrait': (Size(393, 852), 3),
    'iPhone landscape': (Size(852, 393), 3),
    'Android portrait': (Size(360, 780), 3),
    'iPad portrait': (Size(1024, 1366), 2),
  };
  const sources = <String, (int, int)>{
    'H.264 decoded 1280×832': (1280, 832),
    'RFB logical 1470×956': (1470, 956),
  };
  for (final vp in viewports.entries) {
    for (final src in sources.entries) {
      for (final trackpad in [false, true]) {
        for (final zoom in [1.0, 2.0]) {
          final name =
              '${vp.key} · ${src.key} · ${trackpad ? 'trackpad' : 'touch'} · ${zoom}x';
          testWidgets('geometry matrix: $name', (tester) async {
            tester.view.physicalSize = vp.value.$1 * vp.value.$2;
            tester.view.devicePixelRatio = vp.value.$2;
            addTearDown(tester.view.reset);
            await _geometryCase(
              tester,
              srcW: src.value.$1,
              srcH: src.value.$2,
              trackpad: trackpad,
              zoom: zoom,
            );
          });
        }
      }
    }
  }
}

List<(int, int, int)> _pointers(_Source s) => [
  for (final e in s.events)
    if (e[0] == 5) (e[1], (e[2] << 8) | e[3], (e[4] << 8) | e[5]),
];

Future<void> _geometryCase(
  WidgetTester tester, {
  required int srcW,
  required int srcH,
  required bool trackpad,
  required double zoom,
}) async {
  final service = await _openLive(
    tester,
    trackpad: trackpad,
    width: srcW,
    height: srcH,
  );
  final stage = find.byType(InteractiveViewer);
  expect(stage, findsOneWidget, reason: 'the live picture must be on screen');
  final transform = tester
      .widget<InteractiveViewer>(stage)
      .transformationController!;
  final vp = tester.getSize(stage);
  final origin = tester.getTopLeft(stage);
  // Same fit as _stage(): contain, centred by _zoomStage.
  final scale = vp.width / srcW < vp.height / srcH
      ? vp.width / srcW
      : vp.height / srcH;
  final dw = srcW * scale, dh = srcH * scale;
  final offX = (vp.width - dw) / 2, offY = (vp.height - dh) / 2;

  void expectInBounds(String when) {
    final m = transform.value;
    final s = m.getMaxScaleOnAxis();
    final left = m.entry(0, 3) + s * offX, top = m.entry(1, 3) + s * offY;
    final w = s * dw, h = s * dh;
    for (final (pos, len, vlen, axis) in [
      (left, w, vp.width, 'x'),
      (top, h, vp.height, 'y'),
    ]) {
      if (len <= vlen + 0.5) {
        expect(
          pos,
          closeTo((vlen - len) / 2, 0.5),
          reason: '$when: $axis centred',
        );
      } else {
        expect(
          pos,
          lessThanOrEqualTo(0.5),
          reason: '$when: $axis covers start',
        );
        expect(
          pos + len,
          greaterThanOrEqualTo(vlen - 0.5),
          reason: '$when: $axis covers end',
        );
      }
    }
  }

  if (zoom != 1.0) {
    transform.value = Matrix4.identity()
      ..translate(vp.width / 2 * (1 - zoom), vp.height / 2 * (1 - zoom))
      ..scale(zoom);
    await tester.pump();
    expect(transform.value.getMaxScaleOnAxis(), closeTo(zoom, 1e-9));
  }
  expectInBounds('before input');

  // An off-centre point inside the visible part of the picture: the centre
  // maps to the centre under any uniform scale and would hide mapping bugs.
  final m = transform.value;
  final picture = MatrixUtils.transformRect(
    m,
    Rect.fromLTWH(offX, offY, dw, dh),
  ).intersect(Offset.zero & vp);
  final point =
      picture.topLeft + Offset(picture.width * 0.7, picture.height * 0.35);
  final content = MatrixUtils.transformPoint(Matrix4.inverted(m), point);
  final expectX = (content.dx - offX) / dw * srcW;
  final expectY = (content.dy - offY) / dh * srcH;

  service.input.events.clear();
  final tap = await tester.startGesture(origin + point);
  await tester.pump(const Duration(milliseconds: 60));
  await tap.up();
  await tester.pump(const Duration(milliseconds: 600));
  expect(tester.takeException(), isNull);
  final tapped = _pointers(service.input);
  final press = tapped.indexWhere((p) => p.$1 == 1);
  expect(
    press,
    isNot(-1),
    reason: 'a tap must press the remote button: $tapped',
  );
  final release = tapped.indexWhere((p) => p.$1 == 0, press);
  expect(release, isNot(-1), reason: 'the press must be released: $tapped');
  final (_, px, py) = tapped[press];
  expect((tapped[release].$2, tapped[release].$3), (px, py));
  expect(px, inInclusiveRange(0, srcW - 1));
  expect(py, inInclusiveRange(0, srcH - 1));
  if (!trackpad) {
    // Touch mode: the click lands exactly where the finger was.
    expect(px, closeTo(expectX, 1.01));
    expect(py, closeTo(expectY, 1.01));
  }
  expect(transform.value, m, reason: 'a tap must not move the view');

  service.input.events.clear();
  final swipe = await tester.startGesture(origin + point - const Offset(40, 0));
  for (var i = 0; i < 6; i++) {
    await swipe.moveBy(const Offset(12, 3));
    await tester.pump(const Duration(milliseconds: 16));
  }
  await swipe.up();
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
  final moved = _pointers(service.input);
  expect(
    moved.length,
    greaterThanOrEqualTo(3),
    reason: 'a swipe must stream motion',
  );
  expect(
    moved.last.$2,
    greaterThan(moved.first.$2),
    reason: 'motion follows the finger: $moved',
  );
  expect(moved.last.$1, 0, reason: 'nothing may stay pressed after lift');
  if (!trackpad) {
    expect(transform.value, m, reason: 'one finger never moves the view');
  }
  expectInBounds('after swipe');

  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 1));
}
