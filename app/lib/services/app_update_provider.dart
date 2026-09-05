import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'settings_service.dart';

/// Platform-separated app update providers.
///
/// History: UpdateService used to ask the MultiCC server's /api/apk-info from
/// every platform, so iOS devices compared their build number against the
/// Android versionCode and were prompted to "download the new APK". The fix is
/// structural, not cosmetic: each platform gets its own provider and the iOS
/// provider has no code path that can reach an APK endpoint.
///
///   Android → AndroidApkUpdateProvider   (existing /api/apk-info flow, kept)
///   iOS     → IosAppStoreUpdateProvider  (App Store lookup, never APK)
///   other   → no provider (no in-app update UI at all)

enum UpdateStatus {
  /// A newer version is published; [UpdateCheckResult.actionUrl] is set.
  updateAvailable,

  /// Nothing newer than the installed version.
  upToDate,

  /// iOS: the App Store has no public listing for this bundle id (not yet
  /// released, still in review, or not visible in the tried storefronts).
  /// Never a fake update — behaves like upToDate for auto checks.
  listingMissing,

  /// Android: the server has no APK published.
  noApk,

  /// The check could not complete (network, timeout, bad response).
  failed,
}

class UpdateCheckResult {
  const UpdateCheckResult({
    required this.status,
    this.newVersionLabel = '',
    this.actionUrl = '',
    this.detail = '',
  });

  final UpdateStatus status;

  /// Display label for the offered version, e.g. "2.30.0" or "2.30.0 (73)".
  final String newVersionLabel;

  /// Where the "update" action goes: APK download URL (Android) or the App
  /// Store product page (iOS).
  final String actionUrl;

  /// Diagnostic detail for logs and manual-check error dialogs.
  final String detail;

  bool get hasUpdate => status == UpdateStatus.updateAvailable;
}

/// Numeric dotted-version comparison ("2.29.12" vs "2.30.0"). Missing
/// segments count as 0; segments that are not pure integers fall back to a
/// case-insensitive string compare so weird store strings still order
/// deterministically. Returns <0 / 0 / >0 like String.compareTo.
int compareVersionSegments(String a, String b) {
  final sa = a.trim().split('.');
  final sb = b.trim().split('.');
  final n = sa.length > sb.length ? sa.length : sb.length;
  for (var i = 0; i < n; i++) {
    // Missing segments count as 0 ("2.30" == "2.30.0", "2.29" < "2.29.1").
    final pa = i < sa.length ? sa[i] : '0';
    final pb = i < sb.length ? sb[i] : '0';
    final na = int.tryParse(pa);
    final nb = int.tryParse(pb);
    if (na != null && nb != null) {
      if (na != nb) return na.compareTo(nb);
      continue;
    }
    final c = pa.toLowerCase().compareTo(pb.toLowerCase());
    if (c != 0) return c;
  }
  return 0;
}

abstract class AppUpdateProvider {
  /// Check for an update. [fresh] bypasses any cache (manual checks want the
  /// live answer) while still refreshing it.
  Future<UpdateCheckResult> check({
    required SettingsService settings,
    required PackageInfo info,
    bool fresh = false,
  });

  /// Execute the update action. Returns whether the OS accepted it.
  Future<bool> openUpdate(UpdateCheckResult result, SettingsService settings);

  /// Called after the user accepts an update prompt (providers persist their
  /// own dedup state so automatic checks do not nag every launch).
  Future<void> onConfirmed(UpdateCheckResult result, SettingsService settings) async {}
}

// ── Android: existing server-APK flow, moved verbatim ────────────────────────

class AndroidApkUpdateProvider implements AppUpdateProvider {
  AndroidApkUpdateProvider({http.Client? client, Duration timeout = const Duration(seconds: 8)})
    : _client = client,
      _timeout = timeout;

  static const _keyLastMtime = 'multicc_apk_mtime';
  static const _keyLastVersionCode = 'multicc_apk_version_code';

  final http.Client? _client;
  final Duration _timeout;

  // Metadata from the most recent check, used by onConfirmed so accepting a
  // prompt persists exactly what was offered (no second network round-trip).
  String _lastMtime = '';
  int _lastVersionCode = 0;

