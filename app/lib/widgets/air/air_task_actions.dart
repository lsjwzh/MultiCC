import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../theme.dart';

/// 列表、详情与聊天菜单共用的一次性删除流程。这里集中维护确认文案、请求和错误
/// 呈现；调用处只负责在成功后刷新列表或退出已经被删除的任务。
Future<bool> deleteAirTaskWithConfirmation({
  required BuildContext context,
  required AirService service,
  required String taskId,
  required String title,
  String keyPrefix = 'air-task',
  ValueChanged<Object>? onError,
}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      key: ValueKey('$keyPrefix-delete-confirm'),
      title: Text('删除任务「$title」？'),
      content: const Text('它的专属会话与工作区会一并删除；有未提交改动或未合并提交时会被拒绝。此操作不可撤销。'),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: const Text('取消'),
        ),
        TextButton(
          key: ValueKey('$keyPrefix-delete-confirm-ok'),
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: const Text('删除', style: TextStyle(color: AppColors.danger)),
        ),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return false;
  try {
    await service.deleteTask(taskId);
  } catch (error) {
    if (onError != null) {
      onError(error);
    } else if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('$error')));
    }
    return false;
  }
  if (context.mounted) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('任务已删除。')));
  }
  return true;
}

/// 任务行行尾的一枚操作图标（当前目录列表的 Pin / 详情 / 删除，控制台的删除）。
///
/// 尺寸只在这里定义：`IconButton` 默认会被 `MaterialTapTargetSize.padded` 撑到
/// 48px，三个并排就是 144px —— 390px 的手机上超过任务行宽度的三分之一，而那一截
/// 本来该是标题的。42px 比 Material 的 48px 目标略小（仍是拇指点得中的尺寸），
/// 换来的是标题多出一整行的读字量。
class AirTaskRowAction extends StatelessWidget {
  const AirTaskRowAction({
    super.key,
    required this.tooltip,
    required this.icon,
    this.onPressed,
  });

  /// 一行里这类按钮的统一边长。
  static const double size = 42;

  final String tooltip;
  final Widget icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => IconButton(
    onPressed: onPressed,
    tooltip: tooltip,
    iconSize: 18,
    padding: EdgeInsets.zero,
    style: IconButton.styleFrom(
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      minimumSize: const Size(size, size),
      maximumSize: const Size(size, size),
    ),
    icon: icon,
  );
}
