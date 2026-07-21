import 'dart:async';

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

/// Per-CLI install progress tracked inside the switch sheet. [phase] is one of
/// `installing` / `done` / `error`; [timer] drives the 2s status poll and is
/// cancelled on a terminal phase or in [State.dispose].
class _CliInstallState {
  final String jobId;
  final String phase;
  final String? error;
  Timer? timer;

  _CliInstallState({required this.jobId, required this.phase, this.error});
}

class CliSwitchSheet extends StatefulWidget {
  final SessionCliConfig config;
  final Map<String, dynamic>? specs;
  final String? sessionId;

  const CliSwitchSheet({
    super.key,
    required this.config,
    this.specs,
    this.sessionId,
  });

  @override
  State<CliSwitchSheet> createState() => _CliSwitchSheetState();
}

class _CliSwitchSheetState extends State<CliSwitchSheet> {
  late SessionCli _target;
  bool _fresh = false;

  /// Mutable copy of [widget.config] so a finished install can refresh the
  /// availability map in place without rebuilding the sheet from the caller.
  late SessionCliConfig _config;

  /// Per-CLI install state. Absent = no install attempt for this CLI yet.
  final Map<SessionCli, _CliInstallState> _installs = {};

  @override
  void initState() {
    super.initState();
    _target = widget.config.cli;
    _config = widget.config;
  }

  bool _available(SessionCli cli) =>
      _config.cliAvailability[cli] ?? cli == _config.cli;

  Map<String, dynamic>? _specFor(SessionCli cli) {
    final specs = widget.specs;
    if (specs == null) return null;
    final s = specs[cli.name];
    return s is Map<String, dynamic> ? s : null;
  }

  String _description(SessionCli cli) {
    final install = _installs[cli];
    if (install != null) {
      if (install.phase == 'installing') return '正在安装…(通常1-2分钟)';
      if (install.phase == 'done') return '安装完成, 可切换';
      if (install.phase == 'error') return install.error ?? '安装失败';
    }
    if (!_available(cli)) {
      final spec = _specFor(cli);
      // auto!=true -> show the manual instructions; otherwise keep the default.
      if (spec != null && spec['auto'] != true) {
        final manual = spec['manual'];
        if (manual is String && manual.isNotEmpty) return manual;
      }
      return '未安装或不可执行';
    }
    if (cli == _config.cli) return '当前使用';
    if (_config.cliStates[cli]?.hasNativeSession == true) {
      return '可恢复上次原生会话，并接收本次上下文交接';
    }
    return '将创建新的原生会话，并接收当前任务信息';
  }

  Color _descriptionColor(SessionCli cli, bool available) {
    if (_installs[cli]?.phase == 'error') return AppColors.danger;
    return available ? AppColors.muted : AppColors.faint;
  }

  Widget? _trailing(SessionCli cli) {
    final install = _installs[cli];
    if (install != null) {
      if (install.phase == 'installing') {
        return const SizedBox(
          width: 16,
          height: 16,
          child: CircularProgressIndicator(strokeWidth: 2),
        );
      }
      if (install.phase == 'error') {
        return _installButton('重试', () => _startInstall(cli));
      }
      return null;
    }
    // Uninstalled + auto install supported -> show the install button.
    if (!_available(cli)) {
      final spec = _specFor(cli);
      if (spec != null && spec['auto'] == true) {
        return _installButton('安装', () => _startInstall(cli));
      }
    }
    return null;
  }

