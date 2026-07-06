import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/agent_preset.dart';
import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/agent_preset_service.dart';
import '../services/chat_service.dart';
import '../services/manage_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import '../widgets/conflict_diff_dialog.dart';
import '../widgets/session_diff_dialog.dart';
import '../widgets/input_bar.dart';
import '../widgets/message_bubble.dart';
import '../widgets/thinking_indicator.dart';
import 'memo_screen.dart';
import 'memory_screen.dart';
import 'file_browser_screen.dart';
import 'settings_screen.dart';
import 'share_messages_screen.dart';

const double _chatDesktopBreakpoint = 760;
const double _chatMaxContentWidth = 980;
const double _chatMobileSidePadding = 12;
const double _chatDesktopSidePadding = 16;

/// Reusable chat view — expects a ChatProvider in the widget tree
/// (provided by MainShell via ChangeNotifierProvider.value).
class ChatView extends StatefulWidget {
  final SettingsService settings;
  final VoidCallback? onCollapse;
  const ChatView({super.key, required this.settings, this.onCollapse});

  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final _scrollCtrl = ScrollController();
  Timer? _mergeTimer;
  String? _polledSession;
  Map<String, dynamic>? _mergeStatus;
  // Track the last-warned behind count per session so the SnackBar fires when a
  // worktree first falls behind main (or falls further), not on every 5s poll.
  int _lastWarnedBehind = 0;
  bool _syncing = false;

  int _behindCount() => (_mergeStatus?['behind'] as num?)?.toInt() ?? 0;
  String _baseBranchName() => _mergeStatus?['baseBranch']?.toString() ?? 'main';

