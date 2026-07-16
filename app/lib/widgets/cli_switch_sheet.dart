import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/message.dart';
import '../providers/session_manager.dart';
import '../theme.dart';
import '../utils/session_status_helpers.dart';

class CliSwitchRequest {
  final SessionCli cli;
  final bool fresh;

  const CliSwitchRequest({required this.cli, required this.fresh});
}

class CliSwitchSheet extends StatefulWidget {
  final SessionCliConfig config;

  const CliSwitchSheet({super.key, required this.config});

  @override
  State<CliSwitchSheet> createState() => _CliSwitchSheetState();
}

class _CliSwitchSheetState extends State<CliSwitchSheet> {
  late SessionCli _target;
  bool _fresh = false;

  @override
  void initState() {
    super.initState();
    _target = widget.config.cli;
  }

  bool _available(SessionCli cli) => widget.config.cliAvailability[cli] ?? cli == widget.config.cli;

  String _description(SessionCli cli) {
    if (!_available(cli)) return '未安装或不可执行';
    if (cli == widget.config.cli) return '当前使用';
    if (widget.config.cliStates[cli]?.hasNativeSession == true) {
      return '可恢复上次原生会话，并接收本次上下文交接';
    }
    return '将创建新的原生会话，并接收当前任务信息';
  }

  @override
  Widget build(BuildContext context) {
    final canSubmit = _available(_target) && (_target != widget.config.cli || _fresh);
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.only(
          left: 18,
          right: 18,
          top: 16,
          bottom: 18 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              '切换会话 CLI',
              style: TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            const Text(
              '每个 CLI 保留自己的原生会话；切换时通过结构化检查点交接当前任务。',
              style: TextStyle(color: AppColors.muted, fontSize: 12, height: 1.45),
            ),
            const SizedBox(height: 14),
            ...SessionCli.values.map(_option),
            const SizedBox(height: 6),
            CheckboxListTile(
              key: const Key('cli-switch-fresh'),
              value: _fresh,
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: const Text(
                '重新开始目标 CLI 对话',
                style: TextStyle(color: AppColors.text, fontSize: 13),
              ),
              subtitle: const Text(
                '忽略该 CLI 已保存的原生会话，但仍会交接当前任务和最近消息。',
                style: TextStyle(color: AppColors.muted, fontSize: 11),
              ),
              onChanged: (value) => setState(() => _fresh = value == true),
            ),
            const Padding(
              padding: EdgeInsets.only(top: 4, bottom: 14),
              child: Text(
                '请在当前回复结束后切换。运行中切换会被服务端拒绝。',
                style: TextStyle(color: Color(0xFFe3b341), fontSize: 12),
              ),
            ),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
                const SizedBox(width: 8),
                FilledButton.icon(
                  key: const Key('cli-switch-submit'),
                  onPressed: canSubmit
                      ? () => Navigator.pop(context, CliSwitchRequest(cli: _target, fresh: _fresh))
                      : null,
                  icon: const Icon(Icons.swap_horiz_rounded, size: 17),
                  label: const Text('确认切换'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _option(SessionCli cli) {
    final available = _available(cli);
    final selected = cli == _target;
    final color = cliBrandColor(cli);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        key: Key('cli-switch-option-${cli.name}'),
        onTap: available ? () => setState(() => _target = cli) : null,
        borderRadius: BorderRadius.circular(6),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: selected ? color.withValues(alpha: 0.10) : const Color(0xFF0b0d10),
            border: Border.all(
              color: selected ? color.withValues(alpha: 0.65) : const Color(0xFF20242b),
            ),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            children: [
              Radio<SessionCli>(
                value: cli,
                groupValue: _target,
                onChanged: available ? (value) => setState(() => _target = value ?? _target) : null,
                activeColor: color,
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      cli.displayName,
                      style: TextStyle(
                        color: available ? AppColors.text : AppColors.faint,
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _description(cli),
                      style: TextStyle(
                        color: available ? AppColors.muted : AppColors.faint,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

Future<void> openCliSwitchSheet(BuildContext context, {required String sessionId}) async {
  final manager = context.read<SessionManager>();
  final messenger = ScaffoldMessenger.of(context);
  SessionCliConfig config;
  try {
    config = await manager.fetchSessionCliConfig(sessionId);
  } catch (error) {
    messenger.showSnackBar(SnackBar(content: Text('读取 CLI 状态失败：$error')));
    return;
  }
  if (!context.mounted) return;

  final request = await showModalBottomSheet<CliSwitchRequest>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(12)),
    ),
    builder: (_) => CliSwitchSheet(config: config),
  );
  if (request == null || !context.mounted) return;

  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text('正在切换到 ${request.cli.displayName}…')));
  try {
    final result = await manager.switchSessionCli(sessionId, request.cli, fresh: request.fresh);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(
            result.reusedTarget
                ? '已切换到 ${result.cli.displayName}，并恢复该 CLI 的原会话'
                : '已切换到 ${result.cli.displayName}，下一条消息会接收上下文交接',
          ),
        ),
      );
  } catch (error) {
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text('CLI 切换失败：$error')));
  }
}
