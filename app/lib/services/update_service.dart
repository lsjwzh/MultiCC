import 'dart:io';

import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../i18n.dart';
import 'app_update_provider.dart';
import 'settings_service.dart';

/// App update orchestration: picks a platform-specific provider (see
/// app_update_provider.dart) and renders prompts. The APK flow is Android
/// only; iOS checks the App Store and can never reach an APK endpoint.
class UpdateService {
  /// Test seam: how the production platform choice is made. Production reads
  /// Platform.*; tests override with injected fake providers.
  static AppUpdateProvider? Function() providerForPlatform = _defaultProvider;

  static AppUpdateProvider? _defaultProvider() {
    if (Platform.isIOS) return IosAppStoreUpdateProvider();
    if (Platform.isAndroid) return AndroidApkUpdateProvider();
    return null; // desktop / other: no in-app update checks at all
  }

  /// Installed app version string for display, e.g. "2.5.2 (30)".
  static Future<String> currentVersion() async {
    try {
      final info = await PackageInfo.fromPlatform();
      return '${info.version} (${info.buildNumber})';
    } catch (_) {
      return '未知';
    }
  }

  /// The settings-page version hint is platform specific: Android compares
  /// build numbers against the server APK, iOS follows the App Store release.
  static String versionFormatHintKey() =>
      Platform.isIOS ? 'versionFormatHintIos' : 'versionFormatHint';

  /// Silent, automatic update check fired on launch. Prompts only when the
  /// platform provider reports a genuinely newer published version the user
  /// has not already acknowledged.
  static Future<void> checkUpdate(
    BuildContext context,
    SettingsService settings, {
    AppUpdateProvider? providerOverride,
  }) async {
    final provider = providerOverride ?? providerForPlatform();
    if (provider == null || !settings.isConfigured) return;

    try {
      final info = await PackageInfo.fromPlatform();
      final result = await provider.check(settings: settings, info: info);
      if (!result.hasUpdate) return;

      // Quiet repeat prompts: once the user has answered for a given offered
      // version, automatic checks stay silent until something newer appears.
      if (provider is IosAppStoreUpdateProvider) {
        final acked = await IosAppStoreUpdateProvider.ackedVersion();
        if (acked == result.newVersionLabel) return;
      }

      if (!context.mounted) return;
      final shouldUpdate = await _confirmUpdateDialog(context, provider, result);
      if (shouldUpdate == true) {
        await provider.onConfirmed(result, settings);
        await _openUpdate(context, provider, result, settings);
      } else if (shouldUpdate == false) {
        // Declining also counts as acknowledged — no nagging every launch.
        await provider.onConfirmed(result, settings);
      }
    } catch (_) {
      // Silently ignore — automatic check must never interrupt the user.
    }
  }

  /// Manual "check for update" triggered from Settings. Always shows a
  /// result: an update prompt, or a platform-specific "no update" reason.
  static Future<void> checkUpdateManually(
    BuildContext context,
    SettingsService settings, {
    AppUpdateProvider? providerOverride,
  }) async {
    final provider = providerOverride ?? providerForPlatform();
    if (!settings.isConfigured) {
      _info(context, t('updateNeedConfigTitle'), t('updateNeedConfigBody'));
      return;
    }
    if (provider == null) {
      _info(context, t('updateUnsupportedTitle'), t('updateUnsupportedBody'));
      return;
    }

    PackageInfo info;
    try {
      info = await PackageInfo.fromPlatform();
    } catch (e) {
      if (context.mounted) {
        _info(context, t('updateCheckFailedTitle'), t('updateReadVersionFailed', {'error': '$e'}));
      }
      return;
    }

    final result = await provider.check(settings: settings, info: info, fresh: true);
    if (!context.mounted) return;

    switch (result.status) {
      case UpdateStatus.updateAvailable:
        final shouldUpdate = await _confirmUpdateDialog(context, provider, result);
        if (shouldUpdate == true) {
          await provider.onConfirmed(result, settings);
          await _openUpdate(context, provider, result, settings);
        } else if (shouldUpdate == false) {
          await provider.onConfirmed(result, settings);
        }
        return;
      case UpdateStatus.upToDate:
        if (provider is IosAppStoreUpdateProvider) {
          _info(
            context,
            t('updateUpToDateTitle'),
            t('updateUpToDateStoreBody', {'version': info.version}),
          );
        } else {
          _info(
            context,
            t('updateUpToDateTitle'),
            t('updateUpToDateApkBody', {
              'version': info.version,
              'build': info.buildNumber,
            }),
          );
        }
        return;
      case UpdateStatus.listingMissing:
        // Not released / in review / TestFlight-only / not visible in the
        // storefront — the honest answer is "nothing available", never an
        // APK fallback.
        _info(context, t('updateUpToDateTitle'), t('updateStoreListingMissing'));
        return;
      case UpdateStatus.noApk:
        _info(context, t('updateNoApkTitle'), t('updateNoApkBody'));
        return;
      case UpdateStatus.failed:
        if (provider is IosAppStoreUpdateProvider) {
          _info(context, t('updateCheckFailedTitle'), t('updateStoreCheckFailed'));
        } else {
          _info(context, t('updateCheckFailedTitle'), t('updateServerUnreachable'));
        }
        return;
    }
  }

  // ── helpers ──

  static Future<void> _openUpdate(
    BuildContext context,
    AppUpdateProvider provider,
    UpdateCheckResult result,
    SettingsService settings,
  ) async {
    final ok = await provider.openUpdate(result, settings);
    if (!ok && context.mounted) {
      _info(
        context,
        t('updateOpenFailedTitle'),
        provider is IosAppStoreUpdateProvider
            ? t('updateOpenStoreFailed')
            : t('updateOpenDownloadFailed'),
      );
    }
  }

  static Future<bool?> _confirmUpdateDialog(
    BuildContext context,
    AppUpdateProvider provider,
    UpdateCheckResult result,
  ) {
    final isStore = provider is IosAppStoreUpdateProvider;
    final label = result.newVersionLabel;
    return showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: Text(
          label.isNotEmpty ? t('updateFoundTitle', {'version': label}) : t('updateFoundPlainTitle'),
          style: const TextStyle(color: Color(0xFFf2f4f7)),
        ),
        content: Text(
          isStore ? t('updateFoundStoreBody') : t('updateFoundApkBody'),
          style: const TextStyle(color: Color(0xFF8a909b)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(t('updateLater'), style: const TextStyle(color: Color(0xFF8a909b))),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(
              t('updateAction'),
              style: const TextStyle(
                color: Color(0xFF6aa3ff),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }

  static void _info(BuildContext context, String title, String body) {
    showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: Text(title, style: const TextStyle(color: Color(0xFFf2f4f7))),
        content: Text(body, style: const TextStyle(color: Color(0xFF8a909b))),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(
              t('done'),
              style: const TextStyle(
                color: Color(0xFF6aa3ff),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
