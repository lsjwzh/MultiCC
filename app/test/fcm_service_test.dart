import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/services/fcm_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SettingsService settings;
  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    settings = await SettingsService.getInstance();
  });
  setUp(() async {
    await settings.save(
      host: 'https://example.test',
      token: 'test-access',
      notificationsEnabled: true,
    );
    await settings.setTaskNotifyEnabled('muted', false);
  });

  for (final state in ['not_configured', 'no_play_services', 'unavailable']) {
    test('$state does not register or throw', () async {
      final service = FcmService(
        settings: settings,
        onTap: (_) {},
        isSupported: true,
        client: MockClient((_) async => throw StateError('Unexpected HTTP')),
        invoke: (method, args) async =>
            method == 'token' ? {'status': state} : true,
      );
      await service.refresh();
      expect(service.status.value, state);
      service.dispose();
    });
  }
  test('missing native plugin and timeout are contained', () async {
    for (final invoke
        in <Future<dynamic> Function(String, Map<String, dynamic>?)>[
          (_, _) async => throw MissingPluginException(),
          (_, _) => Completer<dynamic>().future,
        ]) {
      final service = FcmService(
        settings: settings,
        onTap: (_) {},
        isSupported: true,
        timeout: const Duration(milliseconds: 10),
        invoke: invoke,
      );
      await service.refresh();
      expect(service.status.value, 'unavailable');
      service.dispose();
    }
  });
  test(
    'registration, token rotation, mute settings and stale server taps',
    () async {
      final requests = <http.Request>[];
      final syncs = <Map<String, dynamic>>[];
      final taps = <String>[];
      var token = 'first-token';
      final service = FcmService(
        settings: settings,
        onTap: taps.add,
        isSupported: true,
        client: MockClient((req) async {
          requests.add(req);
          return http.Response('{"ok":true}', 200);
        }),
        invoke: (method, args) async {
          if (method == 'sync') syncs.add(args!);
          return method == 'token'
              ? {'status': 'ready', 'token': token, 'projectId': 'test-project'}
              : true;
        },
      );
      await service.refresh();
      expect(service.status.value, 'registered');
      expect(requests.single.headers['X-Access-Token'], 'test-access');
      expect(syncs.single['disabledSessions'], contains('muted'));
      final oldBinding = settings.pushBinding;
      final id = settings.pushDeviceId;
      await service.refresh();
      expect(requests.length, 1); // unchanged token is not spammed
      token = 'rotated-token';
      await service.refresh();
      expect(jsonDecode(requests.last.body)['token'], token);
      await settings.save(host: 'https://second.test');
      await service.refresh();
      expect(settings.pushDeviceId, id);
      expect(settings.pushBinding, isNot(oldBinding));
      expect(
        requests.where((r) => r.method == 'DELETE').single.url.host,
        'example.test',
      );
      service.handleTap({'binding': oldBinding, 'sessionId': 's1'});
      service.handleTap({'binding': settings.pushBinding, 'sessionId': 's2'});
      expect(taps, ['s2']);
      await settings.save(notificationsEnabled: false);
      await service.refresh();
      expect(syncs.last['enabled'], false);
      expect(service.status.value, 'disabled');
      service.dispose();
    },
  );
  test(
    'host change during registration cleans old registration and discards result',
    () async {
      final postStarted = Completer<void>();
      final release = Completer<void>();
      final requests = <http.Request>[];
      final service = FcmService(
        settings: settings,
        onTap: (_) {},
        isSupported: true,
        client: MockClient((req) async {
          requests.add(req);
          if (req.method == 'POST') {
            postStarted.complete();
            await release.future;
          }
          return http.Response('{"ok":true}', 200);
        }),
        invoke: (method, _) async => method == 'token'
            ? {
                'status': 'ready',
                'token': 'test-token',
                'projectId': 'test-project',
              }
            : true,
      );
      final job = service.refresh();
      await postStarted.future;
      await settings.save(host: 'https://changed.test');
      release.complete();
      await job;
      expect(service.status.value, isNot('registered'));
      expect(requests.last.method, 'DELETE');
      expect(requests.last.url.host, 'example.test');
      service.dispose();
    },
  );
  test('server rejection and HTTP failure never report registered', () async {
    for (final fail in [false, true]) {
      final service = FcmService(
        settings: settings,
        onTap: (_) {},
        isSupported: true,
        client: MockClient(
          (_) async =>
              fail ? throw Exception('network') : http.Response('{}', 503),
        ),
        invoke: (method, _) async => method == 'token'
            ? {
                'status': 'ready',
                'token': 'test-token',
                'projectId': 'test-project',
              }
            : true,
      );
      await service.refresh();
      expect(
        service.status.value,
        fail ? 'unavailable' : 'server_not_configured',
      );
      service.dispose();
    }
  });
}
