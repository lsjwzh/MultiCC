import 'package:flutter/material.dart';

import '../i18n.dart';
import '../theme.dart';

/// Local tokens copied from the web manage shell. Keeping them scoped here
/// avoids changing the rest of the native app just to match one surface.
abstract final class _SettingsNavColors {
  static const bg = Color(0xFF0A0C10);
  static const panel = Color(0xFF181D27);
  static const line = Color(0x24FFFFFF);
  static const text = Color(0xFFEEF1F6);
  static const muted = Color(0xFF969DB0);
  static const faint = Color(0xFF6A7280);
}

/// Settings destinations and order mirror the Settings group in web/manage.
enum SettingsDestination {
  voice,
  goal,
  provider,
  global,
  push,
  tunnel,
  bridges,
  resources,
  skillSync,
  storage,
}

abstract final class SettingsRoutes {
  static const voice = '/settings/voice';
  static const goal = '/settings/goal';
  static const provider = '/settings/provider';
  static const global = '/settings/global';
  static const push = '/settings/push';
  static const tunnel = '/settings/tunnel';
  static const bridges = '/settings/bridges';
  static const resources = '/settings/resources';
  static const skillSync = '/settings/skill-sync';
  static const storage = '/settings/storage';
}

extension on SettingsDestination {
  String get routeName => switch (this) {
    SettingsDestination.voice => SettingsRoutes.voice,
    SettingsDestination.goal => SettingsRoutes.goal,
    SettingsDestination.provider => SettingsRoutes.provider,
    SettingsDestination.global => SettingsRoutes.global,
    SettingsDestination.push => SettingsRoutes.push,
    SettingsDestination.tunnel => SettingsRoutes.tunnel,
    SettingsDestination.bridges => SettingsRoutes.bridges,
    SettingsDestination.resources => SettingsRoutes.resources,
    SettingsDestination.skillSync => SettingsRoutes.skillSync,
    SettingsDestination.storage => SettingsRoutes.storage,
  };

  String get labelKey => switch (this) {
    SettingsDestination.voice => 'voiceSettings',
    SettingsDestination.goal => 'goalPrecheck',
    SettingsDestination.provider => 'providerConfig',
    SettingsDestination.global => 'globalConfig',
    SettingsDestination.push => 'pushNotifications',
    SettingsDestination.tunnel => 'tunnel',
    SettingsDestination.bridges => 'messageBridges',
    SettingsDestination.resources => 'agentResources',
    SettingsDestination.skillSync => 'skillSync',
    SettingsDestination.storage => 'temporaryUploads',
  };

  IconData get icon => switch (this) {
    SettingsDestination.voice => Icons.mic_none_rounded,
    SettingsDestination.goal => Icons.track_changes_rounded,
    SettingsDestination.provider => Icons.swap_horiz_rounded,
    SettingsDestination.global => Icons.settings_outlined,
    SettingsDestination.push => Icons.notifications_none_rounded,
    SettingsDestination.tunnel => Icons.public_rounded,
    SettingsDestination.bridges => Icons.device_hub_outlined,
    SettingsDestination.resources => Icons.inventory_2_outlined,
    SettingsDestination.skillSync => Icons.sync_rounded,
    SettingsDestination.storage => Icons.storage_outlined,
  };
}

/// Native counterpart of the web manage Settings sidebar.
///
/// The middle destination list is the only scrolling region. The connection
/// footer stays reachable on short phones, matching the web drawer contract.
class SettingsNavigationDrawer extends StatelessWidget {
  const SettingsNavigationDrawer({
    super.key,
    required this.selected,
    required this.serverLabel,
    this.onSelected,
    this.onExit,
  });

  static const double width = 236;

  final SettingsDestination selected;
  final String serverLabel;
  final ValueChanged<SettingsDestination>? onSelected;
  final VoidCallback? onExit;

