import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/chat_service.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../widgets/ai_config_sheet.dart';
import '../widgets/conflict_diff_dialog.dart';
import '../widgets/session_diff_dialog.dart';
import '../widgets/input_bar.dart';
import '../widgets/message_bubble.dart';
import '../widgets/thinking_indicator.dart';
import '../widgets/model_chip.dart';
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
            if (provider.hasClassify)
              _AuxClassifyBar(
                goal: provider.classifyGoal,
                phase: provider.classifyPhase,
                classifyState: provider.classifyState,
              ),
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
              ModelChip(
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
  final picked = await showRolePromptEditor(
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
              ? '✓ 已清除会话角色（继承Fleet默认），下一轮对话生效'
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
    ).showSnackBar(const SnackBar(content: Text('找不到对应Fleet')));
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

class _AuxClassifyBar extends StatelessWidget {
  final String goal;
  final String phase;
  /// Live classify-state letter (D/C/W/B/E/P). Drives the pill tint, aligned
  /// with main_shell _classifyBadge and the web CLASSIFY_DISPLAY barTint.
  final String classifyState;
  const _AuxClassifyBar({required this.goal, required this.phase, required this.classifyState});

  static const _phaseLabels = {
    'idle': '空闲', 'planning': '规划中', 'running': '进行中', 'editing': '编辑中',
    'verifying': '验证中', 'waiting': '等待中', 'blocked': '受阻', 'reviewing': '复查中',
    'completed': '已完成', 'done': '已完成', 'interrupted': '已中断',
  };

  @override
  Widget build(BuildContext context) {
    // classifyState letter (D/C/W/B/E/P) drives the tint - aligned with the
    // workspace _classifyBadge and web CLASSIFY_DISPLAY barTint.
    final cs = classifyState.toUpperCase();
    final Color phaseColor;
    final Color phaseBg;
    final Color phaseBorder;
    final String stateEmoji;
    switch (cs) {
      case 'C': // continue
      case 'P': // processing
        phaseColor = const Color(0xFF6cb6ff);
        phaseBg = const Color(0xFF0d1a2e);
        phaseBorder = const Color(0x551f6feb);
        stateEmoji = cs == 'C' ? '🔵' : '⚡';
        break;
      case 'D': // done
        phaseColor = const Color(0xFF56d364);
        phaseBg = const Color(0xFF0f2417);
        phaseBorder = const Color(0x55238636);
        stateEmoji = '✅';
        break;
      case 'W': // wait-user
      case 'B': // wait-bg
        phaseColor = const Color(0xFFe3b341);
        phaseBg = const Color(0xFF241c08);
        phaseBorder = const Color(0x55e3b341);
        stateEmoji = cs == 'W' ? '⏸' : '⏳';
        break;
      case 'E': // error
        phaseColor = const Color(0xFFf85149);
        phaseBg = const Color(0xFF2a1213);
        phaseBorder = const Color(0x55da3633);
        stateEmoji = '⚠';
        break;
      default:
        phaseColor = const Color(0xFF8a909b);
        phaseBg = const Color(0xFF0f1115);
        phaseBorder = const Color(0xFF20242b);
        stateEmoji = '•';
    }
    final phaseLabel = _phaseLabels[phase] ?? phase;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: const BoxDecoration(
        color: Color(0xFF0a0c0f),
        border: Border(bottom: BorderSide(color: Color(0xFF14171c))),
      ),
      child: Row(
        children: [
          const Icon(Icons.auto_awesome_outlined, size: 14, color: Color(0xFF5b616c)),
          const SizedBox(width: 6),
          Expanded(
            child: Tooltip(
              message: goal,
              child: Text(goal,
                  style: const TextStyle(color: Color(0xFFc9ced6), fontSize: 12, height: 1.3),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis),
            ),
          ),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: phaseBg,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: phaseBorder),
            ),
            child: Text('$stateEmoji $phaseLabel',
                style: TextStyle(color: phaseColor, fontSize: 11, fontWeight: FontWeight.w600)),
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
  bool _loadingOlder = false;

  @override
  void initState() {
    super.initState();
    widget.scrollCtrl.addListener(_onScroll);
  }

  void _onScroll() {
    if (!widget.scrollCtrl.hasClients) return;
    final pos = widget.scrollCtrl.position;
    final atBottom = pos.pixels >= pos.maxScrollExtent - 60;
    final settling = _scrollSettlingUntil != null &&
        DateTime.now().isBefore(_scrollSettlingUntil!);
    if (atBottom && _userScrolled) {
      setState(() => _userScrolled = false);
    } else if (!atBottom && !_userScrolled && !settling) {
      // Ignore "scrolled away" during a programmatic scroll-to-bottom.
      setState(() => _userScrolled = true);
    }
    // Sync pinned/unread state to the provider (drives the "↓ N new" pill),
    // but skip while settling so initial positioning doesn't arm the pill.
    if (!settling) {
      final provider = context.read<ChatProvider>();
      provider.onUserScroll(atBottom: atBottom);
    }
    // Scroll near the top -> fetch one older page of history.
    if (pos.pixels <= 80) {
      _maybeLoadOlder();
    }
  }

  Future<void> _maybeLoadOlder() async {
    if (_loadingOlder) return;
    final provider = context.read<ChatProvider>();
    if (provider.historyExhausted || provider.historyLoading) return;
    setState(() => _loadingOlder = true);
    // Capture scroll geometry BEFORE the prepend so we can re-anchor.
    double? beforePixels;
    double? beforeMax;
    if (widget.scrollCtrl.hasClients) {
      beforePixels = widget.scrollCtrl.position.pixels;
      beforeMax = widget.scrollCtrl.position.maxScrollExtent;
    }
    final inserted = await provider.loadOlderHistory();
    if (inserted > 0 && beforePixels != null && beforeMax != null) {
      // Re-anchor: keep the message that was at the top of the viewport in place.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!widget.scrollCtrl.hasClients) return;
        final newMax = widget.scrollCtrl.position.maxScrollExtent;
        final delta = newMax - beforeMax!;
        widget.scrollCtrl.jumpTo(beforePixels! + delta);
      });
    }
    if (mounted) setState(() => _loadingOlder = false);
  }

  // Brief window after a programmatic scroll-to-bottom during which _onScroll
  // should NOT mark the user as scrolled-away (the animateTo fires intermediate
  // scroll positions that would otherwise falsely arm the unread pill).
  DateTime? _scrollSettlingUntil;

  void _scrollToBottom() {
    if (!widget.scrollCtrl.hasClients || _userScrolled) return;
    _scrollSettlingUntil = DateTime.now().add(const Duration(milliseconds: 350));
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
            // Lazy-history top hint: "loading older…" while fetching, or a
            // persistent "- earliest -" marker once everything is loaded.
            if (provider.historyExhausted && messages.length > 3)
              Positioned(
                top: 6,
                left: 0,
                right: 0,
                child: Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFF161b22),
                      border: Border.all(color: const Color(0xFF21262d)),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: const Text(
                      '- 已是最早消息 -',
                      style: TextStyle(color: Color(0xFF8b949e), fontSize: 12),
                    ),
                  ),
                ),
              )
            else if (_loadingOlder || provider.historyLoading)
              Positioned(
                top: 6,
                left: 0,
                right: 0,
                child: Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFF161b22),
                      border: Border.all(color: const Color(0xFF21262d)),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: Color(0xFF8b949e)),
                        ),
                        SizedBox(width: 6),
                        Text('加载更早的消息…',
                            style: TextStyle(
                                color: Color(0xFF8b949e), fontSize: 12)),
                      ],
                    ),
                  ),
                ),
              ),
            if (_userScrolled)
              Positioned(
                bottom: 10,
                left: 0,
                right: 0,
                child: Center(
                  child: GestureDetector(
                    onTap: () {
                      provider.jumpToBottom();
                      setState(() => _userScrolled = false);
                      _scrollToBottom();
                    },
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 7),
                      decoration: BoxDecoration(
                        color: const Color(0xFF1f6feb),
                        border: Border.all(color: const Color(0xFF388bfd)),
                        borderRadius: BorderRadius.circular(999),
                        boxShadow: const [
                          BoxShadow(
                              color: Color(0x66000000),
                              blurRadius: 12,
                              offset: Offset(0, 3)),
                        ],
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.keyboard_arrow_down,
                              color: Colors.white, size: 18),
                          const SizedBox(width: 4),
                          Text(
                            provider.unreadCount > 0
                                ? '${provider.unreadCount} 条新消息'
                                : '回到底部',
                            style: const TextStyle(
                                color: Colors.white,
                                fontSize: 13,
                                fontWeight: FontWeight.w500),
                          ),
                        ],
                      ),
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
    final color = switch (cli) {
      SessionCli.claude => const Color(0xFFf0936b),
      SessionCli.codex => const Color(0xFF7fd49a),
      SessionCli.opencode => const Color(0xFFa78bfa),
      SessionCli.zcode => const Color(0xFF38bdf8),
    };
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
