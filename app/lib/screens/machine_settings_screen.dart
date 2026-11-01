import 'package:flutter/material.dart';
import '../services/settings_service.dart';
import '../widgets/air/air_computers.dart' show ComputerTargetShell;
import 'aux_screen.dart';
import 'provider_screen.dart';
import 'secrets_screen.dart';
import 'tunnel_settings_screen.dart';
import 'bridge_settings_screen.dart';
import 'token_usage_screen.dart';
import 'machine_tools_screen.dart';
import 'agent_resources_screen.dart';
import 'voice_settings_screen.dart';

/// Machine-only configuration; language, notifications and server switching
/// remain in the viewing app's own settings.
class MachineSettingsScreen extends StatelessWidget {
  const MachineSettingsScreen({super.key, required this.settings});
  final SettingsService settings;
  @override
  Widget build(BuildContext context) => ComputerTargetShell(
    name: settings.machineName!,
    settings: settings,
    child: _MachineCategories(settings: settings),
  );
}

class _MachineCategories extends StatelessWidget {
  const _MachineCategories({required this.settings});
  final SettingsService settings;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('电脑设置')),
    body: ListView(
      children: [
        ListTile(
          title: Text('配置保存在 ${settings.machineName}'),
          subtitle: const Text('手机偏好在外层设置中管理。'),
        ),
        for (final (name, icon, entries)
            in <(String, IconData, List<(String, Widget)>)>[
              (
                '模型与线路',
                Icons.auto_awesome_outlined,
                [
                  ('模型账号与服务', ProviderScreen(settings: settings)),
                  ('辅助助手', AuxScreen(settings: settings)),
                  ('用量统计', TokenUsageScreen(settings: settings)),
                  ('命令行工具', MachineCliScreen(settings: settings)),
                  ('语音服务', VoiceSettingsScreen(settings: settings)),
                ],
              ),
              (
                '数据与安全',
                Icons.shield_outlined,
                [
                  ('保险箱', SecretsScreen(settings: settings)),
                  (
                    '数据与存储',
                    AgentResourcesScreen(
                      settings: settings,
                      initialSection: AgentResourcesInitialSection.storage,
                    ),
                  ),
                ],
              ),
              (
                '电脑与电源',
                Icons.computer_outlined,
                [('主机状态与电源', MachineHostScreen(settings: settings))],
              ),
              (
                '技能与资源',
                Icons.extension_outlined,
                [('技能、资源与同步', AgentResourcesScreen(settings: settings))],
              ),
              (
                '连接与集成',
                Icons.hub_outlined,
                [
                  ('隧道', TunnelSettingsScreen(settings: settings)),
                  ('消息桥接', BridgeSettingsScreen(settings: settings)),
                ],
              ),
            ])
          ListTile(
            title: Text(name),
            leading: Icon(icon),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => Scaffold(
                  appBar: AppBar(title: Text(name)),
                  body: ListView(
                    children: [
                      for (final (title, page) in entries)
                        ListTile(
                          title: Text(title),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () => Navigator.of(
                            context,
                          ).push(MaterialPageRoute<void>(builder: (_) => page)),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    ),
  );
}
