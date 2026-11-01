import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../services/settings_service.dart';
import '../theme.dart';

class ExternalAccessHint extends StatelessWidget {
  const ExternalAccessHint({super.key, required this.settings});
  final SettingsService settings;

  @override
  Widget build(BuildContext context) {
    // 机器作用域下入口页要带 machine 参数（网页据此进入作用域模式）；
    // 单机下与 buildHttpUrl 逐字一致。
    final url = settings.machinePageUrl('/air?view=tunnel');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            t('externalAccessHint'),
            style: const TextStyle(
              fontSize: 12,
              color: AppColors.muted,
              height: 1.5,
            ),
          ),
          TextButton.icon(
            onPressed: url == null
                ? null
                : () => launchUrl(
                    Uri.parse(url),
                    mode: LaunchMode.externalApplication,
                  ),
            icon: const Icon(Icons.open_in_new, size: 15),
            label: Text(t('externalAccessSetup')),
          ),
        ],
      ),
    );
  }
}
