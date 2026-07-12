// 聊天头部与 AI 配置面板共用的模型/effort chip。自 chat_screen.dart 抽出。
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../providers/session_manager.dart';
import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import 'ai_config_sheet.dart';

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
  bool _loaded = false;

  String get _appType => widget.cli.appType;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await ManageService(
        settings: widget.settings,
      ).fetchProviders(_appType);
      if (!mounted) return;
      setState(() {
        _providers = (d['providers'] as List? ?? [])
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList();
        _loaded = true;
      });
    } catch (_) {
      if (mounted) setState(() => _loaded = true);
    }
  }

  String _providerLabel(String? id) {
    if (id == null || id.isEmpty) return '默认登录';
    for (final p in _providers) {
      if (p['id'] == id) return (p['name'] as String?) ?? id;
    }
    return id.length > 8 ? id.substring(0, 8) : id;
  }

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
  String _modelLabel(Session? s) {
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
    return modelDisplayName(s.cli, model, aliasMap: _aliasMapFor(s.provider));
  }

  String _effortLabel(Session? s) {
    if (s == null) return 'medium';
    return effortShortNameForCli(s.cli, s.effectiveEffort ?? s.effort);
  }

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();
    Session? s;
    for (final x in mgr.sessions) {
      if (x.id == widget.sessionId) {
        s = x;
        break;
      }
    }
    final label =
        '${_providerLabel(s?.provider)} | ${_modelLabel(s)} | ${_effortLabel(s)}';
    return Tooltip(
      message: widget.cli == SessionCli.codex
          ? 'Provider / Model / Reasoning Level'
          : 'Provider / Model / Effort',
      child: GestureDetector(
        onTap: () => _switchAIConfig(context, mgr, s),
        child: Container(
          padding: EdgeInsets.symmetric(
            horizontal: widget.compact ? 6 : 8,
            vertical: 5,
          ),
          decoration: BoxDecoration(
            color: const Color(0xFF14171c),
            border: Border.all(color: const Color(0xFF20242b)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.psychology_outlined,
                size: 15,
                color: Color(0xFFe7eaee),
              ),
              if (!widget.compact) ...[
                const SizedBox(width: 4),
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: widget.compact ? 110 : 220,
                  ),
                  child: Text(
                    label,
                    style: const TextStyle(
                      color: Color(0xFFe7eaee),
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                    overflow: TextOverflow.ellipsis,
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
    Session? s,
  ) async {
    if (s == null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(t('sessionNotLoaded'))));
      return;
    }
    if (!_loaded) await _load();
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
        cli: widget.cli,
        providers: _providers,
        provider: s.provider ?? '',
        model: s.model ?? '',
        effort: s.effectiveEffort ?? s.effort ?? 'medium',
        subProviderId: s.subagent?.providerId,
        subModel: s.subagent?.model,
        streaming: s.streaming ?? true,
      ),
    );
    if (picked == null) return;
    try {
      await mgr.updateSessionAIConfig(
        s.id,
        provider: picked.provider,
        model: picked.model,
        effort: picked.effort,
        subagent: picked.subagent,
        streaming: picked.streaming,
        clearSubagent: picked.subagent == null,
      );
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            '✓ AI 配置已保存：${picked.providerLabel} | ${picked.modelLabel} | ${picked.effortLabel}，下一轮对话生效',
          ),
        ),
      );
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('AI 配置保存失败：$e')));
    }
  }
}
