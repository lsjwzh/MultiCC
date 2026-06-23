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
import '../widgets/model_picker.dart';
import '../widgets/thinking_indicator.dart';
import 'memo_screen.dart';
import 'settings_screen.dart';
import 'share_messages_screen.dart';

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
            _CostBar(),
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
            const InputBar(),
          ],
        ),
      ),
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
                  padding:
                      const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
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
              // Model & Provider chips — compact variants on narrow screens.
              const SizedBox(width: 4),
              if (provider.cli == SessionCli.claude) ...[
                _ModelChip(
                    sessionId: provider.sessionName,
                    settings: settings,
                    compact: narrow),
                const SizedBox(width: 4),
              ],
              _ProviderChip(
                sessionId: provider.sessionName,
                cli: provider.cli,
                settings: settings,
                compact: narrow,
              ),
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
                onClear: () => _confirmClear(context, provider),
                onSettings: () => _openSettings(context, settings),
                onShare: () => _shareFromSession(
                    context, provider.sessionName, settings),
                onShareMessages: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => ShareMessagesScreen(
                      sessionId: provider.sessionName,
                      settings: settings,
                    ),
                  ),
                ),
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

  void _confirmClear(BuildContext context, ChatProvider provider) {
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(t('clearHistoryTitle')),
        content: Text(t('clearHistoryBody')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(t('cancel'),
                style: const TextStyle(color: Color(0xFF8a909b))),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              provider.clearHistory();
            },
            child: Text(t('clearBtn'),
                style: const TextStyle(color: Color(0xFFff6b63))),
          ),
        ],
      ),
    );
  }

  void _openSettings(BuildContext context, SettingsService settings) {
    Navigator.of(
      context,
    ).push(MaterialPageRoute(builder: (_) => SettingsScreen(settings: settings)));
  }
}

/// Compact model indicator + switcher for the chat header. Reads the current
/// per-session model AND provider from SessionManager; when a custom provider
/// is active, its default model is shown instead of a bare "默认".
/// Tap to switch (next turn applies).
class _ModelChip extends StatefulWidget {
  final String sessionId;
  final SettingsService settings;
  final bool compact;
  const _ModelChip({required this.sessionId, required this.settings, this.compact = false});

  @override
  State<_ModelChip> createState() => _ModelChipState();
}

class _ModelChipState extends State<_ModelChip> {
  List<Map<String, dynamic>> _providers = [];
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await ManageService(settings: widget.settings).fetchProviders('claude');
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

  /// Effective model label: explicit session model, or provider's default model,
  /// or "默认" if neither.
  String _modelLabel(Session? s) {
    if (s == null) return '默认';
    // Explicit session model always wins.
    if (s.model != null && s.model!.isNotEmpty) {
      return claudeModelShortName(s.model);
    }
    // Check if a custom provider supplies a default model.
    final pid = s.provider;
    if (pid != null && pid.isNotEmpty) {
      for (final p in _providers) {
        if (p['id'] == pid) {
          final m = p['model'] as String?;
          if (m != null && m.isNotEmpty) return m;
        }
      }
    }
    return '默认';
  }

