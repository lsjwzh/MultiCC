import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../services/air_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';
import 'air_panels.dart';
import 'air_task_config.dart';

/// 侧栏那颗「＋ 新任务」开的东西 —— Web 侧是 `public/air.html` 的
/// `#quick-task-dialog`。
///
/// 它自己**不带表单**。里面装的就是目录首页那一个统一输入框模块
/// （[AirQuickComposer]）：AI 配置（CLI / 线路 / 模型 / 推理强度）和角色都在那
/// 一套胶囊里，写完一段话就创建并执行。Web 那边更直白 —— 打开时把同一个 DOM
/// 节点 `#quick-task-form` 搬进弹窗，关掉再搬回 `#empty`；这里同理，是同一个
/// 组件的另一个实例，不是第二份实现。
///
/// [onSubmit] 交回宿主（`_createFromComposer`：建任务 → 绑角色 → 发第一条消息）。
/// 它返回真值这一层就收起来，返回假值就留着 —— 让用户改完接着点。
Future<void> showAirNewTaskSheet(
  BuildContext context, {
  required String directoryPath,
  required SettingsService settings,
  required List<String> clis,
  required AirComposerSubmit onSubmit,
  AirService? service,
  http.Client? httpClient,
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
    builder: (_) => _AirNewTaskSheet(
      directoryPath: directoryPath,
      settings: settings,
      clis: clis,
      onSubmit: onSubmit,
      service: service,
      httpClient: httpClient,
    ),
  );
}

class _AirNewTaskSheet extends StatefulWidget {
  const _AirNewTaskSheet({
    required this.directoryPath,
    required this.settings,
    required this.clis,
    required this.onSubmit,
    required this.service,
    required this.httpClient,
  });

  final String directoryPath;
  final SettingsService settings;
  final List<String> clis;
  final AirComposerSubmit onSubmit;
  final AirService? service;
  final http.Client? httpClient;

  @override
  State<_AirNewTaskSheet> createState() => _AirNewTaskSheetState();
}

class _AirNewTaskSheetState extends State<_AirNewTaskSheet> {
  /// 这一层自己管「正在创建」。宿主的 `_submitting` 传不进来 —— 弹层是另一条
  /// 路由，那个 State `setState` 重建不到这里 —— 而输入框那颗按钮的文案
  /// （「正在创建…」）和禁用态看的就是这个值。
  bool _submitting = false;

  Future<bool> _submit({
    required String text,
    required String cli,
    required AirTaskRuntime runtime,
    required List<AirRoleBinding> roles,
    required bool goal,
    int? goalRounds,
    int? goalBudget,
  }) async {
    setState(() => _submitting = true);
    final landed = await widget.onSubmit(
      text: text,
      cli: cli,
      runtime: runtime,
      roles: roles,
      goal: goal,
      goalRounds: goalRounds,
      goalBudget: goalBudget,
    );
    if (!mounted) return landed;
    setState(() => _submitting = false);
    // 人已经被带进那个任务了 —— 就地收掉，别压在聊天页上面。没成的话留着：
    // 草稿还在输入框里，重试就是原样再点一次。
    if (landed) Navigator.of(context).pop();
    return landed;
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      // 键盘弹起来时整层跟着抬上去 —— 不然写到后面几行就被盖住了（Web 那边
      // 弹窗居中，键盘顶上来同样会把下半张挡住）。
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
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
              const SizedBox(height: 10),
              _head(),
              // 建在哪个目录上 —— Web 的 `#quick-task-dialog-directory` 就是这句。
              // 弹层里没有选目录的控件，因为入口本来就是从某个目录点进来的。
              Text(
                widget.directoryPath,
                key: const ValueKey('air-new-task-directory'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.blue, fontSize: 11.5),
              ),
              const SizedBox(height: 12),
              AirQuickComposer(
                key: const ValueKey('air-new-task-composer'),
                settings: widget.settings,
                service: widget.service,
                httpClient: widget.httpClient,
                clis: widget.clis,
                busy: _submitting,
                autofocus: true,
                onSubmit: _submit,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _head() => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'NEW TASK',
              style: TextStyle(
                color: AppColors.faint,
                fontSize: 10,
                letterSpacing: 0.8,
              ),
            ),
            SizedBox(height: 2),
            Text(
              '新任务',
              style: TextStyle(
                color: AppColors.text,
                fontSize: 16,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
      IconButton(
        key: const ValueKey('air-new-task-close'),
        onPressed: _submitting ? null : () => Navigator.of(context).pop(),
        iconSize: 20,
        tooltip: '关闭',
        icon: const Icon(Icons.close_rounded, color: AppColors.muted),
      ),
    ],
  );
}
