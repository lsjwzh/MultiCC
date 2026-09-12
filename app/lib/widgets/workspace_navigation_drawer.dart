import 'package:flutter/material.dart';

import '../i18n.dart';
import '../theme.dart';

/// The App home navigation mirrors the two groups in web/manage:
/// Workspace first, followed by server and App settings destinations.
enum WorkspaceDestination {
  overview,
  cron,
  memory,
  docs,
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

extension WorkspaceDestinationPresentation on WorkspaceDestination {
  String get labelKey => switch (this) {
    WorkspaceDestination.overview => 'overview',
    WorkspaceDestination.cron => 'cronTasks',
    WorkspaceDestination.memory => 'memoryGraph',
    WorkspaceDestination.docs => 'docsServices',
    WorkspaceDestination.voice => 'voiceSettings',
    WorkspaceDestination.goal => 'goalPrecheck',
    WorkspaceDestination.provider => 'providerConfig',
    WorkspaceDestination.global => 'globalConfig',
    WorkspaceDestination.push => 'pushNotifications',
    WorkspaceDestination.tunnel => 'tunnel',
    WorkspaceDestination.bridges => 'messageBridges',
    WorkspaceDestination.resources => 'agentResources',
    WorkspaceDestination.skillSync => 'skillSync',
    WorkspaceDestination.storage => 'temporaryUploads',
  };

  IconData get icon => switch (this) {
    WorkspaceDestination.overview => Icons.dashboard_outlined,
    WorkspaceDestination.cron => Icons.schedule_rounded,
    WorkspaceDestination.memory => Icons.hub_outlined,
    WorkspaceDestination.docs => Icons.travel_explore_outlined,
    WorkspaceDestination.voice => Icons.mic_none_rounded,
    WorkspaceDestination.goal => Icons.track_changes_rounded,
    WorkspaceDestination.provider => Icons.swap_horiz_rounded,
    WorkspaceDestination.global => Icons.settings_outlined,
    WorkspaceDestination.push => Icons.notifications_none_rounded,
    WorkspaceDestination.tunnel => Icons.public_rounded,
    WorkspaceDestination.bridges => Icons.device_hub_outlined,
    WorkspaceDestination.resources => Icons.inventory_2_outlined,
    WorkspaceDestination.skillSync => Icons.sync_rounded,
    WorkspaceDestination.storage => Icons.storage_outlined,
  };
}

/// Navigation drawer owned by the App workspace/home screen.
///
/// Like the web sidebar, only the destination list scrolls; the brand and
/// connected-server footer remain reachable on short phones.
class WorkspaceNavigationDrawer extends StatelessWidget {
  const WorkspaceNavigationDrawer({
    super.key,
    required this.selected,
    required this.serverLabel,
    required this.onSelected,
    this.workspaceCount,
    this.cronCount,
    this.advancedMode = true,
    this.onAdvancedModeChanged,
  });

  static const double width = 236;

  final WorkspaceDestination selected;
  final String serverLabel;
  final ValueChanged<WorkspaceDestination> onSelected;
  final int? workspaceCount;
  final int? cronCount;
  final bool advancedMode;
  final ValueChanged<bool>? onAdvancedModeChanged;

  static const workspaceDestinations = <WorkspaceDestination>[
    WorkspaceDestination.overview,
    WorkspaceDestination.cron,
    WorkspaceDestination.memory,
    WorkspaceDestination.docs,
  ];

  static const settingsDestinations = <WorkspaceDestination>[
    WorkspaceDestination.voice,
    WorkspaceDestination.goal,
    WorkspaceDestination.provider,
    WorkspaceDestination.global,
    WorkspaceDestination.push,
    WorkspaceDestination.tunnel,
    WorkspaceDestination.bridges,
    WorkspaceDestination.resources,
    WorkspaceDestination.skillSync,
    WorkspaceDestination.storage,
  ];

  int? _badgeFor(WorkspaceDestination destination) => switch (destination) {
    WorkspaceDestination.overview => workspaceCount,
    WorkspaceDestination.cron => cronCount,
    _ => null,
  };

