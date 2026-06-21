import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'settings_service.dart';

class UpdateService {
  static const _keyLastMtime = 'multicc_apk_mtime';

  /// Installed app version string for display, e.g. "2.5.2 (30)".
  static Future<String> currentVersion() async {
    try {
      final info = await PackageInfo.fromPlatform();
      return '${info.version} (${info.buildNumber})';
    } catch (_) {
      return '未知';
    }
  }

  /// Silent, automatic update check fired on launch. Prompts only when the
  /// server's APK is genuinely newer than what's installed.
  static Future<void> checkUpdate(BuildContext context, SettingsService settings) async {
    if (!settings.isConfigured) return;

    try {
      final info = await PackageInfo.fromPlatform();
      final currentCode = int.tryParse(info.buildNumber) ?? 0;

      final meta = await _fetchApkInfo(settings);
      if (meta == null || meta['exists'] != true) return;

      final serverMtime = meta['mtime'] as String? ?? '';
      if (serverMtime.isEmpty) return;
      final serverVersion = (meta['versionName'] as String?)?.trim() ?? '';
      final serverCode = (meta['versionCode'] as num?)?.toInt() ?? 0;

      // If the server exposes a versionCode, trust it over the mtime heuristic:
      // never nag when the installed build is already >= the published one.
      if (serverCode > 0 && currentCode > 0 && serverCode <= currentCode) {
        return;
      }

      final prefs = await SharedPreferences.getInstance();
      final lastMtime = prefs.getString(_keyLastMtime) ?? '';

      if (lastMtime.isEmpty) {
        await prefs.setString(_keyLastMtime, serverMtime);
        return;
      }

      if (serverMtime != lastMtime) {
        if (!context.mounted) return;
        final shouldUpdate = await _confirmUpdateDialog(context, serverVersion);
        if (shouldUpdate == true) {
          await prefs.setString(_keyLastMtime, serverMtime);
          await _launchDownload(settings);
        }
      }
    } catch (_) {
      // Silently ignore — automatic check must never interrupt the user.
    }
  }

  /// Manual "check for update" triggered from Settings. Always shows a result:
  /// either "you're up to date" or an update prompt.
  static Future<void> checkUpdateManually(BuildContext context, SettingsService settings) async {
    if (!settings.isConfigured) {
      _info(context, '请先配置服务器连接', '在「服务器连接」里填好地址后再检查更新。');
      return;
    }

    PackageInfo info;
    try {
      info = await PackageInfo.fromPlatform();
    } catch (e) {
      if (context.mounted) _info(context, '检查失败', '无法读取本机版本：$e');
      return;
    }
    final currentCode = int.tryParse(info.buildNumber) ?? 0;

    final meta = await _fetchApkInfo(settings);
    if (!context.mounted) return;
    if (meta == null) {
      _info(context, '检查失败', '无法连接服务器，请确认地址、Token 与网络。');
      return;
    }
    if (meta['exists'] != true) {
      _info(context, '暂无安装包', '服务器上还没有发布 APK。');
      return;
    }

    final serverVersion = (meta['versionName'] as String?)?.trim() ?? '';
    final serverCode = (meta['versionCode'] as num?)?.toInt() ?? 0;
    final serverMtime = meta['mtime'] as String? ?? '';

    final hasNewer = (serverCode > 0 && currentCode > 0)
        ? serverCode > currentCode
        : (serverVersion.isNotEmpty && serverVersion != info.version);

    if (!hasNewer) {
      _info(context, '已是最新版本',
          '当前版本 ${info.version} (${info.buildNumber}) 已是服务器上的最新版本。');
      return;
    }

    final shouldUpdate = await _confirmUpdateDialog(context, serverVersion);
    if (shouldUpdate == true) {
      if (serverMtime.isNotEmpty) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(_keyLastMtime, serverMtime);
      }
      await _launchDownload(settings);
    }
  }

  // ── helpers ──

  static Future<Map<String, dynamic>?> _fetchApkInfo(SettingsService settings) async {
    try {
      final url = settings.buildHttpUrl('/api/apk-info');
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) headers['X-Access-Token'] = settings.token;
      final res = await http
          .get(Uri.parse(url), headers: headers)
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return null;
      return jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  static Future<void> _launchDownload(SettingsService settings) async {
    var downloadUrl = settings.buildHttpUrl('/multicc.apk');
    if (settings.token.isNotEmpty) {
      downloadUrl += '?token=${Uri.encodeQueryComponent(settings.token)}';
    }
    // Don't use canLaunchUrl — it's unreliable on Android 11+.
    await launchUrl(Uri.parse(downloadUrl), mode: LaunchMode.externalApplication);
  }

  static Future<bool?> _confirmUpdateDialog(BuildContext context, String serverVersion) {
    return showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: Text(
          serverVersion.isNotEmpty ? '发现新版本 $serverVersion' : '发现新版本',
          style: const TextStyle(color: Color(0xFFf2f4f7)),
        ),
        content: const Text(
          '服务器上有新版本的 APK，是否下载更新？',
          style: TextStyle(color: Color(0xFF8a909b)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('稍后', style: TextStyle(color: Color(0xFF8a909b))),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('更新',
                style: TextStyle(color: Color(0xFF6aa3ff), fontWeight: FontWeight.w600)),
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
            child: const Text('好',
                style: TextStyle(color: Color(0xFF6aa3ff), fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }
}