  /// True when the session's custom provider supplies its own model (so the
  /// claude `--model` switch is moot — the provider's ANTHROPIC_MODEL wins).
  bool _providerSuppliesModel(String? pid) {
    if (pid == null || pid.isEmpty) return false;
    for (final p in _providers) {
      if (p['id'] == pid) return (p['model'] as String?)?.isNotEmpty == true;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();
    Session? s;
    for (final x in mgr.sessions) {
      if (x.id == widget.sessionId) { s = x; break; }
    }
    // When the model is dictated by a custom provider (provider has its own
    // model and the session didn't explicitly override it), the standalone
    // model chip is both redundant (the provider chip already says deepseek)
    // and wide enough to overflow the header row — hide it.
    if (s != null &&
        (s.model == null || s.model!.isEmpty) &&
        _providerSuppliesModel(s.provider)) {
      return const SizedBox.shrink();
    }
    final label = _modelLabel(s);
    return Tooltip(
      message: t('switchModel'),
      child: GestureDetector(
        onTap: () => _switchModel(context, mgr, s),
        child: Container(
          padding: EdgeInsets.symmetric(
              horizontal: widget.compact ? 6 : 8, vertical: 5),
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
                  constraints: const BoxConstraints(maxWidth: 64),
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

  Future<void> _switchModel(
    BuildContext context,
    SessionManager mgr,
    Session? s,
  ) async {
    if (s == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(t('sessionNotLoaded'))),
      );
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    final picked = await showClaudeModelPicker(
      context,
      current: s.model ?? '',
      title: t('switchModel'),
    );
    if (picked == null) return;
    try {
      await mgr.updateSessionModel(s.id, picked);
      final name = picked.isEmpty
          ? t('modelNameDefault')
          : claudeModelShortName(picked);
      messenger.showSnackBar(
        SnackBar(content: Text(t('modelSwitched', {'name': name}))),
      );
    } catch (e) {
      messenger.showSnackBar(
          SnackBar(content: Text(t('modelSwitchFailed', {'error': '$e'}))));
    }
  }
}

/// Compact per-session provider indicator + switcher for the chat header.
/// Works for both claude & codex; tap to pick a provider (next turn applies).
class _ProviderChip extends StatefulWidget {
  final String sessionId;
  final SessionCli cli;
  final SettingsService settings;
  final bool compact;
  const _ProviderChip({required this.sessionId, required this.cli, required this.settings, this.compact = false});

  @override
  State<_ProviderChip> createState() => _ProviderChipState();
}

class _ProviderChipState extends State<_ProviderChip> {
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
      final d = await ManageService(settings: widget.settings).fetchProviders(_appType);
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

  String _nameOf(String? id) {
    if (id == null || id.isEmpty) return t('defaultModel');
    final p = _providers.where((x) => x['id'] == id);
    return p.isNotEmpty ? (p.first['name'] as String? ?? id) : t('customModel');
  }

  @override
  Widget build(BuildContext context) {
    final mgr = context.watch<SessionManager>();
    Session? s;
    for (final x in mgr.sessions) {
      if (x.id == widget.sessionId) { s = x; break; }
    }
    final label = _nameOf(s?.provider);
    return Tooltip(
      message: t('switchProvider'),
      child: GestureDetector(
        onTap: () => _switchProvider(context, mgr, s),
        child: Container(
          padding: EdgeInsets.symmetric(
              horizontal: widget.compact ? 6 : 8, vertical: 5),
          decoration: BoxDecoration(
            color: const Color(0xFF14171c),
            border: Border.all(color: const Color(0xFF20242b)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.swap_horiz_rounded, size: 15, color: Color(0xFFe7eaee)),
              if (!widget.compact) ...[
                const SizedBox(width: 4),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 64),
                  child: Text(label,
                      style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 11, fontWeight: FontWeight.w600),
                      overflow: TextOverflow.ellipsis),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _switchProvider(BuildContext context, SessionManager mgr, Session? s) async {
    if (s == null) {
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(t('sessionNotLoaded'))));
      return;
    }
    if (!_loaded) await _load();
    if (!context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final picked = await showModalBottomSheet<_PickResult>(
      context: context,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _ProviderPickerSheet(
        providers: _providers,
        current: s.provider ?? '',
        appType: _appType,
      ),
    );
    if (picked == null) return;
    try {
      await mgr.updateSessionProvider(s.id, picked.id);
      final name = picked.id.isEmpty ? t('defaultLogin') : picked.name;
      messenger.showSnackBar(
        SnackBar(content: Text(t('providerSwitched', {'name': name}))),
      );
    } catch (e) {
      messenger.showSnackBar(
          SnackBar(content: Text(t('providerSwitchFailed', {'error': '$e'}))));
    }
  }
}

class _PickResult {
  final String id;
  final String name;
  _PickResult(this.id, this.name);
}

class _ProviderPickerSheet extends StatelessWidget {
  final List<Map<String, dynamic>> providers;
  final String current;
  final String appType;
  const _ProviderPickerSheet({required this.providers, required this.current, required this.appType});

  @override
  Widget build(BuildContext context) {
    Widget tile(String id, String name, String? sub) {
      final sel = current == id;
      return ListTile(
        onTap: () => Navigator.pop(context, _PickResult(id, name)),
        leading: Icon(sel ? Icons.radio_button_checked : Icons.radio_button_off,
            color: sel ? AppColors.accent : AppColors.faint, size: 20),
        title: Text(name, style: const TextStyle(color: AppColors.text, fontSize: 14)),
        subtitle: sub != null && sub.isNotEmpty
            ? Text(sub, style: const TextStyle(color: AppColors.faint, fontSize: 12), overflow: TextOverflow.ellipsis)
            : null,
        dense: true,
      );
    }

    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 38, height: 4,
            margin: const EdgeInsets.symmetric(vertical: 12),
            decoration: BoxDecoration(color: AppColors.line, borderRadius: BorderRadius.circular(2)),
          ),
          const Padding(
            padding: EdgeInsets.only(bottom: 6),
            child: Text('切换该会话的 Provider（下一轮生效）',
                style: TextStyle(color: AppColors.textBright, fontSize: 14, fontWeight: FontWeight.w600)),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              children: [
                tile('', '默认登录 / 订阅', '不覆盖，走本机登录'),
                ...providers.map((p) => tile(
                      p['id'] as String,
                      p['name'] as String? ?? '',
                      p['isOfficial'] == true ? '订阅' : (p['baseUrl'] as String? ?? ''),
                    )),
                if (providers.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(20),
                    child: Text('暂无可用 provider，请到「设置 → Provider 配置」导入或新建。',
                        textAlign: TextAlign.center, style: TextStyle(color: AppColors.faint, fontSize: 13)),
                  ),
                const SizedBox(height: 12),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// Edit the per-session role prompt (system-prompt override) from the chat
// header overflow menu. Empty = clear → inherits the directory default.
Future<void> _editRoleFromSession(
    BuildContext context, String sessionId) async {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  final messenger = ScaffoldMessenger.of(context);
  Session? s;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) { s = x; break; }
  }
  if (s == null) {
    messenger.showSnackBar(
      const SnackBar(content: Text('Session 信息未加载')),
    );
    return;
  }
  final picked = await _showRolePromptEditor(context,
      current: s.rolePrompt ?? '', settings: mgr.settings);
  if (picked == null) return; // cancelled
  try {
    await mgr.updateSessionRolePrompt(s.id, picked);
    messenger.showSnackBar(
      SnackBar(
        content: Text(picked.trim().isEmpty
            ? '✓ 已清除会话角色（继承目录默认），下一轮对话生效'
            : '✓ 角色提示词已更新，下一轮对话生效'),
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
    BuildContext context, String sessionId) async {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  final messenger = ScaffoldMessenger.of(context);
  String current = '';
  try {
    current = await mgr.fetchSessionMemory(sessionId);
  } catch (_) {}
  if (!context.mounted) return;
  final picked = await _showMemoryEditor(context, current: current);
  if (picked == null) return; // cancelled
  try {
    await mgr.updateSessionMemory(sessionId, picked);
    messenger.showSnackBar(SnackBar(
      content: Text(picked.trim().isEmpty ? '✓ 已清空会话记忆' : '✓ 会话记忆已更新'),
    ));
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('记忆保存失败：$e')));
  }
}

Future<String?> _showMemoryEditor(BuildContext context,
    {required String current}) {
  final ctrl = TextEditingController(text: current);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      backgroundColor: const Color(0xFF14171c),
      title: const Text('🧠 会话记忆',
          style: TextStyle(color: Color(0xFFe7eaee), fontSize: 16)),
      content: SizedBox(
        width: double.maxFinite,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '辅助 AI 在清理历史时自动提炼的「关键问题 + 解决方式」，会随每轮对话注入给模型。可手动编辑或清空。',
              style: TextStyle(color: Color(0xFF8a909b), fontSize: 12),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: ctrl,
              maxLines: 12,
              minLines: 6,
              style: const TextStyle(
                  color: Color(0xFFc9d1d9), fontSize: 13, fontFamily: 'monospace'),
              decoration: const InputDecoration(
                hintText: '（还没有积累记忆。聊一段后 Clear 历史，或历史超长自动滚动时，辅助 AI 会在这里记下关键问题与解决方式。）',
                hintStyle: TextStyle(color: Color(0xFF5b616c), fontSize: 12),
                filled: true,
                fillColor: Color(0xFF0d1117),
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 6),
            const Text('留空＝清除全部记忆。',
                style: TextStyle(color: Color(0xFF6e7681), fontSize: 11)),
          ],
        ),
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消', style: TextStyle(color: Color(0xFF8a909b)))),
        TextButton(
          onPressed: () {
            if (ctrl.text.length > 8000) {
              ScaffoldMessenger.of(ctx).showSnackBar(
                  const SnackBar(content: Text('记忆过长（上限 8000 字）')));
              return;
            }
            Navigator.pop(ctx, ctrl.text);
          },
          child: const Text('保存', style: TextStyle(color: Color(0xFF22ab9c))),
        ),
      ],
    ),
  );
}

// Share a session externally. Recipient always opens a web page; this only
// creates the link and lets the user copy it. 'operate' requires a password.
Future<void> _shareFromSession(
    BuildContext context, String sessionId, SettingsService settings) async {
  final svc = SessionService(settings: settings);
  String access = 'view';
  final pwCtrl = TextEditingController();
  String? url;
  String? error;
  bool busy = false;

  await showDialog<void>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setState) => AlertDialog(
        backgroundColor: const Color(0xFF14171c),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: const BorderSide(color: Color(0xFF20242b)),
        ),
        title: const Text('分享会话',
            style: TextStyle(color: Color(0xFFe7eaee), fontSize: 16)),
        content: SizedBox(
          width: 360,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('接收方在浏览器打开链接即可。',
                  style: TextStyle(color: Color(0xFF8b949e), fontSize: 12)),
              const SizedBox(height: 4),
              const Text('「可对话」= 对方能通过此会话在你机器上执行操作，务必设强密码。',
                  style: TextStyle(color: Color(0xFFe3853f), fontSize: 12)),
              const SizedBox(height: 12),
              DropdownButton<String>(
                value: access,
                dropdownColor: const Color(0xFF14171c),
                isExpanded: true,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
                items: const [
                  DropdownMenuItem(value: 'view', child: Text('只读查看')),
                  DropdownMenuItem(value: 'operate', child: Text('可对话（需密码）')),
                ],
                onChanged: busy ? null : (v) => setState(() => access = v ?? 'view'),
              ),
              TextField(
                controller: pwCtrl,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
                decoration: const InputDecoration(
                  hintText: '密码（只读可留空；可对话必填）',
                  hintStyle: TextStyle(color: Color(0xFF6e7681), fontSize: 13),
                ),
              ),
              if (error != null) ...[
                const SizedBox(height: 8),
                Text(error!, style: const TextStyle(color: Color(0xFFff6b63), fontSize: 12)),
              ],
              if (url != null) ...[
                const SizedBox(height: 12),
                SelectableText(url!,
                    style: const TextStyle(color: Color(0xFF79c0ff), fontSize: 12)),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('关闭', style: TextStyle(color: Color(0xFF8b949e))),
          ),
          if (url != null)
            TextButton(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: url!));
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('链接已复制')));
              },
              child: const Text('复制链接', style: TextStyle(color: Color(0xFF58a6ff))),
            ),
          TextButton(
            onPressed: busy
                ? null
                : () async {
                    final pw = pwCtrl.text.trim();
                    if (access == 'operate' && pw.isEmpty) {
                      setState(() => error = '「可对话」必须设置密码');
                      return;
                    }
                    setState(() { busy = true; error = null; });
                    try {
                      final r = await svc.createShare(sessionId,
                          access: access, password: pw.isEmpty ? null : pw);
                      setState(() { url = r['url'] as String?; busy = false; });
                    } catch (e) {
                      setState(() { error = '$e'; busy = false; });
                    }
                  },
            child: Text(url == null ? '生成链接' : '重新生成',
                style: const TextStyle(color: Color(0xFF3fb950))),
          ),
        ],
      ),
    ),
  );
}