  // One-click sync: pull the base branch into this session's worktree.
  Future<void> _syncWorktree(String sessionId) async {
    if (sessionId.isEmpty || _syncing) return;
    setState(() => _syncing = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final res = await SessionService(
        settings: widget.settings,
      ).syncSession(sessionId);
      messenger.hideCurrentSnackBar();
      if (res['ok'] == true) {
        final merged = res['merged'] == true;
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              merged
                  ? '✓ 已从 ${res['baseBranch'] ?? 'base'} 同步 ${res['commits']} 个提交'
                  : (res['message']?.toString() ?? '已是最新'),
            ),
          ),
        );
      } else if ((res['conflicts'] as List?)?.isNotEmpty == true) {
        messenger.showSnackBar(
          SnackBar(
            backgroundColor: const Color(0xFF3a1414),
            content: Text(
              '✗ 同步冲突已 abort，worktree 未改动：${(res['conflicts'] as List).join(', ')}',
              style: const TextStyle(color: Color(0xFFff9b9b)),
            ),
            duration: const Duration(seconds: 6),
          ),
        );
      } else {
        messenger.showSnackBar(
          SnackBar(content: Text('✗ 同步失败：${res['error'] ?? '未知错误'}')),
        );
      }
      _lastWarnedBehind = 0; // allow a fresh warning if it falls behind again
      await _refreshMergeStatus(sessionId);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('✗ 同步请求失败：$e')));
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  @override
  void dispose() {
    _scrollCtrl.dispose();
    _mergeTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final provider = context.watch<ChatProvider>();
    final session = provider.sessionName;
    if (session == _polledSession) return;
    _polledSession = session;
    _lastWarnedBehind = 0; // reset warning state when switching sessions
    _mergeTimer?.cancel();
    _refreshMergeStatus(session);
    _mergeTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _refreshMergeStatus(session),
    );
  }

  Future<void> _refreshMergeStatus(String sessionId) async {
    if (sessionId.isEmpty) return;
    try {
      final status = await SessionService(
        settings: widget.settings,
      ).fetchMergeStatus(sessionId);
      if (!mounted || _polledSession != sessionId) return;
      setState(() => _mergeStatus = status);
      _maybeWarnBehind();
    } catch (_) {}
  }

  // Fire a SnackBar the moment this worktree is detected as behind its base
  // branch (and again only if it falls further behind), so the user sees it
  // without having to scan the header.
  void _maybeWarnBehind() {
    final behind = _behindCount();
    if (behind > _lastWarnedBehind) {
      final base = _baseBranchName();
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            backgroundColor: const Color(0xFF2d2108),
            content: Text(
              '⚠ 当前 worktree 已落后 $base $behind 个提交，建议同步',
              style: const TextStyle(color: Color(0xFFf2cc60)),
            ),
            duration: const Duration(seconds: 5),
          ),
        );
    }
    _lastWarnedBehind = behind;
  }

  Future<void> _mergeCurrent(BuildContext context, String sessionId) async {
    await confirmMergeWorktree(context, widget.settings, sessionId);
    await _refreshMergeStatus(sessionId);
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final mergeReady = _mergeStatus?['mergeReady'] == true;
    return Scaffold(
      backgroundColor: const Color(0xFF070809),
      body: SafeArea(
        child: Column(
          children: [
            _Header(
              settings: widget.settings,
              onCollapse: widget.onCollapse,
              mergeReady: mergeReady,
              onMerge: () => _mergeCurrent(context, provider.sessionName),
            ),
            _CwdBar(mergeStatus: _mergeStatus),
            if (_behindCount() > 0)
              _BehindMainBanner(
                behind: _behindCount(),
                baseBranch: _baseBranchName(),
                syncing: _syncing,
                onSync: () => _syncWorktree(provider.sessionName),
              ),
            Expanded(child: _MessageList(scrollCtrl: _scrollCtrl)),
            const _CenteredChatLane(child: _CostBar()),
            if (mergeReady)
              _MergeReadyBanner(
                text: _mergeStatusText(_mergeStatus),
                onMerge: () => _mergeCurrent(context, provider.sessionName),
                onDiff: () => showSessionDiffDialog(
                  context,
                  settings: widget.settings,
                  sessionId: provider.sessionName,
                ),
              ),
            _CenteredChatLane(
              child: InputBar(
                onPickSubagent: () => openAIConfigSheet(
                  context,
                  settings: widget.settings,
                  sessionId: provider.sessionName,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CenteredChatLane extends StatelessWidget {
  final Widget child;
  const _CenteredChatLane({required this.child});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final viewportWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        final laneWidth =
            viewportWidth >= _chatDesktopBreakpoint &&
                viewportWidth > _chatMaxContentWidth
            ? _chatMaxContentWidth
            : viewportWidth;
        return Align(
          alignment: Alignment.center,
          child: SizedBox(width: laneWidth, child: child),
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  final SettingsService settings;
  final VoidCallback? onCollapse;
  final bool mergeReady;
  final VoidCallback onMerge;
  const _Header({
    required this.settings,
    this.onCollapse,
    required this.mergeReady,
    required this.onMerge,
  });

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final state = provider.connectionState;

    Color statusColor;
    switch (state) {
      case ChatConnectionState.connected:
        statusColor = const Color(0xFF7fd49a);
        break;
      case ChatConnectionState.connecting:
        statusColor = const Color(0xFFe3b341);
        break;
      case ChatConnectionState.disconnected:
        statusColor = const Color(0xFF8a909b);
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      decoration: const BoxDecoration(
        color: Color(0xFF0f1115),
        border: Border(bottom: BorderSide(color: Color(0xFF20242b))),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final narrow = constraints.maxWidth < 500;
          return Row(
            children: [
              // Collapse the chat sheet back down to the home dashboard.
              GestureDetector(
                onTap: onCollapse,
                child: Container(
                  padding: const EdgeInsets.all(6),
                  child: const Icon(
                    Icons.keyboard_arrow_down_rounded,
                    color: Color(0xFFe7eaee),
                    size: 24,
                  ),
                ),
              ),
              const SizedBox(width: 4),
              RichText(
                text: const TextSpan(
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                  children: [
                    TextSpan(
                      text: 'Multi',
                      style: TextStyle(color: Color(0xFF3ad6c5)),
                    ),
                    TextSpan(
                      text: 'CC',
                      style: TextStyle(color: Color(0xFF6aa3ff)),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              _ChatCliBadge(cli: provider.cli),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  provider.titleLabel,
                  style: const TextStyle(
                    color: Color(0xFF6aa3ff),
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    fontFamily: 'monospace',
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              // Connection dot — tap to manually reconnect when disconnected.
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: state == ChatConnectionState.connected
                    ? null
                    : provider.reconnect,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 2,
                    vertical: 4,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.circle, size: 8, color: statusColor),
                      if (state != ChatConnectionState.connected) ...[
                        const SizedBox(width: 4),
                        const Icon(
                          Icons.refresh_rounded,
                          size: 15,
                          color: Color(0xFF8a909b),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const Spacer(),
              // Manual reconnect
              _HeaderBtn(
                icon: Icons.sync_rounded,
                tooltip: t('reconnect'),
                onTap: () => _forceReconnect(context, provider),
              ),
              // Provider / Model / Effort unified chip.
              const SizedBox(width: 4),
              _ModelChip(
                sessionId: provider.sessionName,
                cli: provider.cli,
                settings: settings,
                compact: narrow,
              ),
              const SizedBox(width: 4),
              _ClearCtxButton(provider: provider),
              const SizedBox(width: 4),
              _HeaderOverflowMenu(
                mergeReady: mergeReady,
                onRole: () =>
                    _editRoleFromSession(context, provider.sessionName),
                onMemory: () =>
                    _editMemoryFromSession(context, provider.sessionName),
                onMemo: () =>
                    _openMemoFromSession(context, provider.sessionName),
                onMerge: onMerge,
                onSettings: () => _openSettings(context, settings),
                onShare: () =>
                    _shareFromSession(context, provider.sessionName, settings),
                onShareMessages: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => ShareMessagesScreen(
                      sessionId: provider.sessionName,
                      settings: settings,
                    ),
                  ),
                ),
                onFiles: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => FileBrowserScreen(
                      sessionId: provider.sessionName,
                      settings: settings,
                    ),
                  ),
                ),
                onRestart: () => _confirmRestart(context, provider),
              ),
            ],
          );
        },
      ),
    );
  }

  void _forceReconnect(BuildContext context, ChatProvider provider) {
    provider.reconnect();
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(t('reconnecting')),
          duration: const Duration(seconds: 2),
          backgroundColor: const Color(0xFF14171c),
        ),
      );
  }

  /// Restart the underlying CLI process for this session (stronger than
  /// reconnect — rebuilds the claude/codex command, like the web's 🔄 button).
  /// Asks for confirmation first because it discards any in-flight work.
  Future<void> _confirmRestart(
    BuildContext context,
    ChatProvider provider,
  ) async {
    final sid = provider.sessionName;
    if (sid.isEmpty) return;
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: Text(t('restartCli'), style: const TextStyle(fontSize: 16)),
        content: Text(
          t('restartCliBody'),
          style: const TextStyle(color: Color(0xFF8a909b), fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: Text(
              t('cancel'),
              style: const TextStyle(color: Color(0xFF8a909b)),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(c, true),
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFFe3b341),
            ),
            child: Text(t('restart')),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(t('restarting')),
          duration: const Duration(seconds: 2),
          backgroundColor: const Color(0xFF14171c),
        ),
      );
    try {
      await SessionService(settings: settings).restartSession(sid);
      if (!context.mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(t('restarted')),
            duration: const Duration(seconds: 2),
            backgroundColor: const Color(0xFF14171c),
          ),
        );
    } catch (e) {
      if (!context.mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(t('restartFailed', {'error': '$e'})),
            backgroundColor: const Color(0xFFff6b63),
          ),
        );
    }
  }

  void _openSettings(BuildContext context, SettingsService settings) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => SettingsScreen(settings: settings)),
    );
  }
}

/// Compact model indicator + switcher for the chat header. Reads the current
/// per-session model AND provider from SessionManager; when a custom provider
/// is active, its default model is shown instead of a bare "默认".
/// Tap to switch (next turn applies).
class _ModelChip extends StatefulWidget {
  final String sessionId;
  final SessionCli cli;
  final SettingsService settings;
  final bool compact;
  const _ModelChip({
    required this.sessionId,
    required this.cli,
    required this.settings,
    this.compact = false,
  });

  @override
  State<_ModelChip> createState() => _ModelChipState();
}

class _ModelChipState extends State<_ModelChip> {
  List<Map<String, dynamic>> _providers = [];
  bool _loaded = false;

  String get _appType => widget.cli == SessionCli.codex ? 'codex' : 'claude';

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
    final picked = await showModalBottomSheet<_AIConfigResult>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (_) => _AIConfigSheet(
        cli: widget.cli,
        providers: _providers,
        provider: s.provider ?? '',
        model: s.model ?? '',
        effort: s.effectiveEffort ?? s.effort ?? 'medium',
        subProviderId: s.subagent?.providerId,
        subModel: s.subagent?.model,
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

class _AIConfigResult {
  final String provider;
  final String model;
  final String effort;
  final String providerLabel;
  final String modelLabel;
  final String effortLabel;
  final SessionSubagent? subagent;
  const _AIConfigResult({
    required this.provider,
    required this.model,
    required this.effort,
    required this.providerLabel,
    required this.modelLabel,
    required this.effortLabel,
    this.subagent,
  });
}

class _AIConfigSheet extends StatefulWidget {
  final SessionCli cli;
  final List<Map<String, dynamic>> providers;
  final String provider;
  final String model;
  final String effort;
  final String? subProviderId;
  final String? subModel;
  const _AIConfigSheet({
    required this.cli,
    required this.providers,
    required this.provider,
    required this.model,
    required this.effort,
    this.subProviderId,
    this.subModel,
  });

  @override
  State<_AIConfigSheet> createState() => _AIConfigSheetState();
}

class _AIConfigSheetState extends State<_AIConfigSheet> {
  late String _provider;
  late String _model;
  late String _effort;
  bool _customModel = false;
  late final TextEditingController _customCtrl;
  // Sub-task (subagent) cascade — same shape as the main provider/model.
  late String _subProvider;
  late String _subModel;
  bool _customSubModel = false;
  late final TextEditingController _subCustomCtrl;

  bool get _isClaude => widget.cli == SessionCli.claude;
  String get _defaultEffort => _isClaude ? 'medium' : 'xhigh';

  static const _claudeEfforts = <String>[
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultracode',
  ];
  static const _codexEfforts = <String>['low', 'medium', 'high', 'xhigh'];

  @override
  void initState() {
    super.initState();
    _provider = widget.provider;
    _model = _normalizeModel(widget.provider, widget.model);
    _effort = _validEfforts.contains(widget.effort) ? widget.effort : _defaultEffort;
    final known = _modelChoices(_provider).contains(_model);
    _customModel = _model.isNotEmpty && !known;
    _customCtrl = TextEditingController(text: _customModel ? _model : '');
    // Sub-task seeding.
    _subProvider = widget.subProviderId ?? '';
    _subModel = _normalizeModel(_subProvider, widget.subModel ?? '');
    final subKnown =
        _subProvider.isNotEmpty && _modelChoices(_subProvider).contains(_subModel);
    _customSubModel = _subProvider.isNotEmpty && _subModel.isNotEmpty && !subKnown;
    _subCustomCtrl = TextEditingController(text: _customSubModel ? _subModel : '');
  }

  @override
  void dispose() {
    _customCtrl.dispose();
    _subCustomCtrl.dispose();
    super.dispose();
  }

  List<String> get _validEfforts => _isClaude ? _claudeEfforts : _codexEfforts;

  Map<String, dynamic>? _providerMap(String id) {
    for (final p in widget.providers) {
      if (p['id'] == id) return p;
    }
    return null;
  }

  String _providerName(String id) {
    if (id.isEmpty) return '默认登录';
    final p = _providerMap(id);
    return p?['name']?.toString() ?? id;
  }

  // Ordered alias tiers (opus/sonnet/haiku/fable) with their {model, name} for an
  // alias-mapped relay, or empty when the provider declares no aliasMap. Each tier
  // is a real, selectable wire model on these relays (the server honors
  // session.model === 'opus' | 'sonnet' | 'haiku' | 'fable' directly).
  List<MapEntry<String, Map>> _aliasTiers(String provider) {
    final map = _providerMap(provider)?['aliasMap'];
    if (map is! Map) return const [];
    const order = ['opus', 'sonnet', 'haiku', 'fable'];
    final tiers = <MapEntry<String, Map>>[];
    for (final t in order) {
      final v = map[t];
      if (v is Map && v['model'] != null) tiers.add(MapEntry(t, v));
    }
    return tiers;
  }

  List<String> _modelChoices(String provider) {
    // Alias-mapped relays: offer the tiers directly (opus/sonnet/haiku/fable) so
    // each option can read "alias → wire model (display name)".
    final tiers = _aliasTiers(provider);
    if (tiers.isNotEmpty) return ['', ...tiers.map((e) => e.key)];
    final opts = _providerMap(provider)?['modelOptions'];
    if (opts is List && opts.isNotEmpty) {
      return [
        '',
        ...opts.map((e) => e.toString()).where((e) => e.trim().isNotEmpty),
      ];
    }
    return _isClaude ? kClaudeModelOptions.map((e) => e.key).toList() : [''];
  }

  // Map a stored wire model id (e.g. claude-opus-4-8) back to its alias tier so
  // the tier dropdown pre-selects instead of dropping into the custom-id field.
  String _normalizeModel(String provider, String model) {
    if (model.isEmpty) return model;
    for (final e in _aliasTiers(provider)) {
      if (e.key == model) return model;
      if (e.value['model']?.toString() == model) return e.key;
    }
    return model;
  }

  String _modelLabel(String model) {
    if (model.isEmpty) return '默认 / 跟随 Provider';
    return modelShortNameForCli(widget.cli, model);
  }

  // Rich dropdown option label. For alias tiers: "opus → claude-opus-4-8 (GLM5.2)".
  String _modelOptionLabel(String provider, String value) {
    if (value.isEmpty) return _modelLabel('');
    for (final e in _aliasTiers(provider)) {
      if (e.key != value) continue;
      final m = e.value['model']?.toString() ?? '';
      final name = e.value['name']?.toString();
      return '${e.key} → $m${(name != null && name.isNotEmpty) ? ' ($name)' : ''}';
    }
    return _modelLabel(value);
  }

  // Compact label for the saved config (chip / SnackBar): the provider's real
  // model name (e.g. GLM5.2) for an alias tier, otherwise the plain model label.
  String _modelResultLabel(String provider, String model) {
    if (model.isEmpty) return '默认';
    for (final e in _aliasTiers(provider)) {
      if (e.key != model) continue;
      final name = e.value['name']?.toString();
      if (name != null && name.isNotEmpty) return name;
      return e.value['model']?.toString() ?? model;
    }
    return _modelLabel(model);
  }

  String _effortDescription(String value) {
    if (!_isClaude) {
      switch (value) {
        case 'low':
          return 'Low — Fast responses with lighter reasoning';
        case 'medium':
          return 'Medium — Balances speed and reasoning depth for everyday tasks';
        case 'high':
          return 'High — Greater reasoning depth for complex problems';
        case 'xhigh':
          return 'Extra high — Extra high reasoning depth for complex problems';
      }
    }
    return value;
  }

  void _onProviderChanged(String? value) {
    final next = value ?? '';
    final choices = _modelChoices(next);
    setState(() {
      _provider = next;
      if (!choices.contains(_model)) {
        _model = '';
        _customModel = false;
        _customCtrl.clear();
      }
    });
  }

  void _onSubProviderChanged(String? value) {
    final next = value ?? '';
    final choices = _modelChoices(next);
    setState(() {
      _subProvider = next;
      if (!choices.contains(_subModel)) {
        _subModel = '';
        _customSubModel = false;
        _subCustomCtrl.clear();
      }
    });
  }

  void _submit() {
    final model = _customModel ? _customCtrl.text.trim() : _model;
    final subModel = _subProvider.isEmpty
        ? null
        : (_customSubModel ? _subCustomCtrl.text.trim() : _subModel);
    final subagent = (subModel != null && subModel.isNotEmpty)
        ? SessionSubagent(providerId: _subProvider, model: subModel)
        : null;
    Navigator.pop(
      context,
      _AIConfigResult(
        provider: _provider,
        model: model,
        effort: _effort,
        providerLabel: _providerName(_provider),
        modelLabel: _modelResultLabel(_provider, model),
        effortLabel: effortShortNameForCli(widget.cli, _effort),
        subagent: subagent,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final modelChoices = _modelChoices(_provider);
    final providerIds = widget.providers
        .map((p) => p['id']?.toString() ?? '')
        .toSet();
    final includeCurrentProvider =
        _provider.isNotEmpty && !providerIds.contains(_provider);
    final modelValue = _customModel
        ? '__custom__'
        : (modelChoices.contains(_model) ? _model : '');
    // Sub-task (subagent) cascade state for the view.
    final subModelChoices = _modelChoices(_subProvider);
    final subModelValue = _customSubModel
        ? '__custom__'
        : (subModelChoices.contains(_subModel)
            ? _subModel
            : (subModelChoices.isNotEmpty ? subModelChoices.first : ''));
    return SafeArea(
      child: Padding(
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
            Text(
              _isClaude
                  ? 'AI 配置（Provider / Model / Effort）'
                  : 'AI 配置（Provider / Model / Reasoning Level）',
              style: const TextStyle(
                color: AppColors.text,
                fontSize: 15,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 14),
            const Text(
              'Provider',
              style: TextStyle(color: AppColors.faint, fontSize: 12),
            ),
            const SizedBox(height: 5),
            DropdownButtonFormField<String>(
              value: _provider,
              dropdownColor: AppColors.panel,
              decoration: _sheetInputDecoration(),
              style: const TextStyle(color: AppColors.text, fontSize: 13),
              items: [
                const DropdownMenuItem(value: '', child: Text('默认登录 / 订阅')),
                if (includeCurrentProvider)
                  DropdownMenuItem(value: _provider, child: Text(_provider)),
                ...widget.providers.map(
                  (p) => DropdownMenuItem(
                    value: p['id']?.toString() ?? '',
                    child: Text(
                      '${p['name'] ?? p['id']}${p['model'] != null && p['model'].toString().isNotEmpty ? ' · ${p['model']}' : ''}',
                    ),
                  ),
                ),
              ],
              onChanged: _onProviderChanged,
            ),
            const SizedBox(height: 12),
            const Text(
              'Model',
              style: TextStyle(color: AppColors.faint, fontSize: 12),
            ),
            const SizedBox(height: 5),
            DropdownButtonFormField<String>(
              value: modelValue,
              dropdownColor: AppColors.panel,
              decoration: _sheetInputDecoration(),
              style: const TextStyle(color: AppColors.text, fontSize: 13),
              items: [
                ...modelChoices.map(
                  (m) => DropdownMenuItem(
                    value: m,
                    child: Text(_modelOptionLabel(_provider, m)),
                  ),
                ),
                const DropdownMenuItem(
                  value: '__custom__',
                  child: Text('自定义…'),
                ),
              ],
              onChanged: (v) {
                setState(() {
                  _customModel = v == '__custom__';
                  if (!_customModel) _model = v ?? '';
                });
              },
            ),
            if (_customModel) ...[
              const SizedBox(height: 8),
              TextField(
                controller: _customCtrl,
                autofocus: true,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 13,
                  fontFamily: 'monospace',
                ),
                decoration: _sheetInputDecoration(
                  hint: _isClaude ? 'claude-opus-4-8' : '模型 ID',
                ),
              ),
            ],
            const SizedBox(height: 12),
            Text(
              _isClaude ? 'Effort' : 'Reasoning Level',
              style: const TextStyle(color: AppColors.faint, fontSize: 12),
            ),
            const SizedBox(height: 5),
            DropdownButtonFormField<String>(
              value: _effort,
              dropdownColor: AppColors.panel,
              decoration: _sheetInputDecoration(),
              style: const TextStyle(color: AppColors.text, fontSize: 13),
              items: _validEfforts
                  .map(
                    (e) => DropdownMenuItem(
                      value: e,
                      child: Text(_effortDescription(e)),
                    ),
                  )
                  .toList(),
              onChanged: (v) => setState(() => _effort = v ?? _defaultEffort),
            ),
            if (_isClaude) ...[
              const Divider(height: 32),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  const Text(
                    '子任务 (subagent)',
                    style: TextStyle(
                        color: AppColors.text,
                        fontSize: 13,
                        fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Task 工具派生的子 agent 走的 provider+model，留空 = 随主（经 claude-proxy 路由）',
                      style: TextStyle(color: AppColors.faint, fontSize: 11),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              const Text('子任务 Provider',
                  style: TextStyle(color: AppColors.faint, fontSize: 12)),
              const SizedBox(height: 5),
              DropdownButtonFormField<String>(
                value: _subProvider,
                dropdownColor: AppColors.panel,
                decoration: _sheetInputDecoration(),
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                items: [
                  const DropdownMenuItem(value: '', child: Text('默认（随主）')),
                  ...widget.providers.map(
                    (p) => DropdownMenuItem(
                      value: p['id']?.toString() ?? '',
                      child: Text(
                        '${p['name'] ?? p['id']}${p['model'] != null && p['model'].toString().isNotEmpty ? ' · ${p['model']}' : ''}',
                      ),
                    ),
                  ),
                ],
                onChanged: _onSubProviderChanged,
              ),
              if (_subProvider.isNotEmpty) ...[
                const SizedBox(height: 12),
                const Text('子任务 Model',
                    style: TextStyle(color: AppColors.faint, fontSize: 12)),
                const SizedBox(height: 5),
                DropdownButtonFormField<String>(
                  value: subModelValue,
                  dropdownColor: AppColors.panel,
                  decoration: _sheetInputDecoration(),
                  style: const TextStyle(color: AppColors.text, fontSize: 13),
                  items: [
                    ...subModelChoices.map(
                      (m) => DropdownMenuItem(
                        value: m,
                        child: Text(_modelOptionLabel(_subProvider, m)),
                      ),
                    ),
                    const DropdownMenuItem(
                        value: '__custom__', child: Text('自定义…')),
                  ],
                  onChanged: (v) {
                    setState(() {
                      _customSubModel = v == '__custom__';
                      if (!_customSubModel) _subModel = v ?? '';
                    });
                  },
                ),
                if (_customSubModel) ...[
                  const SizedBox(height: 8),
                  TextField(
                    controller: _subCustomCtrl,
                    autofocus: true,
                    style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 13,
                        fontFamily: 'monospace'),
                    decoration: _sheetInputDecoration(hint: '模型 ID'),
                  ),
                ],
              ],
            ],
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('取消'),
                ),
                const SizedBox(width: 8),
                ElevatedButton(onPressed: _submit, child: const Text('保存')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Open the per-session AI-config sheet for [sessionId] (used by both the
/// header _ModelChip and the InputBar subagent pill). Fetches the provider list
/// fresh, seeds the sheet from the current session (incl. subagent override),
/// and PATCHes provider+model+effort+subagent on save.
Future<void> openAIConfigSheet(
  BuildContext context, {
  required SettingsService settings,
  required String sessionId,
}) async {
  final mgr = context.read<SessionManager>();
  Session? found;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) {
      found = x;
      break;
    }
  }
  if (found == null) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(t('sessionNotLoaded'))));
    return;
  }
  final sess = found;
  List<Map<String, dynamic>> providers = const [];
  try {
    final appType = sess.cli == SessionCli.codex ? 'codex' : 'claude';
    final d = await ManageService(settings: settings).fetchProviders(appType);
    providers =
        (d['providers'] as List? ?? []).map((e) => (e as Map).cast<String, dynamic>()).toList();
  } catch (_) {}
  if (!context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  final picked = await showModalBottomSheet<_AIConfigResult>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
    builder: (_) => _AIConfigSheet(
      cli: sess.cli,
      providers: providers,
      provider: sess.provider ?? '',
      model: sess.model ?? '',
      effort: sess.effectiveEffort ??
          sess.effort ??
          (sess.cli == SessionCli.codex ? 'xhigh' : 'medium'),
      subProviderId: sess.subagent?.providerId,
      subModel: sess.subagent?.model,
    ),
  );
  if (picked == null) return;
  try {
    await mgr.updateSessionAIConfig(
      sess.id,
      provider: picked.provider,
      model: picked.model,
      effort: picked.effort,
      subagent: picked.subagent,
      clearSubagent: picked.subagent == null,
    );
    messenger.showSnackBar(SnackBar(
      content: Text(
          '✓ AI 配置已保存：${picked.providerLabel} | ${picked.modelLabel} | ${picked.effortLabel}，下一轮对话生效'),
    ));
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('AI 配置保存失败：$e')));
  }
}

InputDecoration _sheetInputDecoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    hintStyle: const TextStyle(color: AppColors.faint),
    filled: true,
    fillColor: const Color(0xFF070809),
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(6),
      borderSide: const BorderSide(color: Color(0xFF20242b)),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(6),
      borderSide: const BorderSide(color: AppColors.accent),
    ),
  );
}

// Edit the per-session role prompt (system-prompt override) from the chat
// header overflow menu. Empty = clear → inherits the directory default.
Future<void> _editRoleFromSession(
  BuildContext context,
  String sessionId,
) async {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  final messenger = ScaffoldMessenger.of(context);
  Session? s;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) {
      s = x;
      break;
    }
  }
  if (s == null) {
    messenger.showSnackBar(const SnackBar(content: Text('Session 信息未加载')));
    return;
  }
  final picked = await _showRolePromptEditor(
    context,
    current: s.rolePrompt ?? '',
    settings: mgr.settings,
  );
  if (picked == null) return; // cancelled
  try {
    await mgr.updateSessionRolePrompt(s.id, picked);
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          picked.trim().isEmpty
              ? '✓ 已清除会话角色（继承目录默认），下一轮对话生效'
              : '✓ 角色提示词已更新，下一轮对话生效',
        ),
      ),
    );
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('角色保存失败：$e')));
  }
}