  Widget _installButton(String label, VoidCallback onPressed) {
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        minimumSize: const Size(40, 28),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      child: Text(label, style: const TextStyle(fontSize: 12)),
    );
  }

  // ── Install flow ──────────────────────────────────────────────────────────

  Future<void> _startInstall(SessionCli cli) async {
    // Refuse a duplicate trigger while this CLI is already installing.
    if (_installs[cli]?.phase == 'installing') return;
    _installs[cli]?.timer?.cancel();
    final manager = context.read<SessionManager>();
    final sessionId = widget.sessionId;
    setState(() {
      _installs[cli] = _CliInstallState(jobId: '', phase: 'installing');
    });
    try {
      final res = await manager.installCli(cli.name);
      if (!mounted) return;
      final jobId = res['jobId']?.toString();
      if (jobId != null && jobId.isNotEmpty) {
        // 202 started or 409 already-running: attach and poll.
        setState(() {
          _installs[cli] = _CliInstallState(jobId: jobId, phase: 'installing');
        });
        _pollInstall(cli, manager, sessionId);
        return;
      }
      // No jobId: 200 already-installed or 400 unsupported/manual.
      final statusCode = res['statusCode'];
      if (statusCode == 200 || res['alreadyInstalled'] == true) {
        await _finishInstall(cli, manager, sessionId);
      } else {
        final error = res['error']?.toString();
        setState(() {
          _installs[cli] = _CliInstallState(
            jobId: '',
            phase: 'error',
            error: error?.isNotEmpty == true ? error : '安装失败',
          );
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _installs[cli] = _CliInstallState(
          jobId: '',
          phase: 'error',
          error: '安装失败：$e',
        );
      });
    }
  }

  void _pollInstall(SessionCli cli, SessionManager manager, String? sessionId) {
    final install = _installs[cli];
    if (install == null || install.jobId.isEmpty) return;
    install.timer = Timer.periodic(const Duration(seconds: 2), (t) async {
      // Stop if the sheet is gone or a different install took over this CLI.
      if (!mounted || _installs[cli]?.jobId != install.jobId) {
        t.cancel();
        return;
      }
      try {
        final res = await manager.fetchCliInstallStatus(install.jobId);
        if (!mounted || _installs[cli]?.jobId != install.jobId) {
          t.cancel();
          return;
        }
        final job = res['job'];
        final status = job is Map ? job['status']?.toString() : null;
        if (status == 'done') {
          t.cancel();
          await _finishInstall(cli, manager, sessionId);
        } else if (status == 'error') {
          t.cancel();
          final error = job is Map ? job['error']?.toString() : null;
          setState(() {
            _installs[cli] = _CliInstallState(
              jobId: install.jobId,
              phase: 'error',
              error: error?.isNotEmpty == true ? error : '安装失败',
            );
          });
        }
        // status == 'running' (or unknown) -> keep polling.
      } catch (_) {
        // Transient network error: keep polling, don't abort the install.
      }
    });
  }

  Future<void> _finishInstall(
    SessionCli cli,
    SessionManager manager,
    String? sessionId,
  ) async {
    // Refresh config to pick up the new availability; on failure optimistically
    // mark this CLI available since the install job itself reported done.
    SessionCliConfig? fresh;
    if (sessionId != null && sessionId.isNotEmpty) {
      try {
        fresh = await manager.fetchSessionCliConfig(sessionId);
      } catch (_) {
        fresh = null;
      }
    }
    if (!mounted) return;
    setState(() {
      _config = fresh ?? _patchAvailability(_config, cli, true);
      _installs[cli] = _CliInstallState(
        jobId: _installs[cli]?.jobId ?? '',
        phase: 'done',
      );
    });
  }

  /// Optimistically mark [cli] available when the post-install config refresh
  /// failed but the install job itself reported done.
  SessionCliConfig _patchAvailability(
    SessionCliConfig cfg,
    SessionCli cli,
    bool available,
  ) {
    return SessionCliConfig(
      cli: cfg.cli,
      cliStates: cfg.cliStates,
      cliAvailability: {...cfg.cliAvailability, cli: available},
      pendingCliHandoff: cfg.pendingCliHandoff,
      provider: cfg.provider,
      providerName: cfg.providerName,
      model: cfg.model,
      effectiveModel: cfg.effectiveModel,
      effort: cfg.effort,
      effectiveEffort: cfg.effectiveEffort,
      agent: cfg.agent,
      subagent: cfg.subagent,
      changed: cfg.changed,
      reusedTarget: cfg.reusedTarget,
    );
  }

  @override
  void dispose() {
    for (final s in _installs.values) {
      s.timer?.cancel();
    }
    _installs.clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final canSubmit = _available(_target) && (_target != _config.cli || _fresh);
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
    final trailing = _trailing(cli);
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
                        color: _descriptionColor(cli, available),
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ),
              if (trailing != null) trailing,
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

  // Best-effort install-specs fetch: on failure fall back to null so the sheet
  // degrades to the original "未安装或不可执行" wording with no install button.
  Map<String, dynamic>? specs;
  try {
    final res = await manager.fetchCliInstallSpecs();
    final s = res['specs'];
    if (s is Map) specs = Map<String, dynamic>.from(s);
  } catch (_) {
    specs = null;
  }
  if (!context.mounted) return;

  final request = await showModalBottomSheet<CliSwitchRequest>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(12)),
    ),
    builder: (_) => CliSwitchSheet(
      config: config,
      specs: specs,
      sessionId: sessionId,
    ),
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
