// 页头上唯一一枚「运行配置」chip：取代了以前的 CLI 角标 + provider/model/effort
// 药丸两颗。点它开「运行配置」面板（CLI 与线路/模型/强度都在那一个面板里挑）。
//
// 固定一条 → `<CLI> · <线路> · <模型>`（+ 强度）；
// 自动挑选 → `⚡ 自动 · 按难度 · N 条 ｜本轮 <线路/模型>`；
// 下轮生效时 chip 转琥珀并挂「下一轮生效」。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../i18n.dart';
import '../../models/message.dart';
import '../../providers/chat_provider.dart';
import '../../providers/session_manager.dart';
import '../../services/codex_models_service.dart';
import '../../services/manage_service.dart';
import '../../services/opencode_models_service.dart';
import '../../services/session_service.dart';
import '../../services/settings_service.dart';
import '../../utils/cli_display.dart';
import '../../utils/session_status_helpers.dart';
import '../run_config/run_labels.dart';
import '../run_config/run_config_models.dart';
import '../run_config/run_config_sheet.dart';
import '../marquee_text.dart';

/// 一行说的是哪条线路、哪个模型。
class RunChip extends StatefulWidget {
  const RunChip({
    super.key,
    required this.sessionId,
    required this.cli,
    required this.settings,
    this.pending,
    this.compact = false,
    this.maxLabelWidth,
  });

  final String sessionId;

  /// 用户**已经选好**的那条车道（`ChatProvider.pendingConfiguration.desiredCli`）：
  /// 会话忙时换道是「下轮生效」，线路池必须按这条车道取。
  final SessionCli cli;

  /// 下轮生效的那份改动。有它时 chip 显示 pending 里的线路/模型并挂「下轮生效」。
  final SessionPendingConfiguration? pending;
  final SettingsService settings;
  final bool compact;
  final double? maxLabelWidth;

  @override
  State<RunChip> createState() => _RunChipState();
}

