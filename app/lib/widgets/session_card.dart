// 会话卡片（目录/分组列表里的单卡，含状态/计时/git 等）。自 main_shell.dart 抽出。

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../utils/session_status_helpers.dart';
import '../utils/status_presentation.dart';
import '../providers/session_manager.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../services/workspace_service.dart';
import '../widgets/conflict_diff_dialog.dart';
import '../widgets/git_log_sheet.dart';
import '../widgets/rainbow_border.dart';
import '../widgets/session_badges.dart';
import '../widgets/session_diff_dialog.dart';
import '../screens/terminal_screen.dart';

String _mergeReadyLabel(SessionStatus status) {
  final ahead = status.ahead;
  final dirty = status.dirty;
  final base = status.baseBranch ?? t('baseBranch');
  if (dirty && ahead > 0) {
    return t('mergeReadyLabelDirtyAhead', {'n': '$ahead', 'base': base});
  }
  if (ahead > 0) {
    return t('mergeReadyLabelAhead', {'n': '$ahead', 'base': base});
  }
  return t('mergeReadyLabel', {'base': base});
}

class SessionCard extends StatelessWidget {
  final Session session;
  final SessionManager mgr;
  final SettingsService settings;
  final SessionStatus? liveStatus;
  final int pendingNotes;
  final List<Map<String, dynamic>> providers;
  final ValueChanged<Session>? onOpen;
  const SessionCard({
    super.key,
    required this.session,
    required this.mgr,
    required this.settings,
    this.liveStatus,
    this.pendingNotes = 0,
    this.providers = const [],
    this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    final cliColor = cliBrandColor(session.cli);
    final live = liveStatus;
    final lastInteraction = sessionLastInteractionAt(session, live);
    final ago = formatRelativeTime(lastInteraction);
    // 一张卡只折叠一次状态，之后色/图标/文案都从同一个 spec 取——分头判断正是
    // error 会话在卡片上没有错误图标的成因。
    final cardStatus = sessionCardStatusOf(
      monitorStatus: live?.status,
      active: session.active,
    );
    final statusSpec = statusPresentation[cardStatus]!;
    final statusColor = statusSpec.color;
    final isRunning = statusSpec.spinner;
    final mergeReady = live?.mergeReady == true;
    final hasLabel = session.label?.isNotEmpty == true;
    final title = hasLabel ? session.label! : session.id;
    final modelRaw = session.effectiveModel?.isNotEmpty == true
        ? session.effectiveModel
        : (session.model?.isNotEmpty == true ? session.model : null);
    Map? modelAlias;
    if (modelRaw != null && session.provider?.isNotEmpty == true) {
      final m = providers.firstWhere(
        (p) => p['id'] == session.provider,
        orElse: () => {},
      )['aliasMap'];
      if (m is Map) modelAlias = m;
    }
    final model = modelRaw == null
        ? ''
        : modelDisplayName(session.cli, modelRaw, aliasMap: modelAlias);
    final effort = effortShortNameForCli(
      session.cli,
      session.effectiveEffort ?? session.effort,
    );
    // Resolve provider display name from the cached provider list.
    String? provName;
    if (session.provider != null && session.provider!.isNotEmpty) {
      try {
        final match = providers.firstWhere(
          (p) => p['id'] == session.provider,
          orElse: () => {},
        );
        provName = match['name']?.toString();
      } catch (_) {}
      provName ??= session.provider!.length > 8
          ? session.provider!.substring(0, 8)
          : session.provider;
    }

    return RainbowBorder(
      running: isRunning,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        decoration: BoxDecoration(
          color: const Color(0xFF070809),
          border: Border.all(color: const Color(0xFF20242b)),
          borderRadius: BorderRadius.circular(8),
        ),
        child: InkWell(
          onTap: () {
            final open = onOpen;
            if (open != null) {
              open(session);
            } else {
              _open(context);
            }
          },
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    // 图标 + 无障碍名，不靠颜色单通道传达状态（WCAG 1.4.1）：
                    // 出错的会话在这里就是 ❌，而不是一个红色小圆点。
                    // idle 是默认态，一个 ⚪ 摆在行首只有噪音（空闲文案同样
                    // 隐藏），不渲染；unknown 的 ❔ 是诊断信号，保留。
                    if (cardStatus != CanonicalStatus.idle) ...[
                      Semantics(
                        label: statusSpec.semanticLabel,
                        child: Text(
                          statusSpec.icon,
                          style: const TextStyle(fontSize: 11),
                        ),
                      ),
                      const SizedBox(width: 6),
                    ],
                    if (classifyBadge(live?.classifyState) != null) ...[
                      classifyChip(live, showLabel: false),
                      const SizedBox(width: 6),
                    ],
                    MiniBadge(label: session.cli.name, color: cliColor),
                    if (cardStatus != CanonicalStatus.idle &&
                        cardStatus != CanonicalStatus.unknown) ...[
                      const SizedBox(width: 6),
                      Text(
                        statusSpec.label,
                        style: TextStyle(
                          color: statusColor,
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                    if (pendingNotes > 0) ...[
                      const SizedBox(width: 6),
                      Text(
                        '📨$pendingNotes',
                        style: const TextStyle(
                          fontSize: 10,
                          color: Color(0xFFe3b341),
                        ),
                      ),
                    ],
                    const Spacer(),
                    if (provName != null) ...[
                      Flexible(
                        child: Text(
                          provName,
                          style: const TextStyle(
                            color: Color(0xFF7aa2f7),
                            fontSize: 10,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 6),
                    ],
                    if (model.isNotEmpty) ...[
                      Flexible(
                        child: Text(
                          model,
                          style: const TextStyle(
                            color: Color(0xFF22ab9c),
                            fontSize: 10,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 6),
                    ],
                    if (effort.isNotEmpty) ...[
                      Flexible(
                        child: Text(
                          effort,
                          style: const TextStyle(
                            color: Color(0xFF8a909b),
                            fontSize: 10,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 6),
                    ],
                    Text(
                      ago,
                      style: const TextStyle(
                        color: Color(0xFF5b616c),
                        fontSize: 10,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 9),
                Text(
                  title,
                  style: const TextStyle(
                    color: Color(0xFFe7eaee),
                    fontSize: 12,
                    fontFamily: 'monospace',
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                // 有 label 时 id 仍有辨识价值（worktree 分支名）。无 label 时
                // 副标题只会重复 worktree 目录名（与标题里的 id 几乎同串），
                // working 目录整体收进 ⋯ 菜单，不再独占一行。
                if (hasLabel) ...[
                  const SizedBox(height: 3),
                  Text(
                    session.id,
                    style: const TextStyle(
                      color: Color(0xFF5b616c),
                      fontSize: 11,
                      fontFamily: 'monospace',
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                if (live?.currentFile != null) ...[
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      const Icon(
                        Icons.edit_outlined,
                        size: 11,
                        color: Color(0xFFe3b341),
                      ),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          live!.currentFile!.split('/').last,
                          style: const TextStyle(
                            color: Color(0xFFe3b341),
                            fontSize: 10,
                            fontFamily: 'monospace',
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ],
                if (live?.summary?.isNotEmpty == true) ...[
                  const SizedBox(height: 6),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 7,
                      vertical: 5,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0x243ad6c5),
                      border: Border.all(color: const Color(0x663ad6c5)),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      '🗒 ${live!.summary}',
                      style: const TextStyle(
                        color: Color(0xFF7fe6da),
                        fontSize: 10.5,
                        height: 1.35,
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
                if (runTimeText(live).isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    runTimeText(live),
                    style: const TextStyle(
                      color: Color(0xFF7a818c),
                      fontSize: 10,
                      fontFamily: 'monospace',
                    ),
                  ),
                ],
                if ((live?.behind ?? 0) > 0) ...[
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      const Icon(
                        Icons.history_rounded,
                        size: 11,
                        color: Color(0xFFf2cc60),
                      ),
                      const SizedBox(width: 4),
                      Text(
                        t('behindCommits', {
                          'base': live!.baseBranch ?? t('baseBranch'),
                          'n': '${live.behind}',
                        }),
                        style: const TextStyle(
                          color: Color(0xFFf2cc60),
                          fontSize: 10,
                        ),
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 6),
                // Lean action row: the actionable "merge" stays inline only when a
                // merge is ready; everything else lives in a ⋯ menu so the card
                // stays compact (was a row of 6 always-visible icon buttons).
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    if (mergeReady)
                      TextButton.icon(
                        icon: const Icon(
                          Icons.merge_type_rounded,
                          size: 15,
                          color: Color(0xFF070809),
                        ),
                        label: Text(
                          _mergeReadyLabel(live!),
                          style: const TextStyle(
                            color: Color(0xFF070809),
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        style: TextButton.styleFrom(
                          backgroundColor: const Color(0xFFe3b341),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 4,
                          ),
                          minimumSize: const Size(0, 28),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        onPressed: () => _mergeSession(context),
                      ),
                    PopupMenuButton<String>(
                      icon: const Icon(
                        Icons.more_horiz_rounded,
                        size: 18,
                        color: Color(0xFF8a909b),
                      ),
                      tooltip: t('moreActions'),
                      color: const Color(0xFF161b22),
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(minWidth: 160),
                      onSelected: (v) {
                        switch (v) {
                          case 'rename':
                            _rename(context);
                            break;
                          case 'merge':
                            _mergeSession(context);
                            break;
                          case 'diff':
                            showSessionDiffDialog(
                              context,
                              settings: settings,
                              sessionId: session.id,
                            );
                            break;
                          case 'gitlog':
                            showGitLogSheet(
                              context,
                              fetchLog: (all) => SessionService(
                                settings: settings,
                              ).fetchGitLog(
                                sessionId: session.id,
                                allBranches: all,
                              ),
                              fetchDiff: (hash) => SessionService(
                                settings: settings,
                              ).fetchGitCommitDiff(
                                sessionId: session.id,
                                hash: hash,
                              ),
                            );
                            break;
                          case 'rebase':
                            _rebaseSession(context);
                            break;
                          case 'relocate':
                            _relocateSession(context);
                            break;
                          case 'note':
                            _leaveNote(context);
                            break;
                          case 'restart':
                            _restart(context);
                            break;
                          case 'delete':
                            _confirmDelete(context);
                            break;
                        }
                      },
                      itemBuilder: (_) => [
                        if (session.cwd.isNotEmpty) ...[
                          _cwdInfoItem(),
                          const PopupMenuDivider(),
                        ],
                        _menuItem('rename', Icons.edit_outlined, t('rename')),
                        if (!mergeReady)
                          _menuItem(
                            'merge',
                            Icons.merge_type_rounded,
                            t('mergeWorktree'),
                          ),
                        _menuItem(
                          'diff',
                          Icons.difference_outlined,
                          t('viewDiff'),
                        ),
                        _menuItem(
                          'gitlog',
                          Icons.history_rounded,
                          t('gitLog'),
                        ),
                        _menuItem(
                          'rebase',
                          Icons.call_merge_rounded,
                          t('rebaseResolve'),
                        ),
                        _menuItem(
                          'relocate',
                          Icons.drive_file_move_outline,
                          t('relocateSession'),
                        ),
                        _menuItem(
                          'note',
                          Icons.mail_outline_rounded,
                          t('leaveNote'),
                        ),
                        if (session.isTerminal)
                          _menuItem(
                            'restart',
                            Icons.restart_alt_rounded,
                            t('restartSession'),
                          ),
                        const PopupMenuDivider(),
                        _menuItem(
                          'delete',
                          Icons.delete_outline_rounded,
                          t('delete'),
                          danger: true,
                        ),
                      ],
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 菜单顶部的只读信息行：working 目录（短名），长按/悬停看完整路径。
  /// 不响应点击、置灰显示——与目录卡菜单里「⚠ N 个未提交文件」的信息项
  /// 同一模式。working 目录从卡片副标题行收编到这里，卡片每行少占一行。
  PopupMenuItem<String> _cwdInfoItem() {
    return PopupMenuItem<String>(
      enabled: false,
      height: 36,
      child: Tooltip(
        message: session.cwd,
        child: Row(
          children: [
            const Icon(
              Icons.folder_outlined,
              size: 15,
              color: Color(0xFF8a909b),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                session.shortCwd,
                key: const Key('session-card-cwd'),
                style: const TextStyle(
                  color: Color(0xFF8a909b),
                  fontSize: 12,
                  fontFamily: 'monospace',
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  PopupMenuItem<String> _menuItem(
    String value,
    IconData icon,
    String label, {
    bool danger = false,
  }) {
    final color = danger ? const Color(0xFFff6b63) : const Color(0xFFe7eaee);
    return PopupMenuItem<String>(
      value: value,
      height: 40,
      child: Row(
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 10),
          Text(label, style: TextStyle(color: color, fontSize: 14)),
        ],
      ),
    );
  }

  Future<void> _rename(BuildContext context) async {
    final ctrl = TextEditingController(text: session.label ?? session.id);
    final messenger = ScaffoldMessenger.of(context);
    final next = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: Text(
          t('renameSessionTitle'),
          style: const TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
        ),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLength: 80,
          style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
          decoration: InputDecoration(
            hintText: session.id,
            hintStyle: const TextStyle(color: Color(0xFF454b54)),
            filled: true,
            fillColor: const Color(0xFF070809),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
            counterStyle: const TextStyle(color: Color(0xFF5b616c)),
          ),
          onSubmitted: (v) => Navigator.pop(context, v),
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
            onPressed: () => Navigator.pop(context, ctrl.text),
            child: Text(
              t('save'),
              style: const TextStyle(
                color: Color(0xFF6aa3ff),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
    if (next == null) return;
    try {
      await mgr.renameSession(session.id, next.trim());
      messenger.showSnackBar(SnackBar(content: Text(t('renameSessionSaved'))));
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(t('renameSessionFailed', {'error': '$e'}))),
      );
    }
  }

  Future<void> _leaveNote(BuildContext context) async {
    final siblings = mgr.sessions
        .where((x) => x.dirId == session.dirId && x.id != session.id)
        .toList();
    if (siblings.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(t('leaveNoteNoTarget'))));
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    var targetId = siblings.first.id;
    final bodyCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          backgroundColor: const Color(0xFF0f1115),
          title: Text(
            t('leaveNoteTitle'),
            style: const TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                t('leaveNoteHint'),
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 10),
              DropdownButton<String>(
                value: targetId,
                isExpanded: true,
                dropdownColor: const Color(0xFF0f1115),
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                items: [
                  for (final s in siblings)
                    DropdownMenuItem(
                      value: s.id,
                      child: Text(
                        '${s.label?.isNotEmpty == true ? s.label : s.id}'
                        ' (${s.cli.name}/${s.kind.name})',
                      ),
                    ),
                ],
                onChanged: (v) => setLocal(() => targetId = v ?? targetId),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: bodyCtrl,
                autofocus: true,
                maxLines: 4,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                decoration: InputDecoration(
                  hintText: t('leaveNoteBody'),
                  hintStyle: const TextStyle(color: Color(0xFF454b54)),
                  filled: true,
                  fillColor: const Color(0xFF070809),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(6),
                  ),
                ),
              ),
            ],
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
                t('leaveNoteSend'),
                style: const TextStyle(
                  color: Color(0xFF6aa3ff),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
    if (ok != true) return;
    final body = bodyCtrl.text.trim();
    if (body.isEmpty) return;
    try {
      await SessionService(
        settings: settings,
      ).postNote(fromSessionId: session.id, toSessionId: targetId, body: body);
      messenger.showSnackBar(SnackBar(content: Text(t('leaveNoteSent'))));
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(t('leaveNoteFailed', {'error': '$e'}))),
      );
    }
  }

  Future<void> _mergeSession(BuildContext context) async {
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
      ).mergeSession(session.id);
      final hasConflict =
          result['conflicts'] is List &&
          (result['conflicts'] as List).isNotEmpty;
      final msg = result['ok'] == true
          ? (result['merged'] == true
                ? t('merged', {'n': '${result['commits'] ?? 0}'})
                : t('mergedNothing', {'msg': t('mergeNoNewCommits')}))
          : hasConflict
          ? t('mergeConflict', {
              'files': (result['conflicts'] as List).join(', '),
            })
          : t('mergeFailed', {'error': '${result['error'] ?? ''}'});
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(msg)));
      if (hasConflict && context.mounted) {
        await showConflictDiffDialog(
          context,
          sessionId: session.id,
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

  void _open(BuildContext context) {
    if (session.isChat) {
      mgr.openSession(session);
      mgr.switchToSession(session.id);
    } else {
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => TerminalScreen(settings: settings, session: session),
        ),
      );
    }
  }

  /// Resolve an in-progress rebase: 'continue' marks conflicts resolved and
  /// proceeds; 'abort' rolls the worktree back to the pre-rebase state. Mirrors
  /// web manage's rebase-resolve flow. Use after a sync/merge left conflicts.
  Future<void> _rebaseSession(BuildContext context) async {
    String action = 'continue';
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          backgroundColor: const Color(0xFF0f1115),
          title: Text(
            t('rebaseResolve'),
            style: const TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                t('rebaseResolveHint'),
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 12),
              Column(
                children: [
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Radio<String>(
                      value: 'continue',
                      groupValue: action,
                      onChanged: (v) {
                        if (v != null) setLocal(() => action = v);
                      },
                    ),
                    title: Text(
                      t('rebaseContinueResolved'),
                      style: const TextStyle(
                        color: Color(0xFFe7eaee),
                        fontSize: 13,
                      ),
                    ),
                  ),
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Radio<String>(
                      value: 'abort',
                      groupValue: action,
                      onChanged: (v) {
                        if (v != null) setLocal(() => action = v);
                      },
                    ),
                    title: Text(
                      t('rebaseAbortRollback'),
                      style: const TextStyle(
                        color: Color(0xFFe7eaee),
                        fontSize: 13,
                      ),
                    ),
                  ),
                ],
              ),
            ],
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
                action == 'abort' ? t('abortAction') : t('continueAction'),
                style: const TextStyle(
                  color: Color(0xFF6aa3ff),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
    if (ok != true || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          action == 'abort' ? t('rebaseAborting') : t('rebaseContinuing'),
        ),
      ),
    );
    try {
      final result = await SessionService(
        settings: settings,
      ).rebaseSession(session.id, action: action);
      final hasConflict =
          result['conflicts'] is List &&
          (result['conflicts'] as List).isNotEmpty;
      final msg = result['ok'] == true
          ? (result['aborted'] == true
                ? t('rebaseAborted')
                : (result['done'] == true
                      ? t('rebaseCompleted')
                      : t('rebaseContinued')))
          : hasConflict
          ? t('rebaseStillConflicted', {
              'files': (result['conflicts'] as List).join(', '),
            })
          : t('rebaseFailed', {'error': '${result['error'] ?? ''}'});
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(msg)));
      if (hasConflict && context.mounted) {
        await showConflictDiffDialog(
          context,
          sessionId: session.id,
          result: result,
        );
      }
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(content: Text(t('rebaseRequestFailed', {'error': '$e'}))),
      );
    }
  }

  /// Relocate this session to a different directory: drops the old worktree and
  /// creates a fresh one in the target directory's repo. The session keeps its
  /// id but its worktreePath/branch/dirId change.
  Future<void> _relocateSession(BuildContext context) async {
    final candidates = mgr.directories
        .where((d) => d.id != session.dirId)
        .toList();
    if (candidates.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(t('relocateNoTarget'))));
      return;
    }
    String targetId = candidates.first.id;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          backgroundColor: const Color(0xFF0f1115),
          title: Text(
            t('relocateSession'),
            style: const TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                t('relocateSessionHint'),
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 10),
              DropdownButton<String>(
                value: targetId,
                isExpanded: true,
                dropdownColor: const Color(0xFF0f1115),
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                items: [
                  for (final d in candidates)
                    DropdownMenuItem(value: d.id, child: Text(d.name)),
                ],
                onChanged: (v) {
                  if (v != null) setLocal(() => targetId = v);
                },
              ),
            ],
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
                t('relocateAction'),
                style: const TextStyle(
                  color: Color(0xFF6aa3ff),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
    if (ok != true || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(SnackBar(content: Text(t('relocatingSession'))));
    try {
      final result = await SessionService(
        settings: settings,
      ).relocateSession(session.id, targetId);
      final msg = result['ok'] == true
          ? t('relocatedSession')
          : t('relocateFailed', {'error': '${result['error'] ?? ''}'});
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(msg)));
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(content: Text(t('relocateRequestFailed', {'error': '$e'}))),
      );
    }
  }

  Future<void> _restart(BuildContext context) async {
    try {
      await mgr.restartSession(session.id);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(t('restartDone')),
            backgroundColor: const Color(0xFF22ab9c),
          ),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(t('restartFailed', {'error': '$e'})),
            backgroundColor: const Color(0xFFff6b63),
          ),
        );
      }
    }
  }

  Future<void> _confirmDelete(BuildContext context) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: Text(
          t('deleteSessionConfirm'),
          style: const TextStyle(color: Color(0xFFf2f4f7)),
        ),
        content: Text(
          t('deleteSessionBody', {'id': session.id}),
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
              t('delete'),
              style: const TextStyle(color: Color(0xFFff6b63)),
            ),
          ),
        ],
      ),
    );
    if (confirm == true) mgr.deleteSession(session.id);
  }
}
