import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/app_update_provider.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/update_service.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response _json(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

/// The app's real bundle id, verified against Runner.xcodeproj
/// (PRODUCT_BUNDLE_IDENTIFIER = com.multicc.multiccApp). The provider must
/// take it from PackageInfo at runtime, never from a hardcoded constant.
const _bundleId = 'com.multicc.multiccApp';

PackageInfo _info({String version = '2.29.12', String build = '125'}) => PackageInfo(
  appName: 'multicc',
  packageName: _bundleId,
  version: version,
  buildNumber: build,
);

Map<String, dynamic> _storeListing({String version = '2.30.0'}) => {
  'resultCount': 1,
  'results': [
    {
      'version': version,
      'trackId': 6470000001,
      'trackViewUrl': 'https://apps.apple.com/us/app/id6470000001',
    },
  ],
};

Future<SettingsService> _settings() async {
  return SettingsService.getInstance();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  setUp(() {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://127.0.0.1:3000',
      'multicc_token': 'tok',
    });
    // UpdateService calls PackageInfo.fromPlatform() internally; without this
    // it never completes in the test environment.
    PackageInfo.setMockInitialValues(
      appName: 'multicc',
      packageName: _bundleId,
      version: '2.29.12',
      buildNumber: '125',
      buildSignature: '',
    );
  });

  group('compareVersionSegments', () {
    test('numeric segment compare across lengths', () {
      expect(compareVersionSegments('2.30.0', '2.29.12'), greaterThan(0));
      expect(compareVersionSegments('2.29.12', '2.29.12'), 0);
      expect(compareVersionSegments('2.29', '2.29.1'), lessThan(0));
      expect(compareVersionSegments('2.30', '2.30.0'), 0);
      expect(compareVersionSegments('10.0.0', '9.9.9'), greaterThan(0));
      expect(compareVersionSegments('2.29.12', '2.30'), lessThan(0));
    });
  });

  group('IosAppStoreUpdateProvider', () {
    test('newer store version → updateAvailable with store URL', () async {
      final calls = <Uri>[];
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async {
          calls.add(req.url);
          return _json(200, _storeListing(version: '2.30.0'));
        }),
        countryCode: 'us',
      );
      final result = await provider.check(settings: await _settings(), info: _info());

      expect(result.status, UpdateStatus.updateAvailable);
      expect(result.newVersionLabel, '2.30.0');
      expect(result.actionUrl, 'https://apps.apple.com/us/app/id6470000001');
      // The authoritative bundle id from PackageInfo flows into the lookup.
      expect(calls.single.queryParameters['bundleId'], _bundleId);
    });

    test('NEVER touches an APK endpoint — itunes.apple.com only', () async {
      final calls = <Uri>[];
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async {
          calls.add(req.url);
          return _json(200, _storeListing(version: '9.9.9'));
        }),
        countryCode: 'us',
      );
      await provider.check(settings: await _settings(), info: _info());

      expect(calls, isNotEmpty);
      for (final uri in calls) {
        expect(uri.host, 'itunes.apple.com');
        expect(uri.path.contains('apk'), isFalse,
            reason: 'iOS provider must never request APK metadata: $uri');
      }
    });

    test('equal store version → upToDate even with a higher build number',
        () async {
      // Store 2.29.12 == installed CFBundleShortVersionString 2.29.12; a
      // newer local build number must never trigger a store update prompt.
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async =>
            _json(200, _storeListing(version: '2.29.12'))),
        countryCode: 'us',
      );
      final result = await provider.check(
        settings: await _settings(),
        info: _info(version: '2.29.12', build: '999'),
      );
      expect(result.status, UpdateStatus.upToDate);
    });

    test('older store version → upToDate', () async {
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async =>
            _json(200, _storeListing(version: '2.28.0'))),
        countryCode: 'us',
      );
      final result = await provider.check(settings: await _settings(), info: _info());
      expect(result.status, UpdateStatus.upToDate);
    });

    test('no public listing in any storefront → listingMissing (no fake update)',
        () async {
      // The verified situation today: com.multicc.multiccApp returns
      // resultCount 0 everywhere (not released / in review / TestFlight-only).
      final calls = <Uri>[];
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async {
          calls.add(req.url);
          return _json(200, {'resultCount': 0, 'results': <Object>[]});
        }),
        countryCode: 'cn',
        fallbackCountryCode: 'us',
      );
      final result = await provider.check(settings: await _settings(), info: _info());

      expect(result.status, UpdateStatus.listingMissing);
      expect(result.hasUpdate, isFalse);
      expect(calls.map((u) => u.queryParameters['country']), ['cn', 'us']);
    });

    test('storefront fallback: cn empty, us has the listing', () async {
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async {
          if (req.url.queryParameters['country'] == 'cn') {
            return _json(200, {'resultCount': 0, 'results': <Object>[]});
          }
          return _json(200, _storeListing(version: '2.30.0'));
        }),
        countryCode: 'cn',
        fallbackCountryCode: 'us',
      );
      final result = await provider.check(settings: await _settings(), info: _info());
      expect(result.status, UpdateStatus.updateAvailable);
    });

    test('network failure → failed, never a prompt', () async {
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async => throw Exception('offline')),
        countryCode: 'us',
      );
      final result = await provider.check(settings: await _settings(), info: _info());
      expect(result.status, UpdateStatus.failed);
      expect(result.hasUpdate, isFalse);
    });

    test('non-200 lookup → failed', () async {
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async => _json(503, {'error': 'busy'})),
        countryCode: 'us',
      );
      final result = await provider.check(settings: await _settings(), info: _info());
      expect(result.status, UpdateStatus.failed);
    });

    test('cache: second automatic check makes no network call', () async {
      var hits = 0;
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async {
          hits++;
          return _json(200, _storeListing(version: '2.30.0'));
        }),
        countryCode: 'us',
      );
      final settings = await _settings();
      final first = await provider.check(settings: settings, info: _info());
      final second = await provider.check(settings: settings, info: _info());

      expect(hits, 1);
      expect(second.status, first.status);
      expect(second.newVersionLabel, first.newVersionLabel);
      expect(second.actionUrl, first.actionUrl);
    });

    test('fresh: true bypasses the cache', () async {
      var hits = 0;
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async {
          hits++;
          return _json(200, _storeListing(version: '2.30.0'));
        }),
        countryCode: 'us',
      );
      final settings = await _settings();
      await provider.check(settings: settings, info: _info());
      await provider.check(settings: settings, info: _info(), fresh: true);
      expect(hits, 2);
    });

    test('acknowledged store version quiets automatic prompts', () async {
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async =>
            _json(200, _storeListing(version: '2.30.0'))),
        countryCode: 'us',
      );
      final settings = await _settings();
      final result = await provider.check(settings: settings, info: _info());
      await provider.onConfirmed(result, settings);

      expect(await IosAppStoreUpdateProvider.ackedVersion(), '2.30.0');
    });
  });

  group('AndroidApkUpdateProvider', () {
    test('higher server versionCode → updateAvailable with tokenised URL',
        () async {
      final calls = <http.Request>[];
      final provider = AndroidApkUpdateProvider(
        client: MockClient((req) async {
          calls.add(req);
          return _json(200, {
            'exists': true,
            'versionName': '2.30.0',
            'versionCode': 126,
            'mtime': '2026-09-05T00:00:00Z',
          });
        }),
      );
      final result = await provider.check(
        settings: await _settings(),
        info: _info(version: '2.29.12', build: '125'),
      );

      expect(result.status, UpdateStatus.updateAvailable);
      expect(result.newVersionLabel, '2.30.0 (126)');
      expect(result.actionUrl, contains('/multicc.apk?token=tok'));
      expect(calls.single.url.path, '/api/apk-info');
      expect(calls.single.headers['X-Access-Token'], 'tok');
    });

    test('server versionCode <= installed → upToDate and remembered', () async {
      final provider = AndroidApkUpdateProvider(
        client: MockClient((req) async => _json(200, {
          'exists': true,
          'versionName': '2.29.12',
          'versionCode': 125,
          'mtime': '2026-09-05T00:00:00Z',
        })),
      );
      final result = await provider.check(
        settings: await _settings(),
        info: _info(build: '125'),
      );
      expect(result.status, UpdateStatus.upToDate);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getInt('multicc_apk_version_code'), 125);
    });

    test('no APK published → noApk', () async {
      final provider = AndroidApkUpdateProvider(
        client: MockClient((req) async => _json(200, {'exists': false})),
      );
      final result = await provider.check(settings: await _settings(), info: _info());
      expect(result.status, UpdateStatus.noApk);
    });

    test('server unreachable → failed', () async {
      final provider = AndroidApkUpdateProvider(
        client: MockClient((req) async => throw Exception('offline')),
      );
      final result = await provider.check(settings: await _settings(), info: _info());
      expect(result.status, UpdateStatus.failed);
    });
  });

  group('UpdateService platform gate', () {
    testWidgets('no provider (desktop) → manual check explains, no fetch',
        (tester) async {
      final old = UpdateService.providerForPlatform;
      UpdateService.providerForPlatform = () => null;
      addTearDown(() => UpdateService.providerForPlatform = old);

      var context;
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (ctx) {
            context = ctx;
            return const Scaffold(body: SizedBox());
          },
        ),
      ));

      await UpdateService.checkUpdateManually(context, await _settings());
      await tester.pumpAndSettle();

      expect(find.text('当前平台不支持应用内更新'), findsOneWidget);
    });

    testWidgets('iOS provider through the service shows store copy, not APK copy',
        (tester) async {
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async =>
            _json(200, _storeListing(version: '2.30.0'))),
        countryCode: 'us',
      );

      var context;
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (ctx) {
            context = ctx;
            return const Scaffold(body: SizedBox());
          },
        ),
      ));

      // Do NOT await: the updateAvailable branch waits for a dialog button.
      unawaited(UpdateService.checkUpdateManually(
        context,
        await _settings(),
        providerOverride: provider,
      ));
      await tester.pumpAndSettle();

      expect(find.text('发现新版本 2.30.0'), findsOneWidget);
      expect(find.text('App Store 上有新版本，是否前往更新？'), findsOneWidget);
      expect(find.textContaining('APK'), findsNothing);

      // Tapping "later" completes the flow and records the acknowledgement.
      await tester.tap(find.text('稍后'));
      await tester.pumpAndSettle();
    });

    testWidgets('automatic check stays silent for an acknowledged version',
        (tester) async {
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async =>
            _json(200, _storeListing(version: '2.30.0'))),
        countryCode: 'us',
      );

      var context;
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (ctx) {
            context = ctx;
            return const Scaffold(body: SizedBox());
          },
        ),
      ));

      final settings = await _settings();
      // Seed: the user already answered the 2.30.0 prompt.
      (await SharedPreferences.getInstance())
          .setString('multicc_ios_store_acked_version', '2.30.0');

      await UpdateService.checkUpdate(context, settings, providerOverride: provider);
      await tester.pumpAndSettle();

      expect(find.text('发现新版本 2.30.0'), findsNothing);
    });

    testWidgets('iOS manual check with no store listing → honest no-update copy',
        (tester) async {
      final provider = IosAppStoreUpdateProvider(
        client: MockClient((req) async =>
            _json(200, {'resultCount': 0, 'results': <Object>[]})),
        countryCode: 'us',
      );

      var context;
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (ctx) {
            context = ctx;
            return const Scaffold(body: SizedBox());
          },
        ),
      ));

      await UpdateService.checkUpdateManually(
        context,
        await _settings(),
        providerOverride: provider,
      );
      await tester.pumpAndSettle();

      expect(find.text('App Store 上暂未公开发布此应用，暂无可用更新。'), findsOneWidget);
      expect(find.textContaining('APK'), findsNothing);
    });
  });
}
