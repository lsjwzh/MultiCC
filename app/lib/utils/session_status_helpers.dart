// 会话状态展示 helper（cli 品牌色 / 工作台状态色与标签 / 运行时长 / classify 徽章）。
// 自 main_shell.dart 抽出，供 main_shell / session_card 等 widget 共用。

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../services/workspace_service.dart';
import '../theme.dart';
import 'manual_order.dart';
import 'status_presentation.dart';

/// Prefix a task text with its stable short-code handle: `#CODE · text`.
/// The code (derived server-side from the taskId) stays put while the title
/// evolves, giving a persistent way to refer back to a task. Returns the text
/// unchanged when there is no code (task not yet attributed).
String withTaskCode(String? code, String text) {
  final c = (code ?? '').trim();
  if (c.isEmpty) return text;
  return '#$c · $text';
}

/// Brand color for a session's CLI.
Color cliBrandColor(SessionCli cli) => switch (cli) {
  SessionCli.claude => AppColors.claude,
  SessionCli.codex => AppColors.codex,
  SessionCli.opencode => AppColors.opencode,
  SessionCli.zcode => AppColors.zcode,
  SessionCli.qoder => AppColors.qoder,
};

// Workspace status board: 一律走中心 registry（utils/status_presentation.dart），
// 本文件不再自带状态色表/图标表——那正是 error 会话在卡片上只有一个灰点、没有
// 错误图标的成因。
StatusSpec wbStatusSpec(String? status) =>
    statusSpecOf(StatusDomain.session, status);

Color wbStatusColor(String? status) => wbStatusSpec(status).color;

String wbStatusLabel(String? status) => wbStatusSpec(status).label;

/// 状态图标：颜色之外必须还有一个非颜色通道（WCAG 1.4.1），异常处必为 ❌。
String wbStatusIcon(String? status) => wbStatusSpec(status).icon;

/// classify 字母的专用文案（比通用状态名更具体：「等待用户」而非「等待中」）。
/// 图标与色彩仍取自 registry，保证与其它展示面同源。返回 null 表示尚无判定，
/// 徽章直接隐藏。
///   D=succeeded · W=wait-user · B=wait-bg · E=api-error · P=processing
/// Legacy C 保留仅为渲染历史记录；它不得暗示客户端自行续跑。
const Map<String, String> _classifyLabelKey = {
  'D': 'classifySucceeded',
  'C': 'classifyContinuing',
  'W': 'classifyWaitingUser',
  'B': 'classifyWaitingBackground',
  'E': 'classifyApiError',
  'P': 'classifyProcessing',
};

