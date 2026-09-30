// 聊天头部与 AI 配置面板共用的模型/effort chip。自 chat_screen.dart 抽出。
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../providers/session_manager.dart';
import '../providers/chat_provider.dart';
import '../services/manage_service.dart';
import '../services/session_service.dart';
import '../services/codex_models_service.dart';
import '../services/opencode_models_service.dart';
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
  String? model,
}) {
  if (id == null || id.isEmpty) {
    // OpenCode native config (provider-less sessions): the session saves
    // provider='' with a native `opencodego/<model>` id. The provider name must
    // come from that model, not from the first official MultiCC provider in the
    // catalog — otherwise the chip would claim "Claude 官方" for an OpenCode Go
    // session.
    if (model != null && model.isNotEmpty) {
      final slash = model.indexOf('/');
      if (slash > 0) {
        final nativeId = openCodeNativeProviderId(model.substring(0, slash));
        for (final provider in providers) {
          if (provider['id'] == nativeId) {
            return provider['name']?.toString() ?? nativeId;
          }
        }
        // The catalog row may be missing (models cache empty at chip load);
        // the model prefix alone still names the native provider.
        return openCodeNativeProviderDisplayName(model.substring(0, slash));
      }
    }
    for (final provider in providers) {
      final providerId = provider['id']?.toString() ?? '';
      if (provider['builtinOfficial'] == true ||
          providerId == 'claude-official' ||
          providerId == 'codex-official') {
        return provider['name']?.toString() ?? '官方 Provider';
      }
    }
    return '官方 Provider';
  }
  for (final provider in providers) {
    if (provider['id'] == id) return (provider['name'] as String?) ?? id;
  }
  if (resolved != null && resolved.isNotEmpty && resolved != id) {
    return resolved;
  }
  return id.length > 8 ? id.substring(0, 8) : id;
}

/// Compact model indicator + switcher for the chat header. Reads the current
/// per-session model AND provider from SessionManager; when a custom provider
/// is active, its default model is shown instead of a bare "默认".
/// Tap to switch (next turn applies).
class ModelChip extends StatefulWidget {
  final String sessionId;

  /// 用户**已经选好**的那条车道（`ChatProvider.pendingConfiguration.desiredCli`）：
  /// 会话忙时换道是「下轮生效」，provider 池必须按这条车道取，否则药丸列的还是
  /// 旧车道的线路。
  final SessionCli cli;

