// 聊天头部与 AI 配置面板共用的模型/effort chip。自 chat_screen.dart 抽出。
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../providers/session_manager.dart';
import '../providers/chat_provider.dart';
import '../services/manage_service.dart';
import '../services/session_service.dart';
import '../services/codex_models_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import 'ai_config_sheet.dart';
import 'marquee_text.dart';

/// 会话记录里存的是 Provider id，屏幕上要的是名字。catalog 里有就用 catalog 的
/// （改名立刻跟着变），没有就用服务端随会话下发的解析名（`GET /api/sessions/:id`
/// 的 `providerName`），最后才退回缩写的 id —— 一串 UUID 对用户没有任何意义，
/// Web 的线路胶囊同样只认名字（src/workspace/air-routes.js 的 providerName）。
String providerDisplayLabel(
  String? id, {
  required List<Map<String, dynamic>> providers,
  String? resolved,
}) {
  if (id == null || id.isEmpty) return '默认登录';
  for (final provider in providers) {
    if (provider['id'] == id) return (provider['name'] as String?) ?? id;
  }
  if (resolved != null && resolved.isNotEmpty && resolved != id) return resolved;
  return id.length > 8 ? id.substring(0, 8) : id;
}

/// Compact model indicator + switcher for the chat header. Reads the current
/// per-session model AND provider from SessionManager; when a custom provider
/// is active, its default model is shown instead of a bare "默认".
/// Tap to switch (next turn applies).
class ModelChip extends StatefulWidget {
  final String sessionId;
  final SessionCli cli;
  final SettingsService settings;
  final bool compact;
  const ModelChip({
    super.key,
    required this.sessionId,
    required this.cli,
    required this.settings,
    this.compact = false,
  });

  @override
  State<ModelChip> createState() => ModelChipState();
}

