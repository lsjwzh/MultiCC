// 会话状态展示 helper（cli 品牌色 / 工作台状态色与标签 / 运行时长 / classify 徽章）。
// 自 main_shell.dart 抽出，供 main_shell / session_card 等 widget 共用。

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../services/workspace_service.dart';
import '../theme.dart';

/// Brand color for a session's CLI.
Color cliBrandColor(SessionCli cli) => switch (cli) {
  SessionCli.claude => AppColors.claude,
  SessionCli.codex => AppColors.codex,
  SessionCli.opencode => AppColors.opencode,
  SessionCli.zcode => AppColors.zcode,
};

// Workspace status board: map a live agent status to a colour / label.
Color wbStatusColor(String? status) {
  switch (status) {
    case 'thinking':
      return const Color(0xFF6aa3ff);
    case 'editing':
      return const Color(0xFFe3b341);
    case 'running':
      return const Color(0xFF7fd49a);
    case 'waiting':
      return const Color(0xFFf0936b);
    case 'completed':
      return const Color(0xFF3ad6c5);
    case 'error':
      return const Color(0xFFff6b63);
    default:
      return const Color(0xFF5b616c);
  }
}

String wbStatusLabel(String? status) {
  switch (status) {
    case 'thinking':
      return t('thinking');
    case 'editing':
      return t('editing');
    case 'running':
      return t('running');
    case 'waiting':
      return t('waiting');
    case 'completed':
      return t('completed');
    case 'error':
      return t('error');
    default:
      return t('idle');
  }
}

/// Live classify-state (aux-AI intent classifier) badge styling, aligned to the
/// web fleet cards (manage.js _CLASSIFY_BADGE). Returns null for sessions with
/// no classify verdict yet, so the badge is simply hidden.
///   D=done · C=continue · W=wait-user · B=wait-bg · E=api-error · P=processing
({Color color, String label, String emoji})? classifyBadge(String? s) {
  switch (s) {
    case 'D':
      return (
        color: const Color(0xFF56d364),
        label: t('classifyDone'),
        emoji: '✅',
      );
    case 'C':
      return (
        color: const Color(0xFF6cb6ff),
        label: t('classifyContinuing'),
        emoji: '▶️',
      );
    case 'W':
      return (
        color: const Color(0xFFe3b341),
        label: t('classifyWaitingUser'),
        emoji: '⏸️',
      );
    case 'B':
      return (
        color: const Color(0xFFe3b341),
        label: t('classifyWaitingBackground'),
        emoji: '⏳',
      );
    case 'E':
      return (
        color: const Color(0xFFf85149),
        label: t('classifyApiError'),
        emoji: '⚠️',
      );
    case 'P':
      return (
        color: const Color(0xFF6cb6ff),
        label: t('classifyProcessing'),
        emoji: '🔄',
      );
    default:
      return null;
  }
}

/// A small classify-state pill. Shows the state emoji (+ optional label) tinted
/// by state, with the current task goal as a tooltip. Empty widget when the
/// session has no classify verdict.
Widget classifyChip(SessionStatus? live, {bool showLabel = true}) {
  final b = classifyBadge(live?.classifyState);
  if (b == null) return const SizedBox.shrink();
  final goal = live?.goal;
  final chip = Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(
      color: b.color.withValues(alpha: 0.15),
      border: Border.all(color: b.color.withValues(alpha: 0.4)),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      showLabel ? '${b.emoji} ${b.label}' : b.emoji,
      style: TextStyle(
        color: b.color,
        fontSize: 9.5,
        fontWeight: FontWeight.w700,
      ),
    ),
  );
  return (goal != null && goal.isNotEmpty)
      ? Tooltip(message: goal, child: chip)
      : chip;
}

DateTime sessionLastInteractionAt(Session session, SessionStatus? live) {
  var best = session.createdAt;
  final saved = session.lastActivity;
  if (saved != null && saved.isAfter(best)) best = saved;
  final liveMs = live?.lastActivity ?? 0;
  if (liveMs > 0) {
    final liveAt = DateTime.fromMillisecondsSinceEpoch(liveMs);
    if (liveAt.isAfter(best)) best = liveAt;
  }
  return best;
}

String formatRelativeTime(DateTime value, {DateTime? now}) {
  final diff = (now ?? DateTime.now()).difference(value);
  if (diff.isNegative || diff.inMinutes < 1) return t('justNow');
  if (diff.inHours < 1) {
    return t('minutesAgo', {'n': '${diff.inMinutes}'});
  }
  if (diff.inDays < 1) {
    return t('hoursAgo', {'n': '${diff.inHours}'});
  }
  return t('daysAgo', {'n': '${diff.inDays}'});
}

// ── 任务运行时长 ────────────────────────────────────────────────────────────
// 从用户发出消息（runStartedAt）算起任务执行了多久；进行中实时累加，终止/等待
// 时冻结到 runEndedAt。返回 null 表示无可用数据。
bool isRunningStatus(String? s) =>
    s == 'thinking' || s == 'editing' || s == 'running';

Duration? runDuration(SessionStatus? live) {
  if (live == null || live.runStartedAt <= 0) return null;
  final running = isRunningStatus(live.status) && live.runEndedAt <= 0;
  final end = running
      ? DateTime.now().millisecondsSinceEpoch
      : (live.runEndedAt > 0 ? live.runEndedAt : live.runStartedAt);
  final ms = end - live.runStartedAt;
  return Duration(milliseconds: ms < 0 ? 0 : ms);
}

String formatRunDuration(Duration d) {
  final totalSec = d.inSeconds;
  final h = totalSec ~/ 3600;
  final m = (totalSec % 3600) ~/ 60;
  final sec = totalSec % 60;
  if (h > 0) {
    return t('durationHoursMinutes', {
      'h': '$h',
      'm': m.toString().padLeft(2, '0'),
    });
  }
  if (m > 0) {
    return t('durationMinutesSeconds', {
      'm': '$m',
      's': sec.toString().padLeft(2, '0'),
    });
  }
  return t('durationSeconds', {'s': '$sec'});
}

// 运行时长短语（带 ⏱），无数据返回空串。
String runTimeText(SessionStatus? live) {
  final d = runDuration(live);
  return d == null ? '' : '⏱ ${formatRunDuration(d)}';
}
