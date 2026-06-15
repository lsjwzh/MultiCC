import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'settings_service.dart';

class UpdateService {
  static const _keyLastMtime = 'multicc_apk_mtime';

  static Future<void> checkUpdate(BuildContext context, SettingsService settings) async {
    if (!settings.isConfigured) return;

    try {
      final url = settings.buildHttpUrl('/api/apk-info');
      final headers = <String, String>{};
      if (settings.token.isNotEmpty) {
        headers['X-Access-Token'] = settings.token;
      }
      final res = await http
          .get(Uri.parse(url), headers: headers)
          .timeout(const Duration(seconds: 5));
      if (res.statusCode != 200) return;

      final json = jsonDecode(res.body) as Map<String, dynamic>;
      if (json['exists'] != true) return;

      final serverMtime = json['mtime'] as String? ?? '';
      if (serverMtime.isEmpty) return;
      // Optional — present when the server has a version sidecar for the APK.
      final serverVersion = (json['versionName'] as String?)?.trim() ?? '';

      final prefs = await SharedPreferences.getInstance();
      final lastMtime = prefs.getString(_keyLastMtime) ?? '';

      if (lastMtime.isEmpty) {
        await prefs.setString(_keyLastMtime, serverMtime);
        return;
      }

      if (serverMtime != lastMtime) {
        if (!context.mounted) return;
        final shouldUpdate = await showDialog<bool>(
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
                child: const Text('更新', style: TextStyle(color: Color(0xFF6aa3ff), fontWeight: FontWeight.w600)),
              ),
            ],
          ),
        );

        if (shouldUpdate == true) {
          await prefs.setString(_keyLastMtime, serverMtime);
          // Build download URL with token for authentication
          var downloadUrl = settings.buildHttpUrl('/multicc.apk');
          if (settings.token.isNotEmpty) {
            downloadUrl += '?token=${Uri.encodeQueryComponent(settings.token)}';
          }
          // Don't use canLaunchUrl — it's unreliable on Android 11+
          await launchUrl(
            Uri.parse(downloadUrl),
            mode: LaunchMode.externalApplication,
          );
        }
      }
    } catch (_) {
      // Silently ignore
    }
  }
}
