// 会话卡片（目录/分组列表里的单卡，含状态/计时/git 等）。自 main_shell.dart 抽出。

import 'package:flutter/material.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../i18n.dart';
import '../models/message.dart';
import '../utils/session_status_helpers.dart';
import '../providers/session_manager.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../services/workspace_service.dart';
import '../widgets/conflict_diff_dialog.dart';
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
    final ago = timeago.format(lastInteraction, locale: 'en_short');
    final statusColor = live != null
        ? wbStatusColor(live.status)
        : (session.active ? const Color(0xFF7fd49a) : const Color(0xFF5b616c));
    final isRunning = live != null && isRunningStatus(live.status);
    final mergeReady = live?.mergeReady == true;
    final title = session.label?.isNotEmpty == true
        ? session.label!
        : session.id;
    final subtitle = session.label?.isNotEmpty == true
        ? session.id
        : session.shortCwd;
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
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        color: statusColor,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 7),
                    if (classifyBadge(live?.classifyState) != null) ...[
                      classifyChip(live, showLabel: false),
                      const SizedBox(width: 6),
                    ],
                    MiniBadge(label: session.cli.name, color: cliColor),
                    const SizedBox(width: 6),
                    MiniBadge(
                      label: session.kind.name,
                      color: const Color(0xFF8a909b),
                      icon: session.isChat
                          ? Icons.chat_bubble_outline_rounded
                          : Icons.terminal_rounded,
                    ),
                    if (live != null && live.status != 'idle') ...[
                      const SizedBox(width: 6),
                      Text(
                        wbStatusLabel(live.status),
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
                const SizedBox(height: 3),
                Text(
                  subtitle,
                  style: const TextStyle(
                    color: Color(0xFF5b616c),
                    fontSize: 11,
                    fontFamily: 'monospace',
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
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
                        '落后 ${live!.baseBranch ?? 'base'} ${live.behind} 个提交',
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
                      tooltip: '更多操作',
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
                        _menuItem('rename', Icons.edit_outlined, '改名'),
                        if (!mergeReady)
                          _menuItem(
                            'merge',
                            Icons.merge_type_rounded,
                            '合并 worktree',
                          ),
                        _menuItem('diff', Icons.difference_outlined, '查看 Diff'),
                        _menuItem('rebase', Icons.call_merge_rounded, 'Rebase 解决冲突'),
                        _menuItem('relocate', Icons.drive_file_move_outline, '迁移到其他Fleet'),
                        _menuItem('note', Icons.mail_outline_rounded, '留言'),
                        if (session.isTerminal)
                          _menuItem(
                            'restart',
                            Icons.restart_alt_rounded,
                            'Restart',
                          ),
                        const PopupMenuDivider(),
                        _menuItem(
                          'delete',
                          Icons.delete_outline_rounded,
                          '删除',
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
        title: const Text(
          'Rename Session',
          style: TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
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
            child: const Text(
              'Cancel',
              style: TextStyle(color: Color(0xFF8a909b)),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, ctrl.text),
            child: const Text(
              'Save',
              style: TextStyle(
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
      messenger.showSnackBar(const SnackBar(content: Text('Session renamed')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Rename failed: $e')));
    }
  }

  Future<void> _leaveNote(BuildContext context) async {
    final siblings = mgr.sessions
        .where((x) => x.dirId == session.dirId && x.id != session.id)
        .toList();
    if (siblings.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('该Fleet下没有其他会话可留言')));
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
          title: const Text(
            '留言',
            style: TextStyle(fontSize: 15, color: Color(0xFFf2f4f7)),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '留言会在对方下一轮对话开始时送达。',
                style: TextStyle(color: Color(0xFF8a909b), fontSize: 11),
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
                  hintText: '留言内容…',
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
              child: const Text(
                '取消',
                style: TextStyle(color: Color(0xFF8a909b)),
              ),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text(
                '发送',
                style: TextStyle(
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
      messenger.showSnackBar(const SnackBar(content: Text('留言已发送')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('发送失败：$e')));
    }
  }

  Future<void> _mergeSession(BuildContext context) async {
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
      ).mergeSession(session.id);
      final hasConflict =
          result['conflicts'] is List &&
          (result['conflicts'] as List).isNotEmpty;
      final msg = result['ok'] == true
          ? (result['merged'] == true
                ? '✓ 已合并 ${result['commits']} 个提交回基分支'
                : '✓ ${result['message'] ?? '没有新提交需要合并'}')
          : hasConflict
          ? '⚠️ 合并冲突，已 abort：${(result['conflicts'] as List).join(', ')}'
          : '合并失败：${result['error'] ?? ''}';
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
      messenger.showSnackBar(SnackBar(content: Text('合并请求失败：$e')));
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
          title: const Text('Rebase 解决冲突',
              style: TextStyle(fontSize: 15, color: Color(0xFFf2f4f7))),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '解决 worktree 与基分支的冲突。选择「继续」表示冲突已解决并提交，'
                '服务器会完成 rebase；选择「放弃」回滚到 rebase 前状态。',
                style: TextStyle(color: Color(0xFF8a909b), fontSize: 11),
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
                    title: const Text('继续（冲突已解决）',
                        style: TextStyle(color: Color(0xFFe7eaee), fontSize: 13)),
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
                    title: const Text('放弃（回滚）',
                        style: TextStyle(color: Color(0xFFe7eaee), fontSize: 13)),
                  ),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消', style: TextStyle(color: Color(0xFF8a909b))),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(action == 'abort' ? '放弃' : '继续',
                  style: const TextStyle(
                      color: Color(0xFF6aa3ff), fontWeight: FontWeight.w600)),
            ),
          ],
        ),
      ),
    );
    if (ok != true || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(SnackBar(content: Text(action == 'abort' ? '正在放弃 rebase…' : '正在继续 rebase…')));
    try {
      final result = await SessionService(settings: settings)
          .rebaseSession(session.id, action: action);
      final hasConflict = result['conflicts'] is List &&
          (result['conflicts'] as List).isNotEmpty;
      final msg = result['ok'] == true
          ? (result['aborted'] == true
                ? '✓ rebase 已放弃，worktree 回到同步前状态'
                : (result['done'] == true
                      ? '✓ rebase 冲突已解决并完成同步'
                      : '✓ rebase 已继续'))
          : hasConflict
          ? '⚠️ 仍有冲突：${(result['conflicts'] as List).join(', ')}'
          : 'rebase 失败：${result['error'] ?? ''}';
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(msg)));
      if (hasConflict && context.mounted) {
        await showConflictDiffDialog(
          context, sessionId: session.id, result: result);
      }
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text('rebase 请求失败：$e')));
    }
  }

  /// Relocate this session to a different directory: drops the old worktree and
  /// creates a fresh one in the target directory's repo. The session keeps its
  /// id but its worktreePath/branch/dirId change.
  Future<void> _relocateSession(BuildContext context) async {
    final candidates = mgr.directories.where((d) => d.id != session.dirId).toList();
    if (candidates.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('没有其他Fleet可迁移')));
      return;
    }
    String targetId = candidates.first.id;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          backgroundColor: const Color(0xFF0f1115),
          title: const Text('迁移到其他Fleet',
              style: TextStyle(fontSize: 15, color: Color(0xFFf2f4f7))),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '在目标Fleet创建新 worktree，删除当前 worktree。会话 ID 与历史保留。',
                style: TextStyle(color: Color(0xFF8a909b), fontSize: 11),
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
              child: const Text('取消', style: TextStyle(color: Color(0xFF8a909b))),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('迁移',
                  style: TextStyle(
                      color: Color(0xFF6aa3ff), fontWeight: FontWeight.w600)),
            ),
          ],
        ),
      ),
    );
    if (ok != true || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(const SnackBar(content: Text('正在迁移会话…')));
    try {
      final result = await SessionService(settings: settings)
          .relocateSession(session.id, targetId);
      final msg = result['ok'] == true
          ? '✓ 已迁移到目标Fleet'
          : '迁移失败：${result['error'] ?? ''}';
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(msg)));
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text('迁移请求失败：$e')));
    }
  }

  Future<void> _restart(BuildContext context) async {
    try {
      await mgr.restartSession(session.id);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Session restarted'),
            backgroundColor: Color(0xFF22ab9c),
          ),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed: $e'),
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
        title: const Text(
          'Delete Session',
          style: TextStyle(color: Color(0xFFf2f4f7)),
        ),
        content: Text(
          'Delete "${session.id}"?',
          style: const TextStyle(color: Color(0xFFe7eaee)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text(
              'Cancel',
              style: TextStyle(color: Color(0xFF8a909b)),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text(
              'Delete',
              style: TextStyle(color: Color(0xFFff6b63)),
            ),
          ),
        ],
      ),
    );
    if (confirm == true) mgr.deleteSession(session.id);
  }
}