// View/edit the session's distilled memory (key problems + how they were
// solved). The aux AI maintains it on history clear/trim; here the user can read
// and tweak it. Fetched fresh since the AI may have updated it.
Future<void> _editMemoryFromSession(
  BuildContext context,
  String sessionId,
) async {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => MemoryScreen(
        settings: mgr.settings,
        sessionId: sessionId,
      ),
    ),
  );
}


// Share a session externally. Mirrors the web share dialog: create link with
// access type + optional password + expiry, list existing shares with type
// badges and revoke buttons, copy link to clipboard.
Future<void> _shareFromSession(
  BuildContext context,
  String sessionId,
  SettingsService settings,
) async {
  final svc = SessionService(settings: settings);
  String access = 'view';
  final pwCtrl = TextEditingController();
  int expiryHrs = 0;
  String? url;
  String? error;
  bool busy = false;
  List<Map<String, dynamic>> shares = [];
  bool loadingShares = true;

  Future<void> refreshShares(StateSetter setState) async {
    try {
      shares = await svc.listShares(sessionId);
    } catch (_) {
      shares = [];
    }
    setState(() => loadingShares = false);
  }

  await showDialog<void>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setState) {
        // Load shares on first build
        if (loadingShares) {
          refreshShares(setState);
        }
        return AlertDialog(
          backgroundColor: const Color(0xFF14171c),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: Color(0xFF20242b)),
          ),
          title: const Text(
            '分享会话',
            style: TextStyle(color: Color(0xFFe7eaee), fontSize: 16),
          ),
          content: SizedBox(
            width: 380,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '接收方在浏览器打开链接即可。',
                    style: TextStyle(color: Color(0xFF8b949e), fontSize: 12),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    '「可对话」= 对方能通过此会话在你机器上执行操作，务必设强密码。',
                    style: TextStyle(color: Color(0xFFe3853f), fontSize: 12),
                  ),
                  const SizedBox(height: 14),
                  // ── Access type ──
                  Row(
                    children: [
                      _expandedChoice(
                        'view',
                        '只读查看',
                        access,
                        (v) => setState(() => access = v),
                      ),
                      const SizedBox(width: 8),
                      _expandedChoice(
                        'operate',
                        '可对话',
                        access,
                        (v) => setState(() => access = v),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  // ── Password ──
                  TextField(
                    controller: pwCtrl,
                    style: const TextStyle(
                      color: Color(0xFFe7eaee),
                      fontSize: 14,
                    ),
                    decoration: const InputDecoration(
                      hintText: '密码（只读可留空；可对话必填）',
                      hintStyle: TextStyle(
                        color: Color(0xFF6e7681),
                        fontSize: 13,
                      ),
                      filled: true,
                      fillColor: Color(0xFF1c2128),
                      contentPadding: EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.all(Radius.circular(8)),
                        borderSide: BorderSide(color: Color(0xFF20242b)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  // ── Expiry ──
                  const Text(
                    '有效期',
                    style: TextStyle(color: Color(0xFF8b949e), fontSize: 11),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      _expiryChip(
                        '永不过期',
                        0,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                      _expiryChip(
                        '1h',
                        1,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                      _expiryChip(
                        '1天',
                        24,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                      _expiryChip(
                        '7天',
                        168,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  // ── Generate button ──
                  SizedBox(
                    width: double.infinity,
                    height: 42,
                    child: ElevatedButton(
                      onPressed: busy
                          ? null
                          : () async {
                              final pw = pwCtrl.text.trim();
                              if (access == 'operate' && pw.isEmpty) {
                                setState(() => error = '「可对话」必须设置密码');
                                return;
                              }
                              setState(() {
                                busy = true;
                                error = null;
                              });
                              try {
                                final r = await svc.createShare(
                                  sessionId,
                                  access: access,
                                  password: pw.isEmpty ? null : pw,
                                  expiresAt: expiryHrs > 0
                                      ? (DateTime.now().millisecondsSinceEpoch +
                                            expiryHrs * 3600 * 1000)
                                      : null,
                                );
                                setState(() {
                                  url = r['url'] as String?;
                                  busy = false;
                                });
                                pwCtrl.clear();
                                refreshShares(setState);
                              } catch (e) {
                                setState(() {
                                  error = '$e';
                                  busy = false;
                                });
                              }
                            },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF238636),
                        foregroundColor: Colors.white,
                      ),
                      child: busy
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : Text(url == null ? '生成链接' : '重新生成'),
                    ),
                  ),
                  if (error != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      error!,
                      style: const TextStyle(
                        color: Color(0xFFff6b63),
                        fontSize: 12,
                      ),
                    ),
                  ],
                  if (url != null) ...[
                    const SizedBox(height: 10),
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: const Color(0xFF1c2128),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFF20242b)),
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: SelectableText(
                              url!,
                              style: const TextStyle(
                                color: Color(0xFF79c0ff),
                                fontSize: 12,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          GestureDetector(
                            onTap: () {
                              Clipboard.setData(ClipboardData(text: url!));
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(content: Text('链接已复制')),
                              );
                            },
                            child: const Icon(
                              Icons.copy,
                              size: 18,
                              color: Color(0xFF8b949e),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                  // ── Existing shares ──
                  const SizedBox(height: 18),
                  const Text(
                    '已有分享',
                    style: TextStyle(
                      color: Color(0xFF8b949e),
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  if (loadingShares)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 12),
                      child: Center(
                        child: SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Color(0xFF8b949e),
                          ),
                        ),
                      ),
                    )
                  else if (shares.isEmpty)
                    const Text(
                      '暂无',
                      style: TextStyle(color: Color(0xFF6e7681), fontSize: 13),
                    )
                  else
                    ...shares.map(
                      (s) => _shareCard(s, () async {
                        final token = s['token'] as String;
                        try {
                          await svc.deleteShare(sessionId, token);
                          setState(
                            () =>
                                shares.removeWhere((x) => x['token'] == token),
                          );
                        } catch (e) {
                          if (ctx.mounted) {
                            ScaffoldMessenger.of(
                              context,
                            ).showSnackBar(SnackBar(content: Text('撤销失败：$e')));
                          }
                        }
                      }),
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text(
                '关闭',
                style: TextStyle(color: Color(0xFF8b949e)),
              ),
            ),
          ],
        );
      },
    ),
  );
}

Widget _expandedChoice(
  String value,
  String label,
  String current,
  ValueChanged<String> onChanged,
) {
  final sel = current == value;
  return Expanded(
    child: GestureDetector(
      onTap: () => onChanged(value),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 9),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: sel ? const Color(0xFF1a3a5c) : const Color(0xFF1c2128),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: sel ? const Color(0xFF58a6ff) : const Color(0xFF20242b),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: sel ? const Color(0xFF79c0ff) : const Color(0xFF8b949e),
            fontWeight: sel ? FontWeight.w600 : FontWeight.w400,
            fontSize: 13,
          ),
        ),
      ),
    ),
  );
}