({Color color, String label, String emoji})? classifyBadge(String? s) {
  final key = (s ?? '').trim().toUpperCase();
  final labelKey = _classifyLabelKey[key];
  if (labelKey == null) return null;
  final spec = statusPresentation[classifyStatusOf(key)]!;
  return (color: spec.color, label: t(labelKey), emoji: spec.icon);
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

/// Transport-level liveness → tint/label/emoji (mirrors classifyBadge but for
/// the working/idle/stalled verdict from GET /api/sessions/:id/liveness).
/// A null state hides the badge.
({Color color, String label, String emoji})? livenessBadge(String? state) {
  switch (state) {
    case 'working':
      return (
        color: const Color(0xFF56d364),
        label: t('livenessWorking'),
        emoji: '🟢',
      );
    case 'idle':
      return (
        color: const Color(0xFFe3b341),
        label: t('livenessIdle'),
        emoji: '🟡',
      );
    case 'stalled':
      return (
        color: const Color(0xFFf85149),
        label: t('livenessStalled'),
        emoji: '🔴',
      );
    case 'unknown':
      return (
        color: const Color(0xFF8a909b),
        label: t('livenessUnknown'),
        emoji: '⚪',
      );
    default:
      return null;
  }
}

/// Chat-page policy for [livenessChip]: only working (a turn is running) and
/// stalled (stuck) earn the dedicated liveness line under the header. idle and
/// unknown are the resting states — a permanent「空闲」pill row is noise, so
/// the chat screen renders no line for them at all.
bool chatLivenessDeservesLine(String? state) =>
    state == 'working' || state == 'stalled';

/// A small liveness pill for the chat header. `verdict` is the parsed liveness
/// JSON; a null/empty verdict renders nothing. Shows the silent duration on a
/// working/stalled turn so "stuck for 3m" reads at a glance.
Widget livenessChip(Map<String, dynamic>? verdict) {
  final state = verdict == null ? null : verdict['state'] as String?;
  final b = livenessBadge(state);
  if (b == null) return const SizedBox.shrink();
  var label = b.label;
  final silentMs = (verdict?['silentMs'] as num?)?.toInt() ?? 0;
  if ((state == 'stalled' || state == 'working') && silentMs >= 5000) {
    final s = (silentMs / 1000).round();
    label += s >= 60 ? ' · ${s ~/ 60}m ${s % 60}s' : ' · ${s}s';
  }
  final reason = verdict?['reason'] as String?;
  final chip = Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(
      color: b.color.withValues(alpha: 0.15),
      border: Border.all(color: b.color.withValues(alpha: 0.4)),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      '${b.emoji} $label',
      style: TextStyle(
        color: b.color,
        fontSize: 9.5,
        fontWeight: FontWeight.w700,
      ),
    ),
  );
  return (reason != null && reason.isNotEmpty)
      ? Tooltip(message: 'liveness: $state ($reason)', child: chip)
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

/// fleet 内部会话列表的排序键：创建时间升序（先建的排前面），createdAt 相同时
/// 用 id 兜底。对齐 web 的 sortSessionsByCreation。
///
/// 刻意不看 lastActivity、更不看实时 [SessionStatus] —— 那两者每来一次流式回复
/// 就变，卡片会被不断抽到最前，列表跳来跳去。createdAt 写入后不再变化，顺序恒定。
/// id 兜底也不是锦上添花：Dart 的 [List.sort] 非稳定排序，比较器只要有并列，
/// 每 5s 一次的 dashboard 轮询就可能把并列项换位。
///
/// 已知与 web 的差异：服务端 DTO 允许 createdAt 为 null（[Session.fromJson] 此时
/// 兜底成 DateTime.now()，会排到组尾；web 的 sessionCreatedMs 兜底成 0，排到组
/// 首）。两侧各自稳定，只是落位不同。当前 151/151 条会话都带 createdAt，够不着；
/// 之所以不动 fromJson 的兜底，是因为 [sessionLastInteractionAt] 也读它，改成
/// 纪元 0 会让「最后活动」显示成几十年前。
int compareSessionsByCreation(Session a, Session b) {
  final byCreation = a.createdAt.compareTo(b.createdAt);
  return byCreation != 0 ? byCreation : a.id.compareTo(b.id);
}

/// 会话列表统一排序：commander（[Session.isCommander]）固定钉在最前、不参与其余
/// 会话的排序；其余会话保持调用方已排好的相对顺序。对齐 web 的
/// sortSessionsPinningCommander。Dart 的 List.sort 非稳定，故用「分区」而非
/// 比较器：commander 与非 commander 各自保留传入顺序再拼接。调用方可先按自己
/// 的规则（如最近交互时间）排好再传入。
List<Session> pinCommanderFirst(List<Session> sessions) {
  final commanders = sessions.where((s) => s.isCommander).toList();
  if (commanders.isEmpty) return sessions;
  final rest = sessions.where((s) => !s.isCommander).toList();
  return [...commanders, ...rest];
}

/// fleet 内部会话列表的最终顺序：先按创建时间升序，叠上用户拖出来的手动顺序
/// [manualOrder]，最后把 commander 钉到最前。
///
/// 三步的次序不是随意的，且与 web 的 renderDirSessionGroups 一字对齐：创建时间是
/// **默认**顺序（用户没拖过的会话按它落位），手动顺序是叠在上面的覆盖层，
/// commander 钉首则是单独一趟——把它塞进比较器会让「commander 也能被拖」变成一句
/// 谎话，也会因为 Dart 的 [List.sort] 非稳定而在并列时抖动。
///
/// provider（[SessionManager.sessionsByKind]）与 widget（_SessionGroup）都走它，
/// 而不是各排各的——两处各写一遍比较器，就意味着改一处漏一处时无人报错。幂等，
/// 重复调用不会改变结果。
List<Session> orderFleetSessions(
  Iterable<Session> sessions, {
  List<String> manualOrder = const [],
}) {
  final byCreation = sessions.toList()..sort(compareSessionsByCreation);
  return pinCommanderFirst(
    applyManualOrder(byCreation, manualOrder, (s) => s.id),
  );
}

/// 把某个目录下的会话按 kind 分成 `{chat: [...], terminal: [...]}` 两组，各组
/// 内部走 [orderFleetSessions]。对齐 web 的 renderDirSessionGroups 分组方式：
/// 只按 kind 分，不再按 cli 分。缺 kind 的按 terminal 处理。
///
/// 抽成纯函数是为了能直接测：[SessionManager] 要连服务和轮询定时器才建得起来，
/// 测不到就等于「排序 helper 有测试、真正决定渲染顺序的调用点没有」。
///
/// [manualOrder] 是该目录下用户拖出来的顺序，**一份平铺的 id 列表**覆盖两个分组
/// ——一个会话只可能落在其中一组里，按组分开存反而要求客户端知道每个 id 属于哪
/// 一组才能写回，而组归属会随 kind 变化。web 也是这么存的（sessionOrder[dirId]），
/// 两侧共用同一份服务端数据，就必须共用这个形状。
Map<String, List<Session>> groupFleetSessionsByKind(
  Iterable<Session> sessions,
  String dirId, {
  List<String> manualOrder = const [],
}) {
  final chats = <Session>[];
  final terminals = <Session>[];
  for (final s in sessions) {
    if (s.dirId != dirId) continue;
    (s.isChat ? chats : terminals).add(s);
  }
  return {
    'chat': orderFleetSessions(chats, manualOrder: manualOrder),
    'terminal': orderFleetSessions(terminals, manualOrder: manualOrder),
  };
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
// 「还在跑吗」与「要不要转圈」是同一个判断，所以读 registry 的 spinner 位，而不
// 是再列一遍 thinking/editing/running 之类的别名。
bool isRunningStatus(String? s) => wbStatusSpec(s).spinner;

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