  void _select(BuildContext context, WorkspaceDestination destination) {
    final navigator = Navigator.of(context);
    navigator.pop();
    if (destination == selected) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      onSelected(destination);
    });
  }

  @override
  Widget build(BuildContext context) {
    final visibleWorkspaceDestinations = advancedMode
        ? workspaceDestinations
        : <WorkspaceDestination>[
            WorkspaceDestination.overview,
            if ((cronCount ?? 0) > 0) WorkspaceDestination.cron,
          ];
    final visibleSettingsDestinations = advancedMode
        ? settingsDestinations
        : const <WorkspaceDestination>[WorkspaceDestination.global];
    return Drawer(
      width: width,
      elevation: 0,
      backgroundColor: AppColors.bg,
      shape: const Border(right: BorderSide(color: AppColors.line)),
      child: DecoratedBox(
        // The Air sidebar (public/air.css `#sidebar`) is a soft blue-white wash
        // rather than a flat fill: linear-gradient(145deg, #f8fbff, #e8f1fb).
        // The drawer used to paint a 5% white glow here, which vanished once
        // the surface went light — same shape, the right end of the ramp.
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [AppColors.bgSoft, Color(0xFFe8f1fb)],
          ),
        ),
        child: SafeArea(
          minimum: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 16, 12, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _Brand(
                  onTap: () => _select(context, WorkspaceDestination.overview),
                ),
                Expanded(
                  child: SingleChildScrollView(
                    key: const ValueKey('workspace-nav-scroll'),
                    physics: const ClampingScrollPhysics(),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _GroupLabel(text: t('workspace')),
                        for (final destination in visibleWorkspaceDestinations)
                          _DestinationTile(
                            destination: destination,
                            selected: destination == selected,
                            badge: _badgeFor(destination),
                            onTap: () => _select(context, destination),
                          ),
                        _GroupLabel(text: t('settingsTitle')),
                        for (final destination in visibleSettingsDestinations)
                          _DestinationTile(
                            destination: destination,
                            selected: destination == selected,
                            onTap: () => _select(context, destination),
                          ),
                        _ExperienceModeToggle(
                          advanced: advancedMode,
                          onChanged: onAdvancedModeChanged,
                        ),
                      ],
                    ),
                  ),
                ),
                _ServerFooter(serverLabel: serverLabel),
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
      key: const ValueKey('workspace-nav-brand'),
      button: true,
      label: 'MultiCC ${t('overview')}',
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
                      colors: [AppColors.accent, Color(0xFF137780)],
                    ),
                    borderRadius: BorderRadius.circular(9),
                    border: Border.all(color: const Color(0x4D1678e8)),
                    boxShadow: const [
                      BoxShadow(
                        color: Color(0x401678e8),
                        blurRadius: 18,
                        offset: Offset(0, 6),
                      ),
                    ],
                  ),
                  child: const Text(
                    'M',
                    style: TextStyle(
                      color: Color(0xFFffffff),
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text.rich(
                        TextSpan(
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
                        style: TextStyle(
                          color: AppColors.text,
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.3,
                        ),
                      ),
                      Text(
                        'dashboard',
                        style: TextStyle(color: AppColors.faint, fontSize: 10),
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
        key: ValueKey('workspace-nav-group-$text'),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          color: AppColors.faint,
          fontSize: 10,
          fontWeight: FontWeight.w600,
          letterSpacing: 1.4,
        ),
      ),
    );
  }
}

class _ExperienceModeToggle extends StatelessWidget {
  const _ExperienceModeToggle({
    required this.advanced,
    required this.onChanged,
  });

  final bool advanced;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      key: const ValueKey('workspace-nav-advanced-mode'),
      toggled: advanced,
      label: t('developerOptions'),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 52),
        child: Row(
          children: [
            const SizedBox(width: 10),
            const SizedBox(
              width: 17,
              child: Icon(
                Icons.tune_rounded,
                color: AppColors.muted,
                size: 18,
              ),
            ),
            const SizedBox(width: 11),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    t('developerOptions'),
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  Text(
                    t('developerOptionsHint'),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 9.5,
                      height: 1.2,
                    ),
                  ),
                ],
              ),
            ),
            Switch.adaptive(
              value: advanced,
              onChanged: onChanged,
              activeTrackColor: AppColors.accent.withValues(alpha: 0.55),
              activeColor: AppColors.accent,
            ),
          ],
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
    this.badge,
  });

  final WorkspaceDestination destination;
  final bool selected;
  final VoidCallback onTap;
  final int? badge;

  @override
  Widget build(BuildContext context) {
    final foreground = selected ? AppColors.text : AppColors.muted;
    return Semantics(
      key: ValueKey('workspace-nav-${destination.name}'),
      button: true,
      selected: selected,
      label: t(destination.labelKey),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Material(
            color: selected ? const Color(0x241678e8) : Colors.transparent,
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
                      if (badge != null)
                        Container(
                          margin: const EdgeInsets.only(left: 6),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 7,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            // A 7% white pill is invisible on the light drawer;
                            // unselected counts take the hairline neutral and
                            // selected ones keep the accent tint.
                            color: selected
                                ? const Color(0x381678e8)
                                : AppColors.line,
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Text(
                            '$badge',
                            style: TextStyle(
                              color: selected
                                  ? AppColors.accent
                                  : AppColors.muted,
                              fontSize: 10,
                              fontFamily: 'monospace',
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

class _ServerFooter extends StatelessWidget {
  const _ServerFooter({required this.serverLabel});

  final String serverLabel;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      // Transparent so the drawer's wash runs behind the footer instead of
      // stopping at a lighter flat band; the hairline keeps the seam.
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: AppColors.line)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
        child: Row(
          key: const ValueKey('workspace-nav-server'),
          children: [
            Container(
              width: 7,
              height: 7,
              decoration: const BoxDecoration(
                color: AppColors.accent,
                shape: BoxShape.circle,
                boxShadow: [BoxShadow(color: AppColors.accent, blurRadius: 7)],
              ),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                serverLabel,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 11,
                  fontFamily: 'monospace',
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