  /// 下轮生效的那份改动（`ChatProvider.pendingConfiguration.value`）。有它时药丸
  /// 显示的是 pending 里的线路/模型，并挂上「下轮生效」——与 web 的 modelBtn 同一
  /// 口径（public/chat.js:1598 `dataset.pending` + chat-layout.css 的 ::after）。
  final SessionPendingConfiguration? pending;
  final SettingsService settings;
  final bool compact;
  const ModelChip({
    super.key,
    required this.sessionId,
    required this.cli,
    required this.settings,
    this.pending,
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
    if (oldWidget.cli != widget.cli ||
        oldWidget.sessionId != widget.sessionId) {
      _runtime = null;
      _providers = [];
      _load();
    }
  }

  Future<void> _load({SessionCli? cli}) async {
    final epoch = ++_loadEpoch;
    final selectedCli = cli ?? widget.cli;
    try {
      final runtime = await SessionService(
        settings: widget.settings,
      ).fetchSessionCliConfig(widget.sessionId);
      if (!mounted || epoch != _loadEpoch) return;
      setState(() => _runtime = runtime);
    } catch (_) {}
    try {
      if (selectedCli.isCodexFamily) {
        await CodexModelsService(settings: widget.settings).load();
      }
      if (selectedCli == SessionCli.opencode) {
        await OpenCodeModelsService(settings: widget.settings).load();
      }
      final d = await ManageService(
        settings: widget.settings,
      ).fetchProvidersForCli(selectedCli.name);
      if (!mounted || epoch != _loadEpoch) return;
      var providers = (d['providers'] as List? ?? [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
      if (selectedCli == SessionCli.opencode) {
        providers = mergeOpenCodeNativeProviders(
          providers,
          OpenCodeModelsService.cached,
        );
      }
      setState(() {
        _providers = providers;
      });
      context.read<ChatProvider>().applyProviderCatalog(providers);
    } catch (_) {}
  }

  String _providerLabel(String? id, {String? resolved, String? model}) {
    if (widget.cli == SessionCli.opencode &&
        (id == null || id.isEmpty)) {
      if (model != null && model.isNotEmpty) {
        final slash = model.indexOf('/');
        if (slash > 0) {
          final nativeId = openCodeNativeProviderId(model.substring(0, slash));
          for (final provider in _providers) {
            if (provider['id'] == nativeId) {
              return provider['name']?.toString() ?? nativeId;
            }
          }
          return openCodeNativeProviderDisplayName(model.substring(0, slash));
        }
      }
      // Provider-less OpenCode runs on the CLI's own native config — the
      // catalog's "Claude 官方 / Codex 官方" defaults don't apply here.
      return 'OpenCode 原生配置（全部模型）';
    }
    return providerDisplayLabel(
      id,
      providers: _providers,
      resolved: resolved,
      model: model,
    );
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
    if (s.cli.isCodexFamily) return CodexModelsService.labelFor(model);
    return modelDisplayName(s.cli, model, aliasMap: _aliasMapFor(s.provider));
  }

  String _effortLabel(SessionCliConfig? s) {
    if (s == null) return 'medium';
    return effortShortNameForCli(s.cli, s.effectiveEffort ?? s.effort);
  }

  /// 「下轮生效」那份配置当运行时用 —— 与 web 的 `desiredConfig()`
  /// （public/chat-ai-config.js：`{...info, ...pending.profile, cli: pending.cli}`）
  /// 同一口径。
  ///
  /// pending.profile 是**整体**的期望值，所以这里不掺旧运行时的任何字段：服务端
  /// staging 时先跑 cliSwitchDefaults → activateCliState（新车道没配置过的字段就是
  /// null），应用时又是整体 `Object.assign(session, pending.profile)`。旧 model、
  /// 旧线路解析出来的 effectiveModel 对新车道都没有意义。
  SessionCliConfig _pendingView(SessionPendingConfiguration p) => SessionCliConfig(
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
    // 待应用的改动有三条来源，任一有就用它当显示口径：调用方（ChatProvider，
    // 换道/AI 配置保存的响应或 staged 广播）、本 widget 自己拉的会话记录、以及
    // SessionManager 列表里那条会话。剩下的才是「没有 pending，按运行时显示」。
    final staged = widget.pending ?? _runtime?.pending ?? s?.pending;
    final runtime = staged != null
        ? _pendingView(staged)
        : (_runtime ??
              (s == null
                  ? null
                  : SessionCliConfig(
                      cli: s.cli,
                      provider: s.provider,
                      providerSelection: s.providerSelection,
                      model: s.model,
                      effectiveModel: s.effectiveModel,
                      effort: s.effort,
                      effectiveEffort: s.effectiveEffort,
                    )));
    final pending = staged != null;
    // pending 那份才是下一轮要用的，选择项以它为准；没有 pending 才用运行时正在
    // 跑的那个（Auto 模式的实际路由）。
    final selection = pending
        ? runtime!.providerSelection
        : (live.providerSelection ?? runtime?.providerSelection);
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
        _providerLabel(
          runtime?.provider,
          resolved: runtime?.providerName,
          model: runtime?.model,
        ),
        _modelLabel(runtime),
      ]);
    }
    if (widget.cli.supportsEffort) parts.add(_effortLabel(runtime));
    final label = parts.join(' | ');
    return Tooltip(
      message:
          'Provider / Model${widget.cli.supportsEffort ? ' / ${widget.cli.effortFieldLabel}' : ''}'
          '${pending ? '（${t('cliSwitchPending')}）' : ''}',
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
              // 对齐 web 的 [data-pending]::after（chat-layout.css：10px / 左距 6px
              // / #bd842e）。窄页头这枚 chip 只剩 icon（连名字都没有），再挂 40px
              // 文字会把那一行的固定预算顶爆，窄屏只留 tooltip 里的说法。
              if (pending && !widget.compact) ...[
                const SizedBox(width: 6),
                Text(
                  t('cliSwitchPending'),
                  style: const TextStyle(
                    fontSize: 10,
                    color: Color(0xFFbd842e),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _switchAIConfig(BuildContext context, SessionManager mgr) async {
    final target = widget.sessionId;
    Session? session;
    for (final x in mgr.sessions) {
      if (x.id == target) {
        session = x;
        break;
      }
    }
    // 与药丸同一条口径：有 pending 就拿 pending 当初始值（web 在打开面板前也是
    // 先 `...pendingConfiguration?.profile` 覆盖一次），否则拿运行时。
    final staged = widget.pending ?? _runtime?.pending ?? session?.pending;
    SessionCliConfig? runtime = staged != null
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
    // Header data is already enough to paint the sheet. Refresh catalogs in
    // the background; opening the control must never wait for a 20s model-list
    // request. The next open (and the chip itself) receives the refreshed data.
    if (runtime == null) {
      await openAIConfigSheet(
        context,
        settings: widget.settings,
        sessionId: target,
      );
      return;
    }
    unawaited(_load(cli: runtime.cli));
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
        effort:
            runtime.effectiveEffort ??
            runtime.effort ??
            runtime.cli.defaultEffort,
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
