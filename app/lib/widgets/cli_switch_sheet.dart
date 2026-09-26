import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/message.dart';
import '../providers/session_manager.dart';
import '../theme.dart';
import '../utils/cli_display.dart';
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
  final String? logTail;
  final String? hint;
  Timer? timer;

  _CliInstallState({
    required this.jobId,
    required this.phase,
    this.error,
    this.logTail,
    this.hint,
  });
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
    _target = widget.config.pendingCli ?? widget.config.cli;
    _config = widget.config;
  }

  bool _available(SessionCli cli) =>
      _config.cliAvailability[cli] ?? cli == _config.cli;

  /// 这张表是 chat 会话的换道面板：一次性车道（`claude -p` / `codex exec`）不列出来
  /// ——「哪种会话给这条车道」是车道的事实（服务端 cli-capability 的 kinds 列）。
  /// 当前这条无论如何都留着：一个跑在旧线路上的会话，选项里连自己都找不到就没法
  /// 知道自己正在用哪条。
  bool _offered(SessionCli cli) => cli == _target || cliOffersIn(cli.name, 'chat');

  /// 安装/升级的单位是**家族的 CLI 制品**，所以服务端的 specs 是家族键，而这里拿
  /// 到的是车道（选择器、会话记录都是车道）—— 先落到家族。
  /// 家族里那条「引擎随 MultiCC 走」的车道（今天只有 claude-exp）没有制品可装，
  /// 见 [cliIsBundled]：绝不能拿家族的 `npm install -g @anthropic-ai/claude-code`
  /// 去修 Agent SDK，那会让人以为修好了。
  Map<String, dynamic>? _specFor(SessionCli cli) {
    final specs = widget.specs;
    if (specs == null || cliIsBundled(cli.name)) return null;
    final s = specs[cliFamilyOf(cli.name) ?? cli.name];
    return s is Map<String, dynamic> ? s : null;
  }

  /// bundled 车道没有安装命令，说明白引擎跟谁走 —— 否则选到它的人只会看到
  /// 「未安装或不可执行」，无处可去。
  String? _bundledNote(SessionCli cli) {
    if (!cliIsBundled(cli.name)) return null;
    final engines = cliBundledEnginesOf(cli.name).map((e) => e.engine).join(' / ');
    return engines.isEmpty
        ? '引擎随 MultiCC 一起发布，请升级 MultiCC 本身'
        : '引擎（$engines）随 MultiCC 一起发布，请升级 MultiCC 本身';
  }

  String _description(SessionCli cli) {
    final install = _installs[cli];
    if (install != null) {
      if (install.phase == 'installing') return '正在安装…(通常1-2分钟)';
      if (install.phase == 'done') return '安装完成, 可切换';
      if (install.phase == 'error') return install.error ?? '安装失败';
    }
    if (!_available(cli)) {
      final note = _bundledNote(cli);
      if (note != null) return note;
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

  /// 兜底车道的提示：`codex exec` 只作兜底、计划淘汰，选中它的人应该知道，
  /// 并知道该用哪条（常驻车道的 Codex）。这句和 web 的 chat-live-ui 选择器、
  /// 新建会话弹窗是同一条说明（那边走 i18n 词条 cliLaneDeprecatedNote，这个
  /// 面板和本文件其余文案一样是中文硬写）。
  List<Widget> _deprecationDetails(SessionCli cli) {
    if (!cli.isDeprecatedLane) return const [];
    final replacement = cli.replacedByLane?.displayName;
    return [
      const SizedBox(height: 4),
      Text(
        replacement == null ? '兜底线路，计划淘汰' : '兜底线路，计划淘汰 · $replacement',
        style: const TextStyle(
          color: Color(0xFFa85a25),
          fontSize: 11,
          height: 1.4,
        ),
      ),
    ];
  }

  /// Extra detail lines under the description while an install runs or has
  /// failed: an actionable hint (e.g. certificate / VPN advice) plus the
  /// captured installer log tail. Without these the user only ever saw a bare
  /// "exit code 1" and could not tell *why* the install failed.
  List<Widget> _installDetails(SessionCli cli) {
    final install = _installs[cli];
    if (install == null) return const [];
    final out = <Widget>[];
    final hint = install.hint;
    if (hint != null && hint.isNotEmpty) {
      out.add(const SizedBox(height: 4));
      out.add(Text(
        hint,
        style: const TextStyle(color: Color(0xFFa85a25), fontSize: 11, height: 1.4),
      ));
    }
    final logTail = install.logTail;
    if (logTail != null && logTail.isNotEmpty) {
      out.add(const SizedBox(height: 4));
      out.add(Container(
        width: double.infinity,
        constraints: const BoxConstraints(maxHeight: 120),
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: const Color(0xFFf4f8fd),
          border: Border.all(color: const Color(0xFFdce6f1)),
          borderRadius: BorderRadius.circular(6),
        ),
        child: SingleChildScrollView(
          child: SelectableText(
            logTail,
            style: const TextStyle(
              color: Color(0xFF6f8096),
              fontFamily: 'monospace',
              fontSize: 10,
              height: 1.4,
            ),
          ),
        ),
      ));
    }
    return out;
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
            logTail: res['logTail']?.toString(),
            hint: res['hint']?.toString(),
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
              logTail: job is Map ? job['logTail']?.toString() : null,
              hint: job is Map ? job['hint']?.toString() : null,
            );
          });
        } else {
          // running / unknown: surface the latest log tail so the user can see
          // what the installer is doing (and why it may be failing).
          final logTail = job is Map ? job['logTail']?.toString() : null;
          final hint = job is Map ? job['hint']?.toString() : null;
          if (logTail != null && logTail.isNotEmpty) {
            setState(() {
              _installs[cli] = _CliInstallState(
                jobId: install.jobId,
                phase: 'installing',
                logTail: logTail,
                hint: hint,
              );
            });
          }
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
    final canSubmit = _available(_target) && (_target != (_config.pendingCli ?? _config.cli) || _fresh);
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
            ...SessionCli.values.where((cli) => _offered(cli)).map(_option),
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
                '运行中可以提前保存，CLI 切换将在下轮生效；'
                '已保存的历史与任务上下文会保留。',
                style: TextStyle(color: Color(0xFFa85a25), fontSize: 12),
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
            color: selected ? color.withValues(alpha: 0.10) : const Color(0xFFf4f8fd),
            border: Border.all(
              color: selected ? color.withValues(alpha: 0.65) : const Color(0xFFdce6f1),
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
                    // 这条车道的小字（引擎）：扶正的两条常驻车道底下是一个引擎产品
                    // （Claude Agent SDK / Codex App Server），得说出来。其余车道的
                    // 小字就是自己的 id，跟名字重复，下面那行状态说明更有用。
                    if (cliEngine(cli.name) != cli.name) ...[
                      const SizedBox(height: 2),
                      Text(
                        cliEngine(cli.name),
                        style: TextStyle(
                          color: available ? AppColors.muted : AppColors.faint,
                          fontSize: 11,
                        ),
                      ),
                    ],
                    const SizedBox(height: 2),
                    Text(
                      _description(cli),
                      style: TextStyle(
                        color: _descriptionColor(cli, available),
                        fontSize: 11,
                      ),
                    ),
                    ..._deprecationDetails(cli),
                    ..._installDetails(cli),
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
            result.deferred
                ? '已保存 ${(result.pendingCli ?? request.cli).displayName}，下轮生效'
                : result.reusedTarget
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