  Future<Map<String, dynamic>?> _fetchApkInfo(SettingsService settings) async {
    try {
      final url = settings.buildHttpUrl('/api/apk-info');
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final res = await (_client ?? http.Client())
          .get(Uri.parse(url), headers: headers)
          .timeout(_timeout);
      if (res.statusCode != 200) return null;
      return jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<UpdateCheckResult> check({
    required SettingsService settings,
    required PackageInfo info,
    bool fresh = false,
  }) async {
    final meta = await _fetchApkInfo(settings);
    if (meta == null) {
      return const UpdateCheckResult(status: UpdateStatus.failed, detail: 'apk-info unreachable');
    }
    if (meta['exists'] != true) {
      return const UpdateCheckResult(status: UpdateStatus.noApk);
    }

    final serverVersion = (meta['versionName'] as String?)?.trim() ?? '';
    final serverCode = (meta['versionCode'] as num?)?.toInt() ?? 0;
    final serverMtime = meta['mtime'] as String? ?? '';
    final currentCode = int.tryParse(info.buildNumber) ?? 0;

    // Prefer deterministic APK metadata over file mtime (original semantics).
    if (serverCode > 0 && currentCode > 0) {
      if (serverCode <= currentCode) {
        await _rememberPublishedApk(serverMtime, serverCode);
        return const UpdateCheckResult(status: UpdateStatus.upToDate);
      }
      _lastMtime = serverMtime;
      _lastVersionCode = serverCode;
      return UpdateCheckResult(
        status: UpdateStatus.updateAvailable,
        newVersionLabel: _versionLabel(serverVersion, serverCode),
        actionUrl: _apkDownloadUrl(settings),
        detail: 'apk code $serverCode > $currentCode',
      );
    }

    // mtime fallback for servers that report no usable versionCode.
    if (serverMtime.isEmpty) {
      return const UpdateCheckResult(status: UpdateStatus.upToDate);
    }
    final prefs = await SharedPreferences.getInstance();
    final lastMtime = prefs.getString(_keyLastMtime) ?? '';
    if (lastMtime.isEmpty) {
      await prefs.setString(_keyLastMtime, serverMtime);
      return const UpdateCheckResult(status: UpdateStatus.upToDate);
    }
    if (serverMtime == lastMtime) {
      return const UpdateCheckResult(status: UpdateStatus.upToDate);
    }
    _lastMtime = serverMtime;
    _lastVersionCode = serverCode;
    return UpdateCheckResult(
      status: UpdateStatus.updateAvailable,
      newVersionLabel: _versionLabel(serverVersion, serverCode),
      actionUrl: _apkDownloadUrl(settings),
      detail: 'apk mtime changed',
    );
  }

  @override
  Future<bool> openUpdate(UpdateCheckResult result, SettingsService settings) async {
    // Don't use canLaunchUrl — it's unreliable on Android 11+ (original note).
    try {
      return await launchUrl(
        Uri.parse(result.actionUrl.isNotEmpty ? result.actionUrl : _apkDownloadUrl(settings)),
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> onConfirmed(UpdateCheckResult result, SettingsService settings) async {
    await _rememberPublishedApk(_lastMtime, _lastVersionCode);
  }

  Future<void> _rememberPublishedApk(String mtime, int versionCode) async {
    final prefs = await SharedPreferences.getInstance();
    if (mtime.isNotEmpty) {
      await prefs.setString(_keyLastMtime, mtime);
    }
    if (versionCode > 0) {
      await prefs.setInt(_keyLastVersionCode, versionCode);
    }
  }

  String _apkDownloadUrl(SettingsService settings) {
    var downloadUrl = settings.buildHttpUrl('/multicc.apk');
    if (settings.token.isNotEmpty) {
      downloadUrl += '?token=${Uri.encodeQueryComponent(settings.token)}';
    }
    return downloadUrl;
  }

  String _versionLabel(String versionName, int versionCode) {
    if (versionName.isNotEmpty && versionCode > 0) {
      return '$versionName ($versionCode)';
    }
    if (versionName.isNotEmpty) return versionName;
    if (versionCode > 0) return 'build $versionCode';
    return '';
  }
}

// ── iOS: App Store lookup — structurally unable to reach an APK ──────────────

class IosAppStoreUpdateProvider implements AppUpdateProvider {
  IosAppStoreUpdateProvider({
    http.Client? client,
    Duration timeout = const Duration(seconds: 8),
    this.countryCode,
    this.fallbackCountryCode = 'us',
    Duration cacheTtl = const Duration(hours: 1),
  }) : _client = client,
       _timeout = timeout,
       _cacheTtl = cacheTtl;

  /// Set this once the app has a public App Store listing that the bundle-id
  /// lookup cannot find (e.g. a numeric App Store ID that differs). Null by
  /// default: today the store has no listing for com.multicc.multiccApp
  /// (verified: itunes lookup resultCount=0), so every check must degrade to
  /// "no update" instead of guessing an ID.
  static const String? appStoreIdOverride = null;

  static const _keyCache = 'multicc_ios_store_lookup_cache';
  static const _keyAckedVersion = 'multicc_ios_store_acked_version';

  static const _lookupHost = 'itunes.apple.com';

  final http.Client? _client;
  final Duration _timeout;
  final Duration _cacheTtl;

  /// Preferred storefront (ISO alpha-2, lowercase at call time). Falls back
  /// to [fallbackCountryCode] when the listing is not visible there.
  final String? countryCode;
  final String fallbackCountryCode;

  Uri _lookupUri(String country) {
    final id = appStoreIdOverride;
    return id == null
        ? Uri.https(_lookupHost, '/lookup', {'bundleId': _bundleId!, 'country': country})
        : Uri.https(_lookupHost, '/lookup', {'id': id, 'country': country});
  }

  // PackageInfo is passed into check(); remember the authoritative bundle id
  // so cache reads/writes keyed to the same app don't need it separately.
  String? _bundleId;

  @override
  Future<UpdateCheckResult> check({
    required SettingsService settings,
    required PackageInfo info,
    bool fresh = false,
  }) async {
    // packageName on iOS IS the bundle identifier — authoritative, no
    // hardcoding. (Verified against Runner.xcodeproj: com.multicc.multiccApp.)
    _bundleId = info.packageName;

    if (!fresh) {
      final cached = await _readCache();
      if (cached != null) return cached;
    }

    final primary = (countryCode ?? '').trim().toLowerCase();
    final fallback = fallbackCountryCode.trim().toLowerCase();
    final tried = <String>[...{if (primary.isNotEmpty) primary, if (fallback.isNotEmpty) fallback}];

    Map<String, dynamic>? listing;
    String? lastDetail;
    for (final country in tried) {
      final res = await _lookup(_lookupUri(country));
      if (res == null) {
        lastDetail ??= 'lookup failed ($country)';
        continue;
      }
      final count = (res['resultCount'] as num?)?.toInt() ?? 0;
      if (count > 0) {
        listing = (res['results'] as List?)?.first as Map<String, dynamic>?;
        break;
      }
      // resultCount 0: not released / in review / TestFlight-only / not
      // visible in this storefront. Try the next storefront if any.
      lastDetail = 'no listing in storefront $country';
    }

    final UpdateCheckResult result;
    if (listing != null) {
      final storeVersion = ((listing['version'] as String?) ?? '').trim();
      if (storeVersion.isEmpty) {
        result = const UpdateCheckResult(status: UpdateStatus.listingMissing, detail: 'store version empty');
      } else {
        // CFBundleShortVersionString comparison ONLY. The build number never
        // triggers a store update by itself.
        final newer = compareVersionSegments(storeVersion, info.version) > 0;
        result = newer
            ? UpdateCheckResult(
                status: UpdateStatus.updateAvailable,
                newVersionLabel: storeVersion,
                actionUrl: (listing['trackViewUrl'] as String?) ??
                    'https://apps.apple.com/app/id${listing['trackId']}',
                detail: 'store $storeVersion > local ${info.version}',
              )
            : UpdateCheckResult(status: UpdateStatus.upToDate, detail: 'store $storeVersion <= local ${info.version}');
      }
    } else if (lastDetail != null && lastDetail.startsWith('lookup failed')) {
      result = UpdateCheckResult(status: UpdateStatus.failed, detail: lastDetail);
    } else {
      result = UpdateCheckResult(status: UpdateStatus.listingMissing, detail: lastDetail ?? 'no storefronts tried');
    }

    await _writeCache(result);
    return result;
  }

  Future<Map<String, dynamic>?> _lookup(Uri uri) async {
    try {
      final res = await (_client ?? http.Client()).get(uri).timeout(_timeout);
      if (res.statusCode != 200) return null;
      final body = jsonDecode(res.body);
      return body is Map<String, dynamic> ? body : null;
    } catch (_) {
      return null;
    }
  }

  Future<UpdateCheckResult?> _readCache() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_keyCache);
      if (raw == null || raw.isEmpty) return null;
      final m = jsonDecode(raw) as Map<String, dynamic>;
      final at = (m['at'] as num?)?.toInt() ?? 0;
      if (DateTime.now().millisecondsSinceEpoch - at > _cacheTtl.inMilliseconds) return null;
      // Invalidate if the installed version changed since caching.
      if ((m['bundle'] as String?) != _bundleId) return null;
      return UpdateCheckResult(
        status: UpdateStatus.values[(m['status'] as num?)?.toInt() ?? 0],
        newVersionLabel: (m['version'] as String?) ?? '',
        actionUrl: (m['url'] as String?) ?? '',
        detail: 'cache',
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> _writeCache(UpdateCheckResult result) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_keyCache, jsonEncode({
        'at': DateTime.now().millisecondsSinceEpoch,
        'bundle': _bundleId,
        'status': result.status.index,
        'version': result.newVersionLabel,
        'url': result.actionUrl,
      }));
    } catch (_) {
      // Cache write failures must never surface as an update problem.
    }
  }

  @override
  Future<bool> openUpdate(UpdateCheckResult result, SettingsService settings) async {
    if (result.actionUrl.isEmpty) return false;
    try {
      return await launchUrl(Uri.parse(result.actionUrl), mode: LaunchMode.externalApplication);
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> onConfirmed(UpdateCheckResult result, SettingsService settings) async {
    // The user acknowledged this store version (accepted or declined the
    // prompt): automatic checks stay quiet until a *newer* store version.
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_keyAckedVersion, result.newVersionLabel);
    } catch (_) {}
  }

  /// The store version the user has already acknowledged, for automatic-check
  /// prompt dedup.
  static Future<String> ackedVersion() async {
    try {
      return (await SharedPreferences.getInstance()).getString(_keyAckedVersion) ?? '';
    } catch (_) {
      return '';
    }
  }
}