  void _select(BuildContext context, SettingsDestination destination) {
    final navigator = Navigator.of(context);
    navigator.pop();
    if (destination == selected) return;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (onSelected != null) {
        onSelected!(destination);
      } else if (navigator.mounted) {
        navigator.pushReplacementNamed(destination.routeName);
      }
    });
  }

  void _exit(BuildContext context) {
    final navigator = Navigator.of(context);
    navigator.pop();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (onExit != null) {
        onExit!();
      } else if (navigator.mounted) {
        navigator.popUntil((route) => route.isFirst);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Drawer(
      width: width,
      elevation: 0,
      backgroundColor: _SettingsNavColors.bg,
      shape: const Border(right: BorderSide(color: _SettingsNavColors.line)),
      child: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            stops: [0, 0.3],
            colors: [Color(0x05FFFFFF), Colors.transparent],
          ),
        ),
        child: SafeArea(
          minimum: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 16, 12, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _Brand(onTap: () => _exit(context)),
                _GroupLabel(text: t('settingsTitle')),
                Expanded(
                  child: SingleChildScrollView(
                    key: const ValueKey('settings-nav-scroll'),
                    clipBehavior: Clip.none,
                    physics: const ClampingScrollPhysics(),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (final destination in SettingsDestination.values)
                          _DestinationTile(
                            destination: destination,
                            selected: destination == selected,
                            onTap: () => _select(context, destination),
                          ),
                      ],
                    ),
                  ),
                ),
                _DrawerFooter(
                  serverLabel: serverLabel,
                  onExit: () => _exit(context),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Brand extends StatelessWidget {
  const _Brand({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      key: const ValueKey('settings-nav-brand'),
      button: true,
      label: 'MultiCC ${t('workspace')}',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          excludeFromSemantics: true,
          onTap: onTap,
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(8, 6, 8, 10),
            child: Row(
              children: [
                Container(
                  width: 30,
                  height: 30,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [AppColors.accent, Color(0xFF1d8a7e)],
                    ),
                    borderRadius: BorderRadius.circular(9),
                    border: Border.all(color: const Color(0x4D3AD6C5)),
                    boxShadow: const [
                      BoxShadow(
                        color: Color(0x403AD6C5),
                        blurRadius: 18,
                        offset: Offset(0, 6),
                      ),
                    ],
                  ),
                  child: const Text(
                    'M',
                    style: TextStyle(
                      color: Color(0xFF04110f),
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text.rich(
                        const TextSpan(
                          children: [
                            TextSpan(text: 'Multi'),
                            TextSpan(
                              text: 'CC',
                              style: TextStyle(color: AppColors.accent),
                            ),
                          ],
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: _SettingsNavColors.text,
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.3,
                        ),
                      ),
                      Text(
                        t('settingsTitle'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: _SettingsNavColors.faint,
                          fontSize: 10,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _GroupLabel extends StatelessWidget {
  const _GroupLabel({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 14, 10, 6),
      child: Text(
        text.toUpperCase(),
        key: const ValueKey('settings-nav-label'),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          color: _SettingsNavColors.faint,
          fontSize: 10,
          fontWeight: FontWeight.w600,
          letterSpacing: 1.4,
        ),
      ),
    );
  }
}

class _DestinationTile extends StatelessWidget {
  const _DestinationTile({
    required this.destination,
    required this.selected,
    required this.onTap,
  });

  final SettingsDestination destination;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final foreground = selected
        ? _SettingsNavColors.text
        : _SettingsNavColors.muted;
    return Semantics(
      key: ValueKey('settings-nav-${destination.name}'),
      button: true,
      selected: selected,
      label: t(destination.labelKey),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Material(
            color: selected ? const Color(0x243AD6C5) : Colors.transparent,
            borderRadius: BorderRadius.circular(10),
            child: InkWell(
              excludeFromSemantics: true,
              borderRadius: BorderRadius.circular(10),
              onTap: onTap,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 17,
                        child: Icon(
                          destination.icon,
                          color: foreground,
                          size: 18,
                        ),
                      ),
                      const SizedBox(width: 11),
                      Expanded(
                        child: Text(
                          t(destination.labelKey),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: foreground,
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (selected)
            Positioned(
              left: -12,
              top: 0,
              bottom: 0,
              child: Center(
                child: Container(
                  width: 3,
                  height: 18,
                  decoration: const BoxDecoration(
                    color: AppColors.accent,
                    borderRadius: BorderRadius.horizontal(
                      right: Radius.circular(3),
                    ),
                    boxShadow: [
                      BoxShadow(color: AppColors.accent, blurRadius: 10),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _DrawerFooter extends StatelessWidget {
  const _DrawerFooter({required this.serverLabel, required this.onExit});

  final String serverLabel;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: _SettingsNavColors.bg,
        border: Border(top: BorderSide(color: _SettingsNavColors.line)),
      ),
      child: Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: Row(
                children: [
                  const Icon(
                    Icons.dns_outlined,
                    size: 16,
                    color: _SettingsNavColors.faint,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      serverLabel,
                      key: const ValueKey('settings-nav-server-host'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: _SettingsNavColors.text,
                        fontSize: 11,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Semantics(
              key: const ValueKey('settings-nav-exit'),
              button: true,
              label: t('overview'),
              child: Material(
                color: _SettingsNavColors.panel,
                shape: RoundedRectangleBorder(
                  side: const BorderSide(color: _SettingsNavColors.line),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: InkWell(
                  excludeFromSemantics: true,
                  borderRadius: BorderRadius.circular(9),
                  onTap: onExit,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 44),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.home_outlined,
                            color: _SettingsNavColors.muted,
                            size: 17,
                          ),
                          const SizedBox(width: 9),
                          Expanded(
                            child: Text(
                              t('overview'),
                              style: const TextStyle(
                                color: _SettingsNavColors.muted,
                                fontSize: 12,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ),
                          const Icon(
                            Icons.chevron_right_rounded,
                            color: _SettingsNavColors.faint,
                            size: 18,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