Widget _expiryChip(
  String label,
  int value,
  int current,
  ValueChanged<int> onChanged,
) {
  final sel = current == value;
  return Padding(
    padding: const EdgeInsets.only(right: 8),
    child: GestureDetector(
      onTap: () => onChanged(value),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: sel ? const Color(0xFF1a3a5c) : const Color(0xFF1c2128),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(
            color: sel ? const Color(0xFF58a6ff) : const Color(0xFF20242b),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: sel ? const Color(0xFF79c0ff) : const Color(0xFF8b949e),
            fontWeight: sel ? FontWeight.w500 : FontWeight.w400,
            fontSize: 12,
          ),
        ),
      ),
    ),
  );
}

String _shareTypeLabel(Map<String, dynamic> s) {
  if (s['type'] == 'messages') {
    return '📎 消息快照·${s['messageCount'] ?? 0}条${s['hasPassword'] == true ? '·密码' : ''}';
  }
  if (s['access'] == 'operate') return '🔌 可对话';
  if (s['hasPassword'] == true) return '🔒 密码查看';
  return '🌐 公开查看';
}

Widget _shareCard(Map<String, dynamic> s, VoidCallback onRevoke) {
  final exp = s['expiresAt'] as int?;
  final expStr = exp != null && exp > 0
      ? ' · 到期 ${DateTime.fromMillisecondsSinceEpoch(exp).toLocal().toString().substring(0, 16)}'
      : '';
  final url = (s['url'] as String?) ?? '';
  return Container(
    margin: const EdgeInsets.only(bottom: 8),
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: const Color(0xFF1c2128),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: const Color(0xFF20242b)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                '${_shareTypeLabel(s)}$expStr',
                style: const TextStyle(color: Color(0xFF79c0ff), fontSize: 12),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 8),
            GestureDetector(
              onTap: () {
                Clipboard.setData(ClipboardData(text: url));
                if (s['url'] != null) {
                  // Access via mounted context — just use a simple approach
                  try {
                    Clipboard.setData(ClipboardData(text: url));
                  } catch (_) {}
                }
              },
              child: const Icon(Icons.copy, size: 16, color: Color(0xFF6e7681)),
            ),
            const SizedBox(width: 6),
            GestureDetector(
              onTap: onRevoke,
              child: const Icon(
                Icons.close_rounded,
                size: 18,
                color: Color(0xFFf85149),
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          url,
          style: const TextStyle(
            color: Color(0xFF6e7681),
            fontSize: 11,
            fontFamily: 'monospace',
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    ),
  );
}

// Multi-line role-prompt editor dialog. Returns the new text, or null on cancel.
// [settings] enables the preset picker (small chip strip + full browser). When
// omitted the editor degrades to a plain text field.
Future<String?> _showRolePromptEditor(
  BuildContext context, {
  required String current,
  SettingsService? settings,
}) {
  return showDialog<String>(
    context: context,
    builder: (ctx) =>
        _RolePromptEditorDialog(current: current, settings: settings),
  );
}

// Stateful editor dialog: a preset area sits above the free-text field. The
// preset area lazily loads the index, renders the featured presets as a
// horizontally scrollable chip strip, and exposes a "browse all" entry that
// opens [AgentPresetPickerSheet]. Picking a preset fetches its prompt and fills
// the text field (confirming first when the field is non-empty).
class _RolePromptEditorDialog extends StatefulWidget {
  final String current;
  final SettingsService? settings;
  const _RolePromptEditorDialog({required this.current, this.settings});

  @override
  State<_RolePromptEditorDialog> createState() =>
      _RolePromptEditorDialogState();
}

class _RolePromptEditorDialogState extends State<_RolePromptEditorDialog> {
  late final TextEditingController _controller;
  AgentPresetService? _svc;
  AgentPresetIndex? _index;
  bool _loadingIndex = false;
  String? _indexError;
  bool _applying = false; // fetching a prompt to fill the field

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.current);
    if (widget.settings != null) {
      _svc = AgentPresetService(settings: widget.settings!);
      _loadIndex();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _loadIndex({bool forceRefresh = false}) async {
    if (_svc == null) return;
    setState(() {
      _loadingIndex = true;
      _indexError = null;
    });
    try {
      final idx = await _svc!.fetchIndex(forceRefresh: forceRefresh);
      if (!mounted) return;
      setState(() {
        _index = idx;
        _loadingIndex = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _indexError = '$e';
        _loadingIndex = false;
      });
    }
  }

  // Fetch the prompt for [id] and put it in the field. If the field already has
  // content, confirm a replace first.
  Future<void> _applyPreset(String id) async {
    if (_svc == null || _applying) return;
    if (_controller.text.trim().isNotEmpty) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          backgroundColor: AppColors.panel2,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: AppColors.line),
          ),
          title: const Text(
            '替换当前内容?',
            style: TextStyle(color: AppColors.text, fontSize: 15),
          ),
          content: const Text(
            '文本框已有内容，使用该模板会覆盖现有文字。',
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c, false),
              child: const Text('取消', style: TextStyle(color: AppColors.muted)),
            ),
            TextButton(
              onPressed: () => Navigator.pop(c, true),
              child: const Text(
                '替换',
                style: TextStyle(color: AppColors.danger),
              ),
            ),
          ],
        ),
      );
      if (ok != true) return;
    }
    setState(() => _applying = true);
    try {
      final prompt = await _svc!.fetchPrompt(id);
      if (!mounted) return;
      setState(() {
        _controller.text = prompt;
        _applying = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _applying = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('模板加载失败：$e')));
    }
  }

  Future<void> _browseAll() async {
    if (_svc == null) return;
    final id = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => AgentPresetPickerSheet(service: _svc!, index: _index),
    );
    if (id != null && id.isNotEmpty) {
      await _applyPreset(id);
    }
  }

  Widget _presetArea() {
    if (_svc == null) return const SizedBox.shrink();
    Widget body;
    if (_loadingIndex && _index == null) {
      body = const Padding(
        padding: EdgeInsets.symmetric(vertical: 10),
        child: SizedBox(
          height: 16,
          width: 16,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: AppColors.accent,
          ),
        ),
      );
    } else if (_indexError != null && _index == null) {
      body = Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            const Expanded(
              child: Text(
                '模板加载失败',
                style: TextStyle(color: AppColors.danger, fontSize: 12),
              ),
            ),
            TextButton(
              onPressed: () => _loadIndex(forceRefresh: true),
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 28),
                padding: const EdgeInsets.symmetric(horizontal: 8),
              ),
              child: const Text(
                '重试',
                style: TextStyle(color: AppColors.accent, fontSize: 12),
              ),
            ),
          ],
        ),
      );
    } else {
      final featured = _index?.featuredPresets ?? const <AgentPreset>[];
      body = SizedBox(
        height: 34,
        child: featured.isEmpty
            ? const Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '暂无推荐模板',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
              )
            : ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: featured.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, i) {
                  final p = featured[i];
                  return _PresetChip(
                    preset: p,
                    onTap: _applying ? null : () => _applyPreset(p.id),
                  );
                },
              ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Text(
              '预设角色',
              style: TextStyle(color: AppColors.muted, fontSize: 12),
            ),
            const Spacer(),
            TextButton(
              onPressed: _browseAll,
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 28),
                padding: const EdgeInsets.symmetric(horizontal: 6),
              ),
              child: const Text(
                '浏览全部模板 →',
                style: TextStyle(color: AppColors.accent, fontSize: 12),
              ),
            ),
          ],
        ),
        body,
        const SizedBox(height: 8),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.panel2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: AppColors.line),
      ),
      title: Row(
        children: [
          const Text(
            '角色提示词',
            style: TextStyle(color: AppColors.text, fontSize: 16),
          ),
          if (_applying) ...[
            const SizedBox(width: 10),
            const SizedBox(
              height: 14,
              width: 14,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: AppColors.accent,
              ),
            ),
          ],
        ],
      ),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _presetArea(),
            TextField(
              controller: _controller,
              maxLines: 9,
              minLines: 5,
              maxLength: 40000,
              autofocus: false,
              style: const TextStyle(color: AppColors.text, fontSize: 13),
              decoration: const InputDecoration(
                hintText:
                    '例如：你是开发保姆，被触发时用 multicc-trigger skill 检查 git 改动并提醒提交和测试，不要擅自改代码。',
                hintStyle: TextStyle(color: Color(0xFF6b7280), fontSize: 12),
                enabledBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: AppColors.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: AppColors.accentDark),
                ),
              ),
            ),
            const Text(
              '留空＝清除（会话将继承目录默认角色）',
              style: TextStyle(color: AppColors.muted, fontSize: 11),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消', style: TextStyle(color: AppColors.muted)),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, _controller.text),
          child: const Text('保存', style: TextStyle(color: Color(0xFF3fb950))),
        ),
      ],
    );
  }
}