class ModelChipState extends State<ModelChip> {
  List<Map<String, dynamic>> _providers = [];
  int _loadEpoch = 0;
  SessionCliConfig? _runtime;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant ModelChip oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.cli != widget.cli || oldWidget.sessionId != widget.sessionId) {
      _runtime = null;
      _providers = [];
      _load();
    }
  }

  Future<void> _load({SessionCli? cli, bool refreshCodex = false}) async {
    final epoch = ++_loadEpoch;
    final selectedCli = cli ?? widget.cli;
    final appType = selectedCli.appType;
    try {
      final runtime = await SessionService(settings: widget.settings).fetchSessionCliConfig(widget.sessionId);
      if (!mounted || epoch != _loadEpoch) return;
      setState(() => _runtime = runtime);
    } catch (_) {}
    try {
      if (selectedCli == SessionCli.codex) {
        await CodexModelsService(
          settings: widget.settings,
        ).load(forceRefresh: refreshCodex);
      }
      final d = await ManageService(
        settings: widget.settings,
      ).fetchProviders(appType);
      if (!mounted || epoch != _loadEpoch) return;
      final providers = (d['providers'] as List? ?? [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      setState(() {
        _providers = providers;
      });
      context.read<ChatProvider>().applyProviderCatalog(providers);
    } catch (_) {}
  }

  String _providerLabel(String? id, {String? resolved}) =>
      providerDisplayLabel(id, providers: _providers, resolved: resolved);

  /// The picked provider's aliasMap (tier → {model, name}), or null when absent.
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

  /// Effective model label: prefer the server-resolved effectiveModel, and for
  /// alias-mapped relays show the provider's real model name (e.g. GLM5.2)
  /// instead of the claude-* alias.
  String _modelLabel(SessionCliConfig? s) {
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
    if (s.cli == SessionCli.codex) return CodexModelsService.labelFor(model);
    return modelDisplayName(s.cli, model, aliasMap: _aliasMapFor(s.provider));
  }

  String _effortLabel(SessionCliConfig? s) {
    if (s == null) return 'medium';
    return effortShortNameForCli(s.cli, s.effectiveEffort ?? s.effort);
  }

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();
    final live = context.watch<ChatProvider>();
    Session? s;
    for (final x in mgr.sessions) {
      if (x.id == widget.sessionId) {
        s = x;
        break;
      }
    }
    final runtime = _runtime ?? (s == null ? null : SessionCliConfig(
      cli: s.cli, provider: s.provider, providerSelection: s.providerSelection,
      model: s.model, effectiveModel: s.effectiveModel,
      effort: s.effort, effectiveEffort: s.effectiveEffort));
    final selection = live.providerSelection ?? runtime?.providerSelection;
    final parts = <String>[];
    if (selection != null) {
      parts.add(
        autoProviderRouteLabel(selection.protocol, live.activeProviderName),
      );
      final actualModel = live.activeProviderModel;
      if (actualModel != null && actualModel.isNotEmpty) {
        parts.add(modelDisplayName(runtime?.cli ?? widget.cli, actualModel));
      }
    } else {
      parts.addAll([
        _providerLabel(runtime?.provider, resolved: runtime?.providerName),
        _modelLabel(runtime),
      ]);
    }
    if (widget.cli.supportsEffort) parts.add(_effortLabel(runtime));
    final label = parts.join(' | ');
    return Tooltip(
      message:
          'Provider / Model${widget.cli.supportsEffort ? ' / ${widget.cli.effortFieldLabel}' : ''}',
      child: GestureDetector(
        onTap: () => _switchAIConfig(context, mgr),
        child: Container(
          padding: EdgeInsets.symmetric(
            horizontal: widget.compact ? 6 : 8,
            vertical: 5,
          ),
          decoration: BoxDecoration(
            color: const Color(0xFFf8fbff),
            border: Border.all(color: const Color(0xFFdce6f1)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.psychology_outlined,
                size: 15,
                color: Color(0xFF233249),
              ),
              if (!widget.compact) ...[
                const SizedBox(width: 4),
                // 线路名是用户数据（Provider 显示名可以很长），所以这枚 chip 有
                // 上限宽度：装不下就走跑马灯，而不是让省略号把唯一有信息量的
                // 那段吃掉 —— Web 的线路胶囊是同一套（composer.css 的
                // .mc-composer__pill--ai）。
                MarqueeText(
                  text: label,
                  maxWidth: widget.compact ? 110 : 220,
                  style: const TextStyle(
                    color: Color(0xFF233249),
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _switchAIConfig(
    BuildContext context,
    SessionManager mgr,
  ) async {
    final target = widget.sessionId;
    late SessionCliConfig runtime;
    try {
      runtime = await mgr.fetchSessionCliConfig(target);
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(t('sessionNotLoaded'))));
      }
      return;
    }
    await _load(cli: runtime.cli, refreshCodex: true);
    if (!context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final picked = await showModalBottomSheet<AIConfigResult>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (_) => AIConfigSheet(
        cli: runtime.cli,
        providers: _providers,
        provider: runtime.provider ?? '',
        providerSelection: runtime.providerSelection,
        model: runtime.model ?? '',
        effort: runtime.effectiveEffort ?? runtime.effort ?? runtime.cli.defaultEffort,
        subProviderId: runtime.subagent?.providerId,
        subModel: runtime.subagent?.model,
        agent: runtime.agent,
      ),
    );
    if (picked == null) return;
    try {
      await mgr.updateSessionAIConfig(
        target,
        provider: picked.provider,
        providerSelection: picked.providerSelection,
        model: picked.model,
        effort: picked.effort,
        subagent: picked.subagent,
        agent: picked.agent,
        clearSubagent: picked.subagent == null,
      );
      if (mounted && widget.sessionId == target) await _load();
      final summary = [picked.providerLabel, picked.modelLabel];
      if (picked.effortLabel.isNotEmpty) summary.add(picked.effortLabel);
      messenger.showSnackBar(
        SnackBar(content: Text('✓ AI 配置已保存：${summary.join(' | ')}，下一轮对话生效')),
      );
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('AI 配置保存失败：$e')));
    }
  }
}

@visibleForTesting
String autoProviderRouteLabel(String protocol, String? actualProviderName) {
  final protocolLabel = switch (protocol) {
    'anthropic' => 'Anthropic',
    'openai_responses' => 'Responses',
    'openai_chat' => 'OpenAI Chat',
    _ => protocol,
  };
  final actual = actualProviderName == null || actualProviderName.isEmpty
      ? '待路由'
      : actualProviderName;
  return 'Auto · $protocolLabel → $actual';
}