// Multi-line role-prompt editor dialog. Returns the new text, or null on cancel.
// [settings] enables the preset picker (small chip strip + full browser). When
// omitted the editor degrades to a plain text field.
Future<String?> _showRolePromptEditor(BuildContext context,
    {required String current, SettingsService? settings}) {
  return showDialog<String>(
    context: context,
    builder: (ctx) => _RolePromptEditorDialog(current: current, settings: settings),
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
          title: const Text('替换当前内容?',
              style: TextStyle(color: AppColors.text, fontSize: 15)),
          content: const Text('文本框已有内容，使用该模板会覆盖现有文字。',
              style: TextStyle(color: AppColors.muted, fontSize: 13)),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c, false),
              child: const Text('取消', style: TextStyle(color: AppColors.muted)),
            ),
            TextButton(
              onPressed: () => Navigator.pop(c, true),
              child: const Text('替换', style: TextStyle(color: AppColors.danger)),
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
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('模板加载失败：$e')));
    }
  }

  Future<void> _browseAll() async {
    if (_svc == null) return;
    final id = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) =>
          AgentPresetPickerSheet(service: _svc!, index: _index),
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
          child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.accent),
        ),
      );
    } else if (_indexError != null && _index == null) {
      body = Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            const Expanded(
              child: Text('模板加载失败',
                  style: TextStyle(color: AppColors.danger, fontSize: 12)),
            ),
            TextButton(
              onPressed: () => _loadIndex(forceRefresh: true),
              style: TextButton.styleFrom(
                  minimumSize: const Size(0, 28),
                  padding: const EdgeInsets.symmetric(horizontal: 8)),
              child: const Text('重试',
                  style: TextStyle(color: AppColors.accent, fontSize: 12)),
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
                child: Text('暂无推荐模板',
                    style: TextStyle(color: AppColors.faint, fontSize: 12)),
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
            const Text('预设角色',
                style: TextStyle(color: AppColors.muted, fontSize: 12)),
            const Spacer(),
            TextButton(
              onPressed: _browseAll,
              style: TextButton.styleFrom(
                  minimumSize: const Size(0, 28),
                  padding: const EdgeInsets.symmetric(horizontal: 6)),
              child: const Text('浏览全部模板 →',
                  style: TextStyle(color: AppColors.accent, fontSize: 12)),
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
          const Text('角色提示词',
              style: TextStyle(color: AppColors.text, fontSize: 16)),
          if (_applying) ...[
            const SizedBox(width: 10),
            const SizedBox(
              height: 14,
              width: 14,
              child: CircularProgressIndicator(
                  strokeWidth: 2, color: AppColors.accent),
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
                    borderSide: BorderSide(color: AppColors.line)),
                focusedBorder: OutlineInputBorder(
                    borderSide: BorderSide(color: AppColors.accentDark)),
              ),
            ),
            const Text('留空＝清除（会话将继承目录默认角色）',
                style: TextStyle(color: AppColors.muted, fontSize: 11)),
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
              Text(preset.name,
                  style: TextStyle(
                      color: AppColors.text,
                      fontSize: 12,
                      fontWeight: FontWeight.w500)),
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
    if (x.id == sessionId) { s = x; break; }
  }
  if (s == null) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Session 信息未加载')),
    );
    return;
  }
  Directory? d;
  for (final x in mgr.directories) {
    if (x.id == s.dirId) { d = x; break; }
  }
  if (d == null) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('找不到对应目录')),
    );
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
          child: Icon(
            icon,
            color: const Color(0xFFe7eaee),
            size: 18,
          ),
        ),
      ),
    );
  }
}

