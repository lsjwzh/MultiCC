import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../utils/session_status_helpers.dart';
import '../widgets/ai_config_sheet.dart';
import '../widgets/chat_header.dart';
import '../widgets/conflict_diff_dialog.dart';
import '../widgets/session_diff_dialog.dart';
import '../widgets/input_bar.dart';
import '../widgets/message_bubble.dart';
import '../widgets/thinking_indicator.dart';
import 'memo_screen.dart';
import 'memory_screen.dart';

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
  Timer? _livenessTimer;
  Map<String, dynamic>? _liveness;
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
                  ? t('syncSuccess', {
                      'base': '${res['baseBranch'] ?? t('baseBranch')}',
                      'n': '${res['commits'] ?? 0}',
                    })
                  : t('syncAlreadyLatest'),
            ),
          ),
        );
      } else if ((res['conflicts'] as List?)?.isNotEmpty == true) {
        messenger.showSnackBar(
          SnackBar(
            backgroundColor: const Color(0xFF3a1414),
            content: Text(
              t('syncConflict', {
                'files': (res['conflicts'] as List).join(', '),
              }),
              style: const TextStyle(color: Color(0xFFff9b9b)),
            ),
            duration: const Duration(seconds: 6),
          ),
        );
      } else {
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              t('syncFailed', {
                'error': '${res['error'] ?? t('unknownError')}',
              }),
            ),
          ),
        );
      }
      _lastWarnedBehind = 0; // allow a fresh warning if it falls behind again
      await _refreshMergeStatus(sessionId);
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(t('syncRequestFailed', {'error': '$e'}))),
      );
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  @override
  void dispose() {
    _scrollCtrl.dispose();
    _mergeTimer?.cancel();
    _livenessTimer?.cancel();
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
    _liveness = null;
    _livenessTimer?.cancel();
    _refreshLiveness(session);
    _livenessTimer = Timer.periodic(
      const Duration(seconds: 4),
      (_) => _refreshLiveness(session),
    );
  }

  Future<void> _refreshLiveness(String sessionId) async {
    if (sessionId.isEmpty) return;
    try {
      final v = await SessionService(
        settings: widget.settings,
      ).fetchLiveness(sessionId);
      if (!mounted || _polledSession != sessionId) return;
      setState(() => _liveness = v);
    } catch (_) {}
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
              t('behindWarning', {'base': base, 'n': '$behind'}),
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
            ChatHeader(
              settings: widget.settings,
              onCollapse: widget.onCollapse,
              mergeReady: mergeReady,
              onMerge: () => _mergeCurrent(context, provider.sessionName),
              onRole: () => _editRoleFromSession(context, provider.sessionName),
              onMemory: () =>
                  _editMemoryFromSession(context, provider.sessionName),
              onMemo: () => _openMemoFromSession(context, provider.sessionName),
              onShare: () => _shareFromSession(
                context,
                provider.sessionName,
                widget.settings,
              ),
            ),
            _CwdBar(mergeStatus: _mergeStatus),
            if (livenessBadge(_liveness?['state'] as String?) != null)
              Align(
                alignment: Alignment.centerLeft,
                child: Padding(
                  padding: const EdgeInsets.only(left: 12, right: 12, bottom: 2),
                  child: livenessChip(_liveness),
                ),
              ),
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
    messenger.showSnackBar(
      SnackBar(content: Text(t('sessionInfoUnavailable'))),
    );
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
          picked.trim().isEmpty ? t('rolePromptSaved') : t('rolePromptUpdated'),
        ),
      ),
    );
  } catch (e) {
    messenger.showSnackBar(
      SnackBar(content: Text(t('rolePromptFailed', {'error': '$e'}))),
    );
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
      builder: (_) =>
          MemoryScreen(settings: mgr.settings, sessionId: sessionId),
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
          title: Text(
            t('shareSession'),
            style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 16),
          ),
          content: SizedBox(
            width: 380,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    t('shareDesc'),
                    style: const TextStyle(
                      color: Color(0xFF8b949e),
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    t('shareOperateWarn'),
                    style: const TextStyle(
                      color: Color(0xFFe3853f),
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 14),
                  // ── Access type ──
                  Row(
                    children: [
                      _expandedChoice(
                        'view',
                        t('shareViewOnly'),
                        access,
                        (v) => setState(() => access = v),
                      ),
                      const SizedBox(width: 8),
                      _expandedChoice(
                        'operate',
                        t('shareOperate'),
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
                    decoration: InputDecoration(
                      hintText: t('sharePassword'),
                      hintStyle: const TextStyle(
                        color: Color(0xFF6e7681),
                        fontSize: 13,
                      ),
                      filled: true,
                      fillColor: const Color(0xFF1c2128),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
                      border: const OutlineInputBorder(
                        borderRadius: BorderRadius.all(Radius.circular(8)),
                        borderSide: BorderSide(color: Color(0xFF20242b)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  // ── Expiry ──
                  Text(
                    t('shareExpiry'),
                    style: const TextStyle(
                      color: Color(0xFF8b949e),
                      fontSize: 11,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      _expiryChip(
                        t('neverExpires'),
                        0,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                      _expiryChip(
                        t('oneHour'),
                        1,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                      _expiryChip(
                        t('oneDay'),
                        24,
                        expiryHrs,
                        (v) => setState(() => expiryHrs = v),
                      ),
                      _expiryChip(
                        t('sevenDays'),
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
                                setState(
                                  () => error = t('sharePasswordRequired'),
                                );
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
                          : Text(
                              url == null
                                  ? t('shareGenerate')
                                  : t('shareRegenerate'),
                            ),
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
                                SnackBar(content: Text(t('shareCopied'))),
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
                  Text(
                    t('existingShares'),
                    style: const TextStyle(
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
                    Text(
                      t('none'),
                      style: const TextStyle(
                        color: Color(0xFF6e7681),
                        fontSize: 13,
                      ),
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
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text(
                                  t('shareRevokeFailed', {'error': '$e'}),
                                ),
                              ),
                            );
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
              child: Text(
                t('close'),
                style: const TextStyle(color: Color(0xFF8b949e)),
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
    return '📎 ${t('shareSnapshotSummary', {'n': '${s['messageCount'] ?? 0}', 'password': s['hasPassword'] == true ? t('sharePasswordSuffix') : ''})}';
  }
  if (s['access'] == 'operate') return '🔌 ${t('shareOperateBadge')}';
  if (s['hasPassword'] == true) return '🔒 ${t('sharePasswordBadge')}';
  return '🌐 ${t('sharePublicBadge')}';
}

Widget _shareCard(Map<String, dynamic> s, VoidCallback onRevoke) {
  final exp = s['expiresAt'] as int?;
  final expStr = exp != null && exp > 0
      ? ' · ${t('expiresAt', {'time': DateTime.fromMillisecondsSinceEpoch(exp).toLocal().toString().substring(0, 16)})}'
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
    ).showSnackBar(SnackBar(content: Text(t('sessionInfoUnavailable'))));
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
    ).showSnackBar(SnackBar(content: Text(t('fleetNotFound'))));
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
      title: Text(
        t('mergeTitle'),
        style: const TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
      ),
      content: Text(
        t('mergeBody'),
        style: const TextStyle(color: Color(0xFFe7eaee)),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: Text(
            t('cancel'),
            style: const TextStyle(color: Color(0xFF8a909b)),
          ),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, true),
          child: Text(
            t('merge'),
            style: const TextStyle(
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
  messenger.showSnackBar(SnackBar(content: Text(t('merging'))));
  try {
    final result = await SessionService(
      settings: settings,
    ).mergeSession(sessionId);
    final hasConflict =
        result['conflicts'] is List && (result['conflicts'] as List).isNotEmpty;
    String msg;
    if (result['ok'] == true) {
      msg = result['merged'] == true
          ? t('merged', {'n': '${result['commits'] ?? 0}'})
          : t('mergedNothing', {'msg': t('mergeNoNewCommits')});
    } else if (result['conflicts'] != null) {
      msg = t('mergeConflict', {
        'files': (result['conflicts'] as List).join(', '),
      });
    } else {
      msg = t('mergeFailed', {'error': '${result['error'] ?? ''}'});
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
    messenger.showSnackBar(
      SnackBar(content: Text(t('mergeRequestFailed', {'error': '$e'}))),
    );
  }
}

String _mergeStatusText(Map<String, dynamic>? status) {
  if (status?['mergeReady'] != true) return t('mergeNotReady');
  final bits = <String>[];
  if (status?['dirty'] == true) bits.add(t('uncommittedChanges'));
  final ahead = (status?['ahead'] as num?)?.toInt() ?? 0;
  if (ahead > 0) bits.add(t('commitsAhead', {'n': '$ahead'}));
  final detail = bits.isEmpty ? t('mergeContentReady') : bits.join(', ');
  return t('mergeReadyDetail', {
    'detail': detail,
    'base': '${status?['baseBranch'] ?? t('baseBranch')}',
  });
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
            child: Text(
              t('viewDiff'),
              style: const TextStyle(fontWeight: FontWeight.w600),
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
            child: Text(
              t('merge'),
              style: const TextStyle(fontWeight: FontWeight.w700),
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
              t('behindBanner', {'base': baseBranch, 'n': '$behind'}),
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
              syncing ? t('syncing') : t('syncNow'),
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
  const _AuxClassifyBar({
    required this.goal,
    required this.phase,
    required this.classifyState,
  });

  String _phaseLabel(String value) => switch (value) {
    'idle' => t('activityIdle'),
    'planning' => t('phasePlanning'),
    'running' => t('phaseRunning'),
    'editing' => t('activityEditing'),
    'verifying' => t('phaseVerifying'),
    'waiting' => t('phaseWaiting'),
    'blocked' => t('phaseBlocked'),
    'reviewing' => t('phaseReviewing'),
    'completed' || 'done' => t('phaseDone'),
    'interrupted' => t('phaseInterrupted'),
    _ => value,
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
    final phaseLabel = _phaseLabel(phase);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: const BoxDecoration(
        color: Color(0xFF0a0c0f),
        border: Border(bottom: BorderSide(color: Color(0xFF14171c))),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.auto_awesome_outlined,
            size: 14,
            color: Color(0xFF5b616c),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Tooltip(
              message: goal,
              child: Text(
                goal,
                style: const TextStyle(
                  color: Color(0xFFc9ced6),
                  fontSize: 12,
                  height: 1.3,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
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
            child: Text(
              '$stateEmoji $phaseLabel',
              style: TextStyle(
                color: phaseColor,
                fontSize: 11,
                fontWeight: FontWeight.w600,
              ),
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
            child: Text(
              t('changeDir'),
              style: const TextStyle(fontSize: 11, color: Color(0xFF8a909b)),
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
        title: Text(t('changeCwdTitle'), style: const TextStyle(fontSize: 15)),
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
            child: Text(
              t('cancel'),
              style: const TextStyle(color: Color(0xFF8a909b)),
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
            child: Text(
              t('apply'),
              style: const TextStyle(
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
String formatChatTime(DateTime value) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(value.year, value.month, value.day);
  final hm =
      '${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}';
  final diffDays = today.difference(day).inDays;
  if (diffDays == 0) return hm;
  if (diffDays == 1) return t('yesterdayAt', {'time': hm});
  if (diffDays > 1 && diffDays < 7) {
    final week = [
      t('weekdayMon'),
      t('weekdayTue'),
      t('weekdayWed'),
      t('weekdayThu'),
      t('weekdayFri'),
      t('weekdaySat'),
      t('weekdaySun'),
    ];
    return t('weekdayAt', {'day': week[value.weekday - 1], 'time': hm});
  }
  if (value.year == now.year) {
    return t('monthDayAt', {
      'month': '${value.month}',
      'day': '${value.day}',
      'time': hm,
    });
  }
  return t('yearMonthDayAt', {
    'year': '${value.year}',
    'month': '${value.month}',
    'day': '${value.day}',
    'time': hm,
  });
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
    final settling =
        _scrollSettlingUntil != null &&
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
    _scrollSettlingUntil = DateTime.now().add(
      const Duration(milliseconds: 350),
    );
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
        final contentWidth = desktop && viewportWidth > _chatMaxContentWidth
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
                      horizontal: 12,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFF161b22),
                      border: Border.all(color: const Color(0xFF21262d)),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      t('historyStart'),
                      style: const TextStyle(
                        color: Color(0xFF8b949e),
                        fontSize: 12,
                      ),
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
                      horizontal: 12,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFF161b22),
                      border: Border.all(color: const Color(0xFF21262d)),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Color(0xFF8b949e),
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          t('loadingEarlierMessages'),
                          style: const TextStyle(
                            color: Color(0xFF8b949e),
                            fontSize: 12,
                          ),
                        ),
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
                        horizontal: 14,
                        vertical: 7,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xFF1f6feb),
                        border: Border.all(color: const Color(0xFF388bfd)),
                        borderRadius: BorderRadius.circular(999),
                        boxShadow: const [
                          BoxShadow(
                            color: Color(0x66000000),
                            blurRadius: 12,
                            offset: Offset(0, 3),
                          ),
                        ],
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.keyboard_arrow_down,
                            color: Colors.white,
                            size: 18,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            provider.unreadCount > 0
                                ? t('newMessagesCount', {
                                    'n': '${provider.unreadCount}',
                                  })
                                : t('backToBottom'),
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                            ),
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