// A compact featured-preset chip: emoji + name, outlined with the category
// color. Used in the small preset strip inside the editor.
class _PresetChip extends StatelessWidget {
  final AgentPreset preset;
  final VoidCallback? onTap;
  const _PresetChip({required this.preset, this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = preset.accentColor;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: c.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: c.withValues(alpha: 0.55)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (preset.emoji.isNotEmpty) ...[
                Text(preset.emoji, style: const TextStyle(fontSize: 13)),
                const SizedBox(width: 6),
              ],
              Text(
                preset.name,
                style: TextStyle(
                  color: AppColors.text,
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// Open the directory-memo screen for the given session's directory. Used by the
// chat AppBar to expose the project memo without leaving the chat view.
void _openMemoFromSession(BuildContext context, String sessionId) {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  Session? s;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) {
      s = x;
      break;
    }
  }
  if (s == null) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Session 信息未加载')));
    return;
  }
  Directory? d;
  for (final x in mgr.directories) {
    if (x.id == s.dirId) {
      d = x;
      break;
    }
  }
  if (d == null) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('找不到对应目录')));
    return;
  }
  Navigator.push(
    context,
    MaterialPageRoute<void>(
      builder: (_) => MemoScreen(directory: d!, mgr: mgr),
    ),
  );
}

Future<void> confirmMergeWorktree(
  BuildContext context,
  SettingsService settings,
  String sessionId,
) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => AlertDialog(
      backgroundColor: const Color(0xFF0f1115),
      title: const Text(
        '合并 worktree',
        style: TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
      ),
      content: const Text(
        '把此会话 worktree 的改动合并回基分支？\n未提交的改动会先自动提交。',
        style: TextStyle(color: Color(0xFFe7eaee)),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('取消', style: TextStyle(color: Color(0xFF8a909b))),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text(
            '合并',
            style: TextStyle(
              color: Color(0xFF6aa3ff),
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  messenger.showSnackBar(const SnackBar(content: Text('正在合并 worktree...')));
  try {
    final result = await SessionService(
      settings: settings,
    ).mergeSession(sessionId);
    final hasConflict =
        result['conflicts'] is List && (result['conflicts'] as List).isNotEmpty;
    String msg;
    if (result['ok'] == true) {
      msg = result['merged'] == true
          ? '✓ 已合并 ${result['commits']} 个提交回基分支'
          : '✓ ${result['message'] ?? '没有新提交需要合并'}';
    } else if (result['conflicts'] != null) {
      msg = '⚠️ 合并冲突，已 abort：${(result['conflicts'] as List).join(', ')}';
    } else {
      msg = '合并失败：${result['error'] ?? ''}';
    }
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text(msg)));
    if (hasConflict && context.mounted) {
      await showConflictDiffDialog(
        context,
        sessionId: sessionId,
        result: result,
      );
    }
  } catch (e) {
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text('合并请求失败：$e')));
  }
}