/// Overflow menu for the chat header. Collapses the occasional actions
/// (memo / merge worktree / clear history / settings) behind a single "⋮"
/// trigger, keeping the header's action cluster a fixed, compact width so its
/// icons never overflow the right edge on narrow screens.
class _HeaderOverflowMenu extends StatelessWidget {
  final bool mergeReady;
  final VoidCallback onRole;
  final VoidCallback onMemory;
  final VoidCallback onMemo;
  final VoidCallback onMerge;
  final VoidCallback onClear;
  final VoidCallback onSettings;
  final VoidCallback onShare;
  final VoidCallback onShareMessages;
  const _HeaderOverflowMenu({
    required this.mergeReady,
    required this.onRole,
    required this.onMemory,
    required this.onMemo,
    required this.onMerge,
    required this.onClear,
    required this.onSettings,
    required this.onShare,
    required this.onShareMessages,
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
          case 'clear':
            onClear();
            break;
          case 'share':
            onShare();
            break;
          case 'share-msgs':
            onShareMessages();
            break;
          case 'settings':
            onSettings();
            break;
        }
      },
      itemBuilder: (_) => [
        _item('role', Icons.theater_comedy_outlined, t('rolePrompt'),
            const Color(0xFFe7eaee)),
        _item('memory', Icons.psychology_outlined, t('sessionMemory'),
            const Color(0xFFe7eaee)),
        _item('memo', Icons.sticky_note_2_outlined, t('projectMemo'),
            const Color(0xFFe7eaee)),
        _item('share', Icons.share_outlined, t('shareSession'),
            const Color(0xFFe7eaee)),
        _item('share-msgs', Icons.checklist_rtl_outlined, t('shareMessages'),
            const Color(0xFFe7eaee)),
        _item(
          'merge',
          Icons.merge_type,
          mergeReady ? t('mergeWorktreeReady', {'base': ''}) : t('mergeWorktree'),
          mergeReady ? const Color(0xFFe3b341) : const Color(0xFFe7eaee),
        ),
        _item('clear', Icons.delete_sweep_outlined, t('clearHistory'),
            const Color(0xFFff6b63)),
        const PopupMenuDivider(),
        _item('settings', Icons.settings_outlined, t('settings'),
            const Color(0xFFe7eaee)),
      ],
      child: Container(
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          color: mergeReady ? const Color(0xFFe3b341) : const Color(0xFF14171c),
          border: Border.all(
            color:
                mergeReady ? const Color(0xFFe3b341) : const Color(0xFF20242b),
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
      String value, IconData icon, String label, Color color) {
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

    return Stack(
      children: [
        ListView.builder(
          controller: widget.scrollCtrl,
          padding: const EdgeInsets.all(12),
          itemCount: messages.length + (showThinking ? 1 : 0),
          itemBuilder: (_, i) {
            if (i == messages.length) return const ThinkingIndicator();
            final msg = messages[i];
            // WeChat-style time separator: show a centered time label only when
            // this message is the first, or its gap from the previous message
            // exceeds the threshold — so back-to-back turns stay uncluttered.
            final prev = i > 0 ? messages[i - 1] : null;
            final showTime = prev == null ||
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
  }
}

class _CostBar extends StatelessWidget {
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
                const Text('选择角色模板',
                    style: TextStyle(
                        color: AppColors.textBright,
                        fontSize: 16,
                        fontWeight: FontWeight.w600)),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.close,
                      color: AppColors.muted, size: 20),
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
                prefixIcon:
                    const Icon(Icons.search, color: AppColors.faint, size: 18),
                hintText: '搜索名称或描述…',
                hintStyle: const TextStyle(color: AppColors.faint, fontSize: 13),
                filled: true,
                fillColor: AppColors.panel2,
                enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: const BorderSide(color: AppColors.line)),
                focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: const BorderSide(color: AppColors.accentDark)),
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
                    label: cat.count > 0 ? '${cat.label} ${cat.count}' : cat.label,
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
            strokeWidth: 2, color: AppColors.accent),
      );
    }
    if (_error != null && _index == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('加载失败：$_error',
                style: const TextStyle(color: AppColors.danger, fontSize: 13)),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => _load(forceRefresh: true),
              child: const Text('重试',
                  style: TextStyle(color: AppColors.accent)),
            ),
          ],
        ),
      );
    }
    final items = _filtered;
    if (items.isEmpty) {
      return const Center(
        child: Text('没有匹配的模板',
            style: TextStyle(color: AppColors.faint, fontSize: 13)),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (_, i) {
        final p = items[i];
        return _PresetCard(
          preset: p,
          selected: _selectedId == p.id,
          onTap: () => setState(() => _selectedId = p.id),
        );
      },
    );
  }
}

