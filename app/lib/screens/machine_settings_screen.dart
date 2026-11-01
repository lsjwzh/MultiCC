import 'package:flutter/material.dart';
import '../i18n.dart';
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
  Widget build(BuildContext context) => ListView(
    children: [
      ListTile(
        title: Text(
          t('airMachinesSettingsSavedOn', {'name': settings.machineName!}),
        ),
        subtitle: Text(t('airMachinesSettingsPhoneHint')),
      ),
      for (final (name, icon, entries)
          in <(String, IconData, List<(String, Widget)>)>[
            (
              t('airMachinesCategoryModels'),
              Icons.auto_awesome_outlined,
              [
                (
                  t('airMachinesProviderAccount'),
                  ProviderScreen(settings: settings),
                ),
                (t('airMachinesAuxAssistant'), AuxScreen(settings: settings)),
                (
                  t('airMachinesTokenUsage'),
                  TokenUsageScreen(settings: settings),
                ),
                (t('airMachinesCliTools'), MachineCliScreen(settings: settings)),
                (
                  t('airMachinesVoiceService'),
                  VoiceSettingsScreen(settings: settings),
                ),
              ],
            ),
            (
              t('airMachinesCategoryData'),
              Icons.shield_outlined,
              [
                (t('airMachinesVault'), SecretsScreen(settings: settings)),
                (
                  t('airMachinesStorage'),
                  AgentResourcesScreen(
                    settings: settings,
                    initialSection: AgentResourcesInitialSection.storage,
                  ),
                ),
              ],
            ),
            (
              t('airMachinesCategoryPower'),
              Icons.computer_outlined,
              [
                (
                  t('airMachinesHostPower'),
                  MachineHostScreen(settings: settings),
                ),
              ],
            ),
            (
              t('airMachinesCategorySkills'),
              Icons.extension_outlined,
              [
                (
                  t('airMachinesSkillsSync'),
                  AgentResourcesScreen(settings: settings),
                ),
              ],
            ),
            (
              t('airMachinesCategoryConnections'),
              Icons.hub_outlined,
              [
                (
                  t('airTunnelTunnel'),
                  TunnelSettingsScreen(settings: settings),
                ),
                (
                  t('messageBridges'),
                  BridgeSettingsScreen(settings: settings),
                ),
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
  );
}