class _HeaderBtn extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  const _HeaderBtn({
    required this.icon,
    required this.tooltip,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(6),
          decoration: BoxDecoration(
            color: const Color(0xFF14171c),
            border: Border.all(color: const Color(0xFF20242b)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Icon(icon, color: const Color(0xFFe7eaee), size: 18),
        ),
      ),
    );
  }
}

/// Clear-context button for the chat header. Mirrors the web client's "Clear"
/// button: tapping opens a small popup with two options —
///   • 清空全部 (clear all)  → clearHistory(keep: 0)
///   • 保留最近 N 条          → clearHistory(keep: N)
/// The provider's clearHistory() cancels any in-flight stream before wiping,
/// so clearing while streaming actually takes effect instead of looking like a
/// no-op (the running CLI process gets killed first).
class _ClearCtxButton extends StatefulWidget {
  final ChatProvider provider;
  const _ClearCtxButton({required this.provider});

  @override
  State<_ClearCtxButton> createState() => _ClearCtxButtonState();
}

class _ClearCtxButtonState extends State<_ClearCtxButton> {
  final _keepCtrl = TextEditingController(text: '5');
  bool _menuOpen = false;
  final _layerLink = LayerLink();
  OverlayEntry? _overlay;

  void _closeMenu() {
    _overlay?.remove();
    _overlay = null;
    if (mounted) setState(() => _menuOpen = false);
  }

  void _openMenu() {
    if (_menuOpen) {
      _closeMenu();
      return;
    }
    setState(() => _menuOpen = true);
    _overlay = OverlayEntry(
      builder: (ctx) => _ClearMenuBody(
        link: _layerLink,
        keepCtrl: _keepCtrl,
        onClearAll: () {
          _closeMenu();
          widget.provider.clearHistory(keep: 0);
        },
        onClearKeep: () {
          final n = int.tryParse(_keepCtrl.text.trim()) ?? 5;
          _closeMenu();
          widget.provider.clearHistory(keep: n < 1 ? 1 : n);
        },
        onDismiss: _closeMenu,
      ),
    );
    Overlay.of(context).insert(_overlay!);
  }