class _CategoryChip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _CategoryChip(
      {required this.label, required this.selected, required this.onTap});

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
                  color: selected ? AppColors.accent : AppColors.line),
            ),
            child: Text(label,
                style: TextStyle(
                    color: selected ? AppColors.accent : AppColors.muted,
                    fontSize: 12,
                    fontWeight:
                        selected ? FontWeight.w600 : FontWeight.w400)),
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
  const _PresetCard(
      {required this.preset, required this.selected, required this.onTap});

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
            color: AppColors.panel2,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
                color: selected ? AppColors.accent : AppColors.line,
                width: selected ? 1.5 : 1),
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
                        left: Radius.circular(11)),
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
                            if (preset.emoji.isNotEmpty) ...[
                              Text(preset.emoji,
                                  style: const TextStyle(fontSize: 16)),
                              const SizedBox(width: 8),
                            ],
                            Expanded(
                              child: Text(preset.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                      color: AppColors.textBright,
                                      fontSize: 14,
                                      fontWeight: FontWeight.w700)),
                            ),
                            if (selected)
                              const Icon(Icons.check_circle,
                                  color: AppColors.accent, size: 18),
                          ],
                        ),
                        if (preset.description.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text(preset.description,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                  color: AppColors.muted,
                                  fontSize: 12,
                                  height: 1.35)),
                        ],
                        if (preset.category.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 8, vertical: 3),
                            decoration: BoxDecoration(
                              color: c.withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(preset.category,
                                style: TextStyle(
                                    color: c,
                                    fontSize: 10,
                                    fontWeight: FontWeight.w600)),
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