class _RunChipState extends State<RunChip> {
  List<Map<String, dynamic>> _providers = [];
  int _loadEpoch = 0;
  SessionCliConfig? _runtime;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant RunChip oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.cli != widget.cli ||
        oldWidget.sessionId != widget.sessionId) {
      _runtime = null;
      _providers = [];
      _load();
    }
  }

  Future<void> _load() async {
    final epoch = ++_loadEpoch;
    final cli = widget.cli;
    try {
      final runtime = await SessionService(
        settings: widget.settings,
      ).fetchSessionCliConfig(widget.sessionId);
      if (!mounted || epoch != _loadEpoch) return;
      setState(() => _runtime = runtime);
    } catch (_) {}
    try {
      if (cli.isCodexFamily) {
        await CodexModelsService(settings: widget.settings).load();
      }
      if (cli == SessionCli.opencode) {
        await OpenCodeModelsService(settings: widget.settings).load();
      }
      final d = await ManageService(
        settings: widget.settings,
      ).fetchProvidersForCli(cli.name);
      if (!mounted || epoch != _loadEpoch) return;
      var providers = (d['providers'] as List? ?? [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      if (cli == SessionCli.opencode) {
        providers = mergeOpenCodeNativeProviders(
          providers,
          OpenCodeModelsService.cached,
        );
      }
      setState(() => _providers = providers);
      context.read<ChatProvider>().applyProviderCatalog(providers);
    } catch (_) {}
  }

  /// 「下轮生效」那份配置当运行时用 —— pending.profile 是**整体**的期望值，不掺
  /// 旧运行时的任何字段。
  SessionCliConfig _pendingView(SessionPendingConfiguration p) =>
      SessionCliConfig(
        cli: p.cli,
        provider: p.provider,
        providerSelection: p.providerSelection,
        model: p.model,
        effectiveModel: p.model,
        effort: p.effort,
        effectiveEffort: p.effort,
        agent: p.agent,
        subagent: p.subagent,
        deferred: true,
        pending: p,
      );

  Map? _aliasMapFor(String? providerId) {
    if (providerId == null || providerId.isEmpty) return null;
    for (final p in _providers) {
      if (p['id'] == providerId) {
        final map = p['aliasMap'];
        return map is Map ? map : null;
      }
    }
    return null;
  }

  String _modelLabel(SessionCli cli, SessionCliConfig? s) {
    if (s == null) return '默认';
    String? model;
    if (s.effectiveModel != null && s.effectiveModel!.isNotEmpty) {
      model = s.effectiveModel;
    } else if (s.model != null && s.model!.isNotEmpty) {
      model = s.model;
    } else {
      final pid = s.provider;
      if (pid != null && pid.isNotEmpty) {
        for (final p in _providers) {
          if (p['id'] == pid) {
            final m = p['model'] as String?;
            if (m != null && m.isNotEmpty) model = m;
            break;
          }
        }
      }
    }
    if (model == null || model.isEmpty) return '默认';
    if (cli.isCodexFamily) return CodexModelsService.labelFor(model);
    return modelDisplayName(cli, model, aliasMap: _aliasMapFor(s.provider));
  }

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();
    final live = context.watch<ChatProvider>();
    Session? session;
    for (final x in mgr.sessions) {
      if (x.id == widget.sessionId) {
        session = x;
        break;
      }
    }
    final staged = widget.pending ?? _runtime?.pending ?? session?.pending;
    final runtime = staged != null
        ? _pendingView(staged)
        : (_runtime ??
              (session == null
                  ? null
                  : SessionCliConfig(
                      cli: session.cli,
                      provider: session.provider,
                      providerSelection: session.providerSelection,
                      model: session.model,
                      effectiveModel: session.effectiveModel,
                      effort: session.effort,
                      effectiveEffort: session.effectiveEffort,
                    )));
    final pending = staged != null;
    final cli = pending ? staged.cli : widget.cli;
    final selection = pending
        ? runtime?.providerSelection
        : (live.providerSelection ?? runtime?.providerSelection);
    final label = selection != null
        ? _autoLabel(cli, selection, live)
        : _fixedLabel(cli, runtime);
    return _chip(
      context: context,
      mgr: mgr,
      cli: cli,
      label: label,
      pending: pending,
    );
  }

  String _fixedLabel(SessionCli cli, SessionCliConfig? runtime) {
    final parts = <String>[cliDisplayName(cli.name)];
    if (cli.supportsProvider) {
      parts.add(
        runProviderChipLabel(
          runtime?.provider,
          providers: _providers,
          resolved: runtime?.providerName,
          model: runtime?.model,
        ),
      );
    }
    parts.add(_modelLabel(cli, runtime));
    if (cli.supportsEffort) {
      final effort = effortChipLabel(
        cli,
        runtime?.effectiveEffort ?? runtime?.effort,
      );
      if (effort.isNotEmpty) parts.add(effort);
    }
    return parts.join(' · ');
  }

  String _autoLabel(
    SessionCli cli,
    SessionProviderSelection selection,
    ChatProvider live,
  ) {
    final count = selection.candidates.where((c) => c.enabled).length;
    final how = selection.routing != null ? '按难度' : '按顺序';
    final actual = live.activeProviderName;
    final model = live.activeProviderModel;
    final tail = <String>[
      if (actual != null && actual.isNotEmpty) actual,
      if (model != null && model.isNotEmpty)
        modelDisplayName(cli, model, aliasMap: _aliasMapFor(null)),
    ];
    return '⚡ 自动 · $how · $count 条'
        '${tail.isEmpty ? '' : ' ｜本轮 ${tail.join(' · ')}'}';
  }

  Widget _chip({
    required BuildContext context,
    required SessionManager mgr,
    required SessionCli cli,
    required String label,
    required bool pending,
  }) {
    final color = cliBrandColor(cli);
    const pendingColor = Color(0xFFbd842e);
    return Tooltip(
      message: '运行配置${pending ? '（${t('cliSwitchPending')}）' : ''}',
      child: InkWell(
        onTap: () => _open(context),
        borderRadius: BorderRadius.circular(6),
        child: Container(
          padding: EdgeInsets.symmetric(
            horizontal: widget.compact ? 6 : 8,
            vertical: 4,
          ),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.12),
            border: Border.all(
              color: pending
                  ? pendingColor.withValues(alpha: 0.7)
                  : color.withValues(alpha: 0.4),
            ),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.psychology_outlined, size: 15, color: color),
              if (!widget.compact) ...[
                const SizedBox(width: 4),
                MarqueeText(
                  text: label,
                  maxWidth: widget.maxLabelWidth ?? 240,
                  style: const TextStyle(
                    color: Color(0xFF233249),
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
              if (pending && !widget.compact) ...[
                const SizedBox(width: 6),
                Text(
                  t('cliSwitchPending'),
                  style: const TextStyle(fontSize: 10, color: pendingColor),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context) async {
    await openRunConfigSheet(
      context,
      settings: widget.settings,
      sessionId: widget.sessionId,
      cli: _runtime?.cli ?? widget.cli,
    );
    if (mounted) await _load();
  }
}