  @override
  void dispose() {
    _overlay?.remove();
    _keepCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CompositedTransformTarget(
      link: _layerLink,
      child: Tooltip(
        message: t('clearCtx'),
        child: GestureDetector(
          onTap: _openMenu,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            decoration: BoxDecoration(
              color: const Color(0xFF14171c),
              border: Border.all(color: const Color(0xFF20242b)),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.delete_sweep_outlined,
                  color: const Color(0xFFff6b63),
                  size: 16,
                ),
                const SizedBox(width: 4),
                Text(
                  t('clearCtx'),
                  style: const TextStyle(
                    color: Color(0xFFff6b63),
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ClearMenuBody extends StatelessWidget {
  final LayerLink link;
  final TextEditingController keepCtrl;
  final VoidCallback onClearAll;
  final VoidCallback onClearKeep;
  final VoidCallback onDismiss;
  const _ClearMenuBody({
    required this.link,
    required this.keepCtrl,
    required this.onClearAll,
    required this.onClearKeep,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        // Tap-outside dismiss layer
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onDismiss,
          child: const SizedBox.expand(),
        ),
        CompositedTransformFollower(
          link: link,
          targetAnchor: Alignment.bottomRight,
          followerAnchor: Alignment.topRight,
          offset: const Offset(0, 6),
          child: Material(
            color: Colors.transparent,
            child: Container(
              width: 180,
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: const Color(0xFF14171c),
                border: Border.all(color: const Color(0xFF20242b)),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Clear all
                  InkWell(
                    onTap: onClearAll,
                    borderRadius: BorderRadius.circular(6),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 9,
                      ),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.delete_sweep_outlined,
                            size: 16,
                            color: Color(0xFFff6b63),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            t('clearAll'),
                            style: const TextStyle(
                              color: Color(0xFFff6b63),
                              fontSize: 13,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 44,
                          child: TextField(
                            controller: keepCtrl,
                            keyboardType: TextInputType.number,
                            style: const TextStyle(
                              color: Color(0xFFe7eaee),
                              fontSize: 12,
                            ),
                            decoration: InputDecoration(
                              isDense: true,
                              contentPadding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 6,
                              ),
                              enabledBorder: OutlineInputBorder(
                                borderSide: const BorderSide(
                                  color: Color(0xFF20242b),
                                ),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              focusedBorder: OutlineInputBorder(
                                borderSide: const BorderSide(
                                  color: Color(0xFF3ad6c5),
                                ),
                                borderRadius: BorderRadius.circular(4),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            t('clearKeepLast'),
                            style: const TextStyle(
                              color: Color(0xFF8a909b),
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: TextButton(
                      onPressed: onClearKeep,
                      style: TextButton.styleFrom(
                        foregroundColor: const Color(0xFF22ab9c),
                        padding: const EdgeInsets.symmetric(vertical: 4),
                      ),
                      child: Text(
                        t('clearKeepConfirm'),
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Overflow menu for the chat header. Collapses the occasional actions
/// (memo / merge worktree / settings) behind a single "⋮"
/// trigger, keeping the header's action cluster a fixed, compact width so its
/// icons never overflow the right edge on narrow screens.
class _HeaderOverflowMenu extends StatelessWidget {
  final bool mergeReady;
  final VoidCallback onRole;
  final VoidCallback onMemory;
  final VoidCallback onMemo;
  final VoidCallback onMerge;
  final VoidCallback onSettings;
  final VoidCallback onShare;
  final VoidCallback onShareMessages;
  final VoidCallback onFiles;
  final VoidCallback onRestart;
  const _HeaderOverflowMenu({
    required this.mergeReady,
    required this.onRole,
    required this.onMemory,
    required this.onMemo,
    required this.onMerge,
    required this.onSettings,
    required this.onShare,
    required this.onShareMessages,
    required this.onFiles,
    required this.onRestart,
  });

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      tooltip: t('moreActions'),
      color: const Color(0xFF14171c),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: const BorderSide(color: Color(0xFF20242b)),
      ),
      offset: const Offset(0, 40),
      onSelected: (value) {
        switch (value) {
          case 'role':
            onRole();
            break;
          case 'memory':
            onMemory();
            break;
          case 'memo':
            onMemo();
            break;
          case 'merge':
            onMerge();
            break;
          case 'share':
            onShare();
            break;
          case 'share-msgs':
            onShareMessages();
            break;
          case 'files':
            onFiles();
            break;
          case 'restart':
            onRestart();
            break;
          case 'settings':
            onSettings();
            break;
        }
      },
      itemBuilder: (_) => [
        _item(
          'role',
          Icons.theater_comedy_outlined,
          t('rolePrompt'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'memory',
          Icons.psychology_outlined,
          t('sessionMemory'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'memo',
          Icons.sticky_note_2_outlined,
          t('projectMemo'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'share',
          Icons.share_outlined,
          t('shareSession'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'share-msgs',
          Icons.checklist_rtl_outlined,
          t('shareMessages'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'merge',
          Icons.merge_type,
          mergeReady
              ? t('mergeWorktreeReady', {'base': ''})
              : t('mergeWorktree'),
          mergeReady ? const Color(0xFFe3b341) : const Color(0xFFe7eaee),
        ),
        _item(
          'files',
          Icons.folder_open_outlined,
          t('fileBrowser'),
          const Color(0xFFe7eaee),
        ),
        _item(
          'restart',
          Icons.restart_alt_rounded,
          t('restartCli'),
          const Color(0xFFe3b341),
        ),
        const PopupMenuDivider(),
        _item(
          'settings',
          Icons.settings_outlined,
          t('settings'),
          const Color(0xFFe7eaee),
        ),
      ],
      child: Container(
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: mergeReady ? const Color(0xFFe3b341) : const Color(0xFF14171c),
          border: Border.all(
            color: mergeReady
                ? const Color(0xFFe3b341)
                : const Color(0xFF20242b),
          ),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Icon(
          Icons.more_vert,
          color: mergeReady ? const Color(0xFF070809) : const Color(0xFFe7eaee),
          size: 18,
        ),
      ),
    );
  }

  PopupMenuItem<String> _item(
    String value,
    IconData icon,
    String label,
    Color color,
  ) {
    return PopupMenuItem<String>(
      value: value,
      height: 44,
      child: Row(
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 12),
          Text(label, style: TextStyle(color: color, fontSize: 14)),
        ],
      ),
    );
  }
}

String _mergeStatusText(Map<String, dynamic>? status) {
  if (status?['mergeReady'] != true) return '当前 worktree 没有需要合并的内容。';
  final bits = <String>[];
  if (status?['dirty'] == true) bits.add('有未提交改动');
  final ahead = (status?['ahead'] as num?)?.toInt() ?? 0;
  if (ahead > 0) bits.add('$ahead 个提交领先');
  final detail = bits.isEmpty ? '有可合并内容' : bits.join('，');
  return '$detail，可合并回 ${status?['baseBranch'] ?? '基分支'}。';
}

class _MergeReadyBanner extends StatelessWidget {
  final String text;
  final VoidCallback onMerge;
  final VoidCallback onDiff;
  const _MergeReadyBanner({
    required this.text,
    required this.onMerge,
    required this.onDiff,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF2d2108),
        border: Border.all(color: const Color(0xFFe3b341)),
        borderRadius: BorderRadius.circular(8),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.28),
            blurRadius: 16,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        children: [
          const Icon(
            Icons.merge_type_rounded,
            size: 16,
            color: Color(0xFFf2cc60),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(color: Color(0xFFf2cc60), fontSize: 12),
            ),
          ),
          TextButton(
            onPressed: onDiff,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFFf2cc60),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              minimumSize: Size.zero,
              side: const BorderSide(color: Color(0xFFe3b341)),
            ),
            child: const Text(
              '查看 Diff',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: 6),
          TextButton(
            onPressed: onMerge,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFF070809),
              backgroundColor: const Color(0xFFe3b341),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              minimumSize: Size.zero,
            ),
            child: const Text(
              '合并',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

// Persistent top banner shown while the session's worktree is behind its base
// branch — complements the transient SnackBar with an always-visible reminder.
class _BehindMainBanner extends StatelessWidget {
  final int behind;
  final String baseBranch;
  final VoidCallback onSync;
  final bool syncing;
  const _BehindMainBanner({
    required this.behind,
    required this.baseBranch,
    required this.onSync,
    this.syncing = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF2d2108),
        border: Border.all(color: const Color(0xFFe3b341)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          const Icon(Icons.history_rounded, size: 16, color: Color(0xFFf2cc60)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '当前 worktree 落后 $baseBranch $behind 个提交',
              style: const TextStyle(color: Color(0xFFf2cc60), fontSize: 12),
            ),
          ),
          TextButton(
            onPressed: syncing ? null : onSync,
            style: TextButton.styleFrom(
              foregroundColor: const Color(0xFF070809),
              backgroundColor: const Color(0xFFe3b341),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              minimumSize: Size.zero,
            ),
            child: Text(
              syncing ? '同步中…' : '同步',
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

class _CwdBar extends StatelessWidget {
  final Map<String, dynamic>? mergeStatus;
  const _CwdBar({this.mergeStatus});

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final branch = mergeStatus?['branch']?.toString();
    final behind = (mergeStatus?['behind'] as num?)?.toInt() ?? 0;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: const BoxDecoration(
        color: Color(0xFF070809),
        border: Border(bottom: BorderSide(color: Color(0xFF14171c))),
      ),
      child: Row(
        children: [
          const Icon(Icons.folder_outlined, size: 14, color: Color(0xFF5b616c)),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              provider.cwd.isEmpty ? '(unknown)' : provider.cwd,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 12,
                color: Color(0xFF6aa3ff),
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (branch != null && branch.isNotEmpty) ...[
            const SizedBox(width: 8),
            // Worktree branch chip — makes each session's isolated worktree explicit.
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: behind > 0
                    ? const Color(0xFF2d2108)
                    : const Color(0xFF12161c),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(
                  color: behind > 0
                      ? const Color(0xFFe3b341)
                      : const Color(0xFF24303f),
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.account_tree_outlined,
                    size: 11,
                    color: behind > 0
                        ? const Color(0xFFf2cc60)
                        : const Color(0xFF6aa3ff),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    branch,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: behind > 0
                          ? const Color(0xFFf2cc60)
                          : const Color(0xFF8a909b),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(width: 8),
          GestureDetector(
            onTap: () => _showCwdDialog(context, provider),
            child: const Text(
              'Change',
              style: TextStyle(fontSize: 11, color: Color(0xFF8a909b)),
            ),
          ),
        ],
      ),
    );
  }

  void _showCwdDialog(BuildContext context, ChatProvider provider) {
    final ctrl = TextEditingController(text: provider.cwd);
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text(
          'Change Working Directory',
          style: TextStyle(fontSize: 15),
        ),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: const TextStyle(
            color: Color(0xFFe7eaee),
            fontFamily: 'monospace',
            fontSize: 13,
          ),
          decoration: InputDecoration(
            hintText: '/path/to/project',
            hintStyle: const TextStyle(color: Color(0xFF454b54)),
            filled: true,
            fillColor: const Color(0xFF070809),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(6),
              borderSide: const BorderSide(color: Color(0xFF20242b)),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text(
              'Cancel',
              style: TextStyle(color: Color(0xFF8a909b)),
            ),
          ),
          TextButton(
            onPressed: () {
              final newCwd = ctrl.text.trim();
              Navigator.pop(context);
              if (newCwd.isNotEmpty && newCwd != provider.cwd) {
                provider.changeCwd(newCwd);
              }
            },
            child: const Text(
              'Apply',
              style: TextStyle(
                color: Color(0xFF6aa3ff),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Minimum gap (minutes) between two consecutive messages before a time
/// separator is drawn between them.
const int _timeSeparatorGapMinutes = 5;

/// Human-friendly time label for a chat separator, relative to now:
/// today → "HH:mm", yesterday → "昨天 HH:mm", within a week → "周X HH:mm",
/// same year → "M月d日 HH:mm", otherwise "yyyy年M月d日 HH:mm".
String formatChatTime(DateTime t) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(t.year, t.month, t.day);
  final hm =
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  final diffDays = today.difference(day).inDays;
  if (diffDays == 0) return hm;
  if (diffDays == 1) return '昨天 $hm';
  if (diffDays > 1 && diffDays < 7) {
    const week = ['一', '二', '三', '四', '五', '六', '日'];
    return '周${week[t.weekday - 1]} $hm';
  }
  if (t.year == now.year) return '${t.month}月${t.day}日 $hm';
  return '${t.year}年${t.month}月${t.day}日 $hm';
}

/// Centered, pill-shaped time label inserted between distant messages.
class _TimeSeparator extends StatelessWidget {
  final DateTime time;
  const _TimeSeparator({required this.time});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
          decoration: BoxDecoration(
            color: const Color(0xFF14171c),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Text(
            formatChatTime(time),
            style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
          ),
        ),
      ),
    );
  }
}

class _MessageList extends StatefulWidget {
  final ScrollController scrollCtrl;
  const _MessageList({required this.scrollCtrl});

  @override
  State<_MessageList> createState() => _MessageListState();
}

class _MessageListState extends State<_MessageList> {
  bool _userScrolled = false;

  @override
  void initState() {
    super.initState();
    widget.scrollCtrl.addListener(_onScroll);
  }

  void _onScroll() {
    if (!widget.scrollCtrl.hasClients) return;
    final pos = widget.scrollCtrl.position;
    final atBottom = pos.pixels >= pos.maxScrollExtent - 60;
    if (atBottom && _userScrolled) {
      setState(() => _userScrolled = false);
    } else if (!atBottom && !_userScrolled) {
      setState(() => _userScrolled = true);
    }
  }

  void _scrollToBottom() {
    if (!widget.scrollCtrl.hasClients || _userScrolled) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (widget.scrollCtrl.hasClients) {
        widget.scrollCtrl.animateTo(
          widget.scrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 150),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final messages = provider.messages;
    final showThinking =
        provider.isStreaming &&
        (messages.isEmpty ||
            messages.last.role != MessageRole.assistant ||
            messages.last.content.isEmpty && messages.last.toolCalls.isEmpty);

    _scrollToBottom();

    return LayoutBuilder(
      builder: (context, constraints) {
        final viewportWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.of(context).size.width;
        final desktop = viewportWidth >= _chatDesktopBreakpoint;
        final contentWidth =
            desktop && viewportWidth > _chatMaxContentWidth
                ? _chatMaxContentWidth
                : viewportWidth;
        final sidePadding =
            ((viewportWidth - contentWidth) / 2) +
            (desktop ? _chatDesktopSidePadding : _chatMobileSidePadding);

        return Stack(
          children: [
            ListView.builder(
              controller: widget.scrollCtrl,
              padding: EdgeInsets.fromLTRB(sidePadding, 12, sidePadding, 12),
              itemCount: messages.length + (showThinking ? 1 : 0),
              itemBuilder: (_, i) {
                if (i == messages.length) return const ThinkingIndicator();
                final msg = messages[i];
                // WeChat-style time separator: show a centered time label only when
                // this message is the first, or its gap from the previous message
                // exceeds the threshold — so back-to-back turns stay uncluttered.
                final prev = i > 0 ? messages[i - 1] : null;
                final showTime =
                    prev == null ||
                    msg.timestamp.difference(prev.timestamp).inMinutes.abs() >=
                        _timeSeparatorGapMinutes;
                if (!showTime) return MessageBubble(message: msg);
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _TimeSeparator(time: msg.timestamp),
                    MessageBubble(message: msg),
                  ],
                );
              },
            ),
            if (_userScrolled)
              Positioned(
                bottom: 8,
                right: 8,
                child: GestureDetector(
                  onTap: () {
                    setState(() => _userScrolled = false);
                    _scrollToBottom();
                  },
                  child: Container(
                    padding: const EdgeInsets.all(6),
                    decoration: BoxDecoration(
                      color: const Color(0xFF22ab9c),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: const Icon(
                      Icons.keyboard_arrow_down,
                      color: Colors.white,
                      size: 20,
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _CostBar extends StatelessWidget {
  const _CostBar();

  @override
  Widget build(BuildContext context) {
    final costText = context.watch<ChatProvider>().costText;
    if (costText.isEmpty) return const SizedBox.shrink();
    return Container(
      color: const Color(0xFF070809),
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Text(
        costText,
        textAlign: TextAlign.center,
        style: const TextStyle(color: Color(0xFF5b616c), fontSize: 11),
      ),
    );
  }
}

class _ChatCliBadge extends StatelessWidget {
  final SessionCli cli;
  const _ChatCliBadge({required this.cli});
  @override
  Widget build(BuildContext context) {
    final color = cli == SessionCli.codex
        ? const Color(0xFF7fd49a)
        : const Color(0xFFf0936b);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        border: Border.all(color: color.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        cli.name,
        style: TextStyle(
          color: color,
          fontSize: 9,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

// ── Agent preset picker (full browser) ──────────────────────────────────────

/// A near-full-height bottom sheet for browsing every role-prompt preset:
/// search box, single-select category filter, a card list, and a footer
/// "use selected" action. Pops with the selected preset id, or null on cancel.
class AgentPresetPickerSheet extends StatefulWidget {
  final AgentPresetService service;
  final AgentPresetIndex? index; // optional warm cache from the editor
  const AgentPresetPickerSheet({super.key, required this.service, this.index});

  @override
  State<AgentPresetPickerSheet> createState() => _AgentPresetPickerSheetState();
}

class _AgentPresetPickerSheetState extends State<AgentPresetPickerSheet> {
  final _searchCtrl = TextEditingController();
  AgentPresetIndex? _index;
  bool _loading = false;
  String? _error;
  String _query = '';
  String _category = ''; // '' = all
  String? _selectedId;

  @override
  void initState() {
    super.initState();
    _index = widget.index;
    if (_index == null) _load();
    _searchCtrl.addListener(() {
      setState(() => _query = _searchCtrl.text.trim().toLowerCase());
    });
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _load({bool forceRefresh = false}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final idx = await widget.service.fetchIndex(forceRefresh: forceRefresh);
      if (!mounted) return;
      setState(() {
        _index = idx;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  List<AgentPreset> get _filtered {
    final all = _index?.presets ?? const <AgentPreset>[];
    return all.where((p) {
      if (_category.isNotEmpty && p.category != _category) return false;
      if (_query.isEmpty) return true;
      return p.name.toLowerCase().contains(_query) ||
          p.description.toLowerCase().contains(_query);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.of(context).size.height * 0.92;
    final categories = _index?.categories ?? const <AgentCategory>[];
    return Container(
      height: height,
      decoration: const BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        border: Border(top: BorderSide(color: AppColors.line)),
      ),
      child: Column(
        children: [
          // grabber + title
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 8, 6),
            child: Row(
              children: [
                const Text(
                  '选择角色模板',
                  style: TextStyle(
                    color: AppColors.textBright,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                IconButton(
                  icon: const Icon(
                    Icons.close,
                    color: AppColors.muted,
                    size: 20,
                  ),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
          ),
          // search
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: TextField(
              controller: _searchCtrl,
              style: const TextStyle(color: AppColors.text, fontSize: 14),
              decoration: InputDecoration(
                isDense: true,
                prefixIcon: const Icon(
                  Icons.search,
                  color: AppColors.faint,
                  size: 18,
                ),
                hintText: '搜索名称或描述…',
                hintStyle: const TextStyle(
                  color: AppColors.faint,
                  fontSize: 13,
                ),
                filled: true,
                fillColor: AppColors.panel2,
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: const BorderSide(color: AppColors.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: const BorderSide(color: AppColors.accentDark),
                ),
              ),
            ),
          ),
          // category chips
          if (categories.isNotEmpty)
            SizedBox(
              height: 38,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: categories.length + 1,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, i) {
                  if (i == 0) {
                    return _CategoryChip(
                      label: '全部',
                      selected: _category.isEmpty,
                      onTap: () => setState(() => _category = ''),
                    );
                  }
                  final cat = categories[i - 1];
                  return _CategoryChip(
                    label: cat.count > 0
                        ? '${cat.label} ${cat.count}'
                        : cat.label,
                    selected: _category == cat.key,
                    onTap: () => setState(() => _category = cat.key),
                  );
                },
              ),
            ),
          const SizedBox(height: 4),
          Expanded(child: _listBody()),
          // footer
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => Navigator.pop(context),
                      style: OutlinedButton.styleFrom(
                        side: const BorderSide(color: AppColors.line),
                        foregroundColor: AppColors.muted,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                      ),
                      child: const Text('取消'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    flex: 2,
                    child: ElevatedButton(
                      onPressed: _selectedId == null
                          ? null
                          : () => Navigator.pop(context, _selectedId),
                      style: ElevatedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        disabledBackgroundColor: AppColors.line,
                        disabledForegroundColor: AppColors.faint,
                      ),
                      child: const Text('使用所选'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _listBody() {
    if (_loading && _index == null) {
      return const Center(
        child: CircularProgressIndicator(
          strokeWidth: 2,
          color: AppColors.accent,
        ),
      );
    }
    if (_error != null && _index == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '加载失败：$_error',
              style: const TextStyle(color: AppColors.danger, fontSize: 13),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => _load(forceRefresh: true),
              child: const Text(
                '重试',
                style: TextStyle(color: AppColors.accent),
              ),
            ),
          ],
        ),
      );
    }
    final items = _filtered;
    if (items.isEmpty) {
      return const Center(
        child: Text(
          '没有匹配的模板',
          style: TextStyle(color: AppColors.faint, fontSize: 13),
        ),
      );
    }

    // When no category filter and no search query is active, show a
    // "⭐ 推荐" (featured) section at the top — matching the web dropdown
    // which renders featured presets in a dedicated optgroup first.
    final featured = (_category.isEmpty && _query.isEmpty)
        ? (_index?.featuredPresets ?? const <AgentPreset>[])
        : const <AgentPreset>[];
    final featuredIds = featured.map((p) => p.id).toSet();
    final rest = items.where((p) => !featuredIds.contains(p.id)).toList();

    if (featured.isEmpty) {
      return ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
        itemCount: rest.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8),
        itemBuilder: (_, i) {
          final p = rest[i];
          return _PresetCard(
            preset: p,
            selected: _selectedId == p.id,
            onTap: () => setState(() => _selectedId = p.id),
          );
        },
      );
    }

    // Featured section + remaining items
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      itemCount: featured.length + (rest.isEmpty ? 0 : 1) + rest.length,
      itemBuilder: (_, i) {
        if (i < featured.length) {
          final p = featured[i];
          return Padding(
            padding: EdgeInsets.only(bottom: i == featured.length - 1 ? 0 : 8),
            child: _PresetCard(
              preset: p,
              selected: _selectedId == p.id,
              onTap: () => setState(() => _selectedId = p.id),
              featured: true,
            ),
          );
        }
        final adj = i - featured.length;
        if (adj == 0) {
          return const Padding(
            padding: EdgeInsets.only(top: 10, bottom: 8),
            child: Text(
              '全部模板',
              style: TextStyle(
                color: AppColors.muted,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          );
        }
        final p = rest[adj - 1];
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: _PresetCard(
            preset: p,
            selected: _selectedId == p.id,
            onTap: () => setState(() => _selectedId = p.id),
          ),
        );
      },
    );
  }
}

class _CategoryChip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _CategoryChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(16),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            decoration: BoxDecoration(
              color: selected
                  ? AppColors.accent.withValues(alpha: 0.16)
                  : AppColors.panel2,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: selected ? AppColors.accent : AppColors.line,
              ),
            ),
            child: Text(
              label,
              style: TextStyle(
                color: selected ? AppColors.accent : AppColors.muted,
                fontSize: 12,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// A selectable preset card: left color bar, emoji + bold name, 2-line clamped
// description, and a category tag. Selected state shows an accent border + check.
class _PresetCard extends StatelessWidget {
  final AgentPreset preset;
  final bool selected;
  final VoidCallback onTap;
  final bool featured;
  const _PresetCard({
    required this.preset,
    required this.selected,
    required this.onTap,
    this.featured = false,
  });

  @override
  Widget build(BuildContext context) {
    final c = preset.accentColor;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          decoration: BoxDecoration(
            color: featured
                ? AppColors.accent.withValues(alpha: 0.06)
                : AppColors.panel2,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: selected
                  ? AppColors.accent
                  : (featured
                        ? AppColors.accent.withValues(alpha: 0.3)
                        : AppColors.line),
              width: selected ? 1.5 : 1,
            ),
          ),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // left color bar
                Container(
                  width: 4,
                  decoration: BoxDecoration(
                    color: c,
                    borderRadius: const BorderRadius.horizontal(
                      left: Radius.circular(11),
                    ),
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            if (featured) ...[
                              const Text('⭐', style: TextStyle(fontSize: 14)),
                              const SizedBox(width: 4),
                            ],
                            if (preset.emoji.isNotEmpty) ...[
                              Text(
                                preset.emoji,
                                style: const TextStyle(fontSize: 16),
                              ),
                              const SizedBox(width: 8),
                            ],
                            Expanded(
                              child: Text(
                                preset.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  color: AppColors.textBright,
                                  fontSize: 14,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            if (selected)
                              const Icon(
                                Icons.check_circle,
                                color: AppColors.accent,
                                size: 18,
                              ),
                          ],
                        ),
                        if (preset.description.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text(
                            preset.description,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: AppColors.muted,
                              fontSize: 12,
                              height: 1.35,
                            ),
                          ),
                        ],
                        if (preset.category.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 3,
                            ),
                            decoration: BoxDecoration(
                              color: c.withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              preset.category,
                              style: TextStyle(
                                color: c,
                                fontSize: 10,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
