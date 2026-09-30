import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../services/air_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';
import 'air_schedules.dart';

/// 目录首页那颗「定时任务」开的东西 —— Web 那边是 `public/air-dir-schedules.js`。
///
/// 侧栏那颗是**全局**中心：它回答「这台机器上排了哪些活」。这一层回答的是另一个
/// 问题 —— 「我正看着的**这个**目录排了哪些活」。两者不是两份数据，也不是第二份
/// 实现：里面装的就是定时任务中心那一个 [AirSchedulePanel]，只多带一个 `directoryId`
/// 过滤（同 Web 那边按地址栏的 `?dir=` 过滤）。
///
/// 摆法是移动那套：从底部升起来的一张板子（同 `showAirNewTaskSheet`），头（标题 +
/// 条数）和脚（新建 / 全部定时任务）钉住不动，中间那张清单自己滚 —— 拇指不用先滚
/// 到底才够得着那两颗按钮。
Future<void> showAirDirectorySchedules(
  BuildContext context, {
  required AirDirectory directory,
  required SettingsService settings,
  required List<AirDirectory> directories,
  http.Client? httpClient,
  void Function(String dirId, String taskId)? onOpenTask,
  VoidCallback? onOpenAll,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(AppColors.radiusPanel),
      ),
    ),
    builder: (_) => _AirDirectorySchedulesSheet(
      directory: directory,
      settings: settings,
      directories: directories,
      httpClient: httpClient,
      onOpenTask: onOpenTask,
      onOpenAll: onOpenAll,
    ),
  );
}

class _AirDirectorySchedulesSheet extends StatefulWidget {
  const _AirDirectorySchedulesSheet({
    required this.directory,
    required this.settings,
    required this.directories,
    required this.httpClient,
    required this.onOpenTask,
    required this.onOpenAll,
  });

  final AirDirectory directory;
  final SettingsService settings;
  final List<AirDirectory> directories;
  final http.Client? httpClient;
  final void Function(String dirId, String taskId)? onOpenTask;
  final VoidCallback? onOpenAll;

  @override
  State<_AirDirectorySchedulesSheet> createState() =>
      _AirDirectorySchedulesSheetState();
}

class _AirDirectorySchedulesSheetState
    extends State<_AirDirectorySchedulesSheet> {
  final GlobalKey<AirSchedulePanelState> _panel =
      GlobalKey<AirSchedulePanelState>();

  /// 这一层自己的状态行。
  ///
  /// 面板的动作结果是往 SnackBar 说的，可 SnackBar 落在弹层**背后** —— 等于没说。
  /// 所以这层把那些话接过来，画在标题下面那一行（Web 那边弹层的 `#dir-schedule-status`
  /// 就是干这个的）。取数失败另有面板里那张红卡，不走这里。
  String _status = '';

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    // 上限量的是**看得见**的那一段（键盘占掉的那块不算），同 Web 那边弹层的
    // `max-height: 88dvh` —— 顶上始终留着背后那一页，别长成一整页。
    final visible = media.size.height - media.viewInsets.bottom;
    return Padding(
      // 键盘弹起时整层跟着抬上去，不然下半张被盖住。
      padding: EdgeInsets.only(bottom: media.viewInsets.bottom),
      child: SafeArea(
        top: false,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: visible * 0.88),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 8),
              Center(
                child: Container(
                  width: 38,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppColors.line,
                    borderRadius: BorderRadius.circular(AppColors.radiusPill),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              _head(),
              if (_status.isNotEmpty) _statusLine(),
              Flexible(
                child: SingleChildScrollView(
                  child: AirSchedulePanel(
                    key: _panel,
                    settings: widget.settings,
                    httpClient: widget.httpClient,
                    directories: widget.directories,
                    initialDirectoryId: widget.directory.id,
                    directoryId: widget.directory.id,
                    onNotice: (text) {
                      if (mounted) setState(() => _status = text);
                    },
                    onOpenTask: (dirId, taskId) {
                      // 先进那条任务：弹层留着会压在聊天页上面。
                      Navigator.of(context).pop();
                      widget.onOpenTask?.call(dirId, taskId);
                    },
                    shrinkWrap: true,
                    padding: const EdgeInsets.fromLTRB(14, 2, 14, 14),
                    emptyTitle: '这个目录还没有定时任务',
                    emptyHint: '新建的规则会绑到这个目录里的固定 Air 任务上，到点把指令送进去继续跑。',
                  ),
                ),
              ),
              _foot(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _head() => Padding(
    padding: const EdgeInsets.fromLTRB(16, 0, 6, 0),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'SCHEDULED TASKS',
                style: TextStyle(
                  color: AppColors.faint,
                  fontSize: 9.5,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.1,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                '${widget.directory.name} 的定时任务',
                key: const ValueKey('air-dir-schedule-title'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
        IconButton(
          key: const ValueKey('air-dir-schedule-refresh'),
          onPressed: () => unawaited(_panel.currentState?.reload()),
          icon: const Icon(Icons.refresh_rounded, size: 20),
          color: AppColors.muted,
          tooltip: '刷新',
        ),
        IconButton(
          key: const ValueKey('air-dir-schedule-close'),
          onPressed: () => Navigator.of(context).pop(),
          icon: const Icon(Icons.close_rounded, size: 20),
          color: AppColors.muted,
          tooltip: '关闭',
        ),
      ],
    ),
  );

  Widget _statusLine() => Padding(
    padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.info_outline_rounded, size: 15, color: AppColors.blue),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            _status,
            key: const ValueKey('air-dir-schedule-status'),
            style: const TextStyle(
              color: AppColors.blue,
              fontSize: 11.5,
              height: 1.5,
            ),
          ),
        ),
      ],
    ),
  );

  /// 脚上两颗：在这儿新建一条（就着这个目录），和回到全局那张表。
  Widget _foot() => Padding(
    padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
    child: Row(
      children: [
        Expanded(
          child: FilledButton.icon(
            key: const ValueKey('air-dir-schedule-new'),
            onPressed: () => unawaited(_panel.currentState?.openEditor()),
            style: FilledButton.styleFrom(
              backgroundColor: AppColors.accentDark,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(AppColors.radiusButton),
              ),
            ),
            icon: const Icon(Icons.add_rounded, size: 18),
            label: const Text('新建定时任务'),
          ),
        ),
        const SizedBox(width: 6),
        TextButton(
          key: const ValueKey('air-dir-schedule-center'),
          onPressed: () {
            Navigator.of(context).pop();
            widget.onOpenAll?.call();
          },
          child: const Text(
            '全部定时任务 ›',
            style: TextStyle(color: AppColors.muted, fontSize: 12.5),
          ),
        ),
      ],
    ),
  );
}
