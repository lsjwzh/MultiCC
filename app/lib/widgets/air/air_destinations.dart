import 'package:flutter/material.dart';

import '../../i18n.dart';
import '../../theme.dart';
import '../workspace_navigation_drawer.dart';

/// 全部功能：老首页抽屉里那 14 个目的地。
///
/// Air 侧栏只摆常用的几个（控制台、定时任务、目录、任务），其余的收在这里 ——
/// 侧栏变窄不该让任何一个页面变成打不开。分组沿用老抽屉的两组，顺序也一样，
/// 换的只是摆放的位置。
class AirAllDestinations extends StatelessWidget {
  const AirAllDestinations({
    super.key,
    required this.onSelected,
    required this.onOpenVoiceCall,
    this.cronCount,
  });

  final ValueChanged<WorkspaceDestination> onSelected;

  /// 机器级语音入口。它是原生独占的（麦克风要 HTTPS），Web 侧没有对应页面，
  /// 所以单独作为一行而不是一个 [WorkspaceDestination]。
  final VoidCallback onOpenVoiceCall;

  final int? cronCount;

  /// 「概览」就是当前这一页，不再列一遍。
  static const _settings = <WorkspaceDestination>[
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

  /// 这一页不自己 pop：选完之后去哪儿由宿主决定（老抽屉是自己 pop 再回调，
  /// 因为它只是首页的一层；这里是一条路由，pop 出去要带上选了什么）。
  void _select(WorkspaceDestination destination) => onSelected(destination);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        backgroundColor: AppColors.panel,
        foregroundColor: AppColors.text,
        elevation: 0,
        title: const Text('全部功能'),
      ),
      body: ListView(
        key: const ValueKey('air-all-destinations'),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
        children: [
          const _GroupLabel('工作区'),
          for (final destination in const [
            WorkspaceDestination.cron,
            WorkspaceDestination.memory,
            WorkspaceDestination.docs,
          ])
            _Row(
              semanticKey: 'air-dest-${destination.name}',
              icon: destination.icon,
              label: t(destination.labelKey),
              badge: destination == WorkspaceDestination.cron
                  ? ((cronCount ?? 0) > 0 ? '$cronCount' : null)
                  : null,
              onTap: () => _select(destination),
            ),
          const SizedBox(height: 14),
          const _GroupLabel('设置与服务器'),
          for (final destination in _settings)
            _Row(
              semanticKey: 'air-dest-${destination.name}',
              icon: destination.icon,
              label: t(destination.labelKey),
              onTap: () => _select(destination),
            ),
          const SizedBox(height: 20),
          const _GroupLabel('仅本机可用'),
          // 这四件事 Web 侧做不了，App 是它们唯一的入口 —— 列在这里是为了让
          // 「从哪儿进」有个明确答案，不是把它们降级成说明文字。
          _NativeRow(
            semanticKey: 'air-native-voice-call',
            icon: Icons.mic_rounded,
            title: '语音通话（BETA）',
            why: '麦克风需要 HTTPS，Tailscale Funnel 已指向本机服务。',
            action: '开始通话',
            onTap: onOpenVoiceCall,
          ),
          const _NativeNote(
            icon: Icons.folder_open_rounded,
            title: '文件浏览',
            why: '直接读本机工作目录，Web 只能传文件。',
            where: '任意任务 → 对话页右上角',
          ),
          const _NativeNote(
            icon: Icons.wifi_tethering_rounded,
            title: '局域网发现',
            why: 'NSD/mDNS 只有在同一网段的主机上才扫得到，浏览器没有这个能力。',
            where: '设置中心 → 服务器地址 → 搜索局域网服务',
          ),
          const _NativeNote(
            icon: Icons.notifications_active_outlined,
            title: '原生通知与后台常驻',
            why: '由系统推送通道送达，App 退到后台后任务仍在跑。',
            where: '设置中心 → 推送通知',
          ),
        ],
      ),
    );
  }
}

class _GroupLabel extends StatelessWidget {
  const _GroupLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 6, 4, 8),
    child: Text(
      text,
      style: const TextStyle(
        color: AppColors.faint,
        fontSize: 11.5,
        letterSpacing: 0.8,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

class _Row extends StatelessWidget {
  const _Row({
    required this.semanticKey,
    required this.icon,
    required this.label,
    required this.onTap,
    this.badge,
  });

  final String semanticKey;
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final String? badge;

  @override
  Widget build(BuildContext context) => Semantics(
    key: ValueKey(semanticKey),
    button: true,
    label: label,
    child: Material(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 13, 12, 13),
          child: Row(
            children: [
              Icon(icon, size: 19, color: AppColors.muted),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(color: AppColors.text, fontSize: 14),
                ),
              ),
              if (badge != null)
                Container(
                  margin: const EdgeInsets.only(right: 8),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 7,
                    vertical: 1,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.blueSoft,
                    borderRadius: BorderRadius.circular(AppColors.radiusPill),
                  ),
                  child: Text(
                    badge!,
                    style: const TextStyle(
                      color: AppColors.blue,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              const Icon(
                Icons.chevron_right_rounded,
                size: 18,
                color: AppColors.faint,
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class _NativeRow extends StatelessWidget {
  const _NativeRow({
    required this.semanticKey,
    required this.icon,
    required this.title,
    required this.why,
    required this.action,
    required this.onTap,
  });

  final String semanticKey;
  final IconData icon;
  final String title;
  final String why;
  final String action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 8),
    decoration: BoxDecoration(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      border: Border.all(color: AppColors.line),
    ),
    padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 19, color: AppColors.muted),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                why,
                style: const TextStyle(
                  color: AppColors.faint,
                  fontSize: 11.5,
                  height: 1.6,
                ),
              ),
            ],
          ),
        ),
        TextButton(
          key: ValueKey(semanticKey),
          onPressed: onTap,
          child: Text(action),
        ),
      ],
    ),
  );
}

class _NativeNote extends StatelessWidget {
  const _NativeNote({
    required this.icon,
    required this.title,
    required this.why,
    required this.where,
  });

  final IconData icon;
  final String title;
  final String why;
  final String where;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 8),
    decoration: BoxDecoration(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      border: Border.all(color: AppColors.line),
    ),
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 19, color: AppColors.muted),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                why,
                style: const TextStyle(
                  color: AppColors.faint,
                  fontSize: 11.5,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                '入口：$where',
                style: const TextStyle(color: AppColors.muted, fontSize: 11.5),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}
