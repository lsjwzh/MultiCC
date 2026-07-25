// 集中式状态展示 registry（APP 侧）。
//
// 与 Web 的 public/status-presentation.js 一一对应：同一套 canonical 词表、同一
// 组图标、同一优先级、同一 legacy 别名表。tests/test-status-presentation.js 会
// 读取本文件，断言两端不漂移。
//
// 本文件【不是】状态的事实源。事实源在服务端：
//   · session runState  — src/session-work-host.js getRunState()
//   · freeze reason     — src/session-work-scheduler.js FREEZE_REASON_RUN_STATE
//   · classify 字母     — src/classify/vocab.js CLASSIFY_DISPLAY
//   · task 生命周期     — src/task-board.js task.status
// 这里只做 canonical 值 → (图标/色彩/文案/动效) 的纯映射：不得从终端文本、日志
// 字符串或自然语言正则推断状态，也不得把进程存活（liveness）当业务状态。

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../theme.dart';

/// 两个状态域刻意不合并：会话回答「这个 agent 现在忙不忙」，任务回答「这件事做
/// 完没有」，语义不同，合成一个枚举会逼出错误的默认值。
enum StatusDomain { session, task }

enum CanonicalStatus {
  idle,
  queued,
  running,
  waiting,
  blocked,
  error,
  done,
  cancelled,
  archived,
  offline,
  unknown,
}

/// 单个 canonical 状态的展示规范。
///
/// [spinner] 只有 running 为 true —— 这是「异常卡片必须立刻停止转圈」的机制保证。
/// [terminal] 表示静止的终态；error 刻意不算终态（它可重试，标成终态会诱导隐藏）。
/// [priority] 多信号并存时谁胜出：故障高于进度，失败永远不会被乐观信号盖住。
class StatusSpec {
  const StatusSpec({
    required this.status,
    required this.icon,
    required this.tone,
    required this.spinner,
    required this.terminal,
    required this.priority,
    required this.labelKey,
    required this.ariaKey,
  });

  final CanonicalStatus status;
  final String icon;
  final String tone;
  final bool spinner;
  final bool terminal;
  final int priority;
  final String labelKey;
  final String ariaKey;

  String get label => t(labelKey);

  /// 无障碍名：始终用文字讲清状态，不靠颜色传达（对应 WCAG 1.4.1）。
  String get semanticLabel => t(ariaKey);

  Color get color => statusToneColor(tone);
}

const Map<CanonicalStatus, StatusSpec> statusPresentation = {
  CanonicalStatus.idle: StatusSpec(
    status: CanonicalStatus.idle,
    icon: '⚪',
    tone: 'neutral',
    spinner: false,
    terminal: false,
    priority: 10,
    labelKey: 'statusIdle',
    ariaKey: 'statusAriaIdle',
  ),
  CanonicalStatus.queued: StatusSpec(
    status: CanonicalStatus.queued,
    icon: '📥',
    tone: 'info',
    spinner: false,
    terminal: false,
    priority: 60,
    labelKey: 'statusQueued',
    ariaKey: 'statusAriaQueued',
  ),
  CanonicalStatus.running: StatusSpec(
    status: CanonicalStatus.running,
    icon: '🔄',
    tone: 'running',
    spinner: true,
    terminal: false,
    priority: 70,
    labelKey: 'statusRunning',
    ariaKey: 'statusAriaRunning',
  ),
  CanonicalStatus.waiting: StatusSpec(
    status: CanonicalStatus.waiting,
    icon: '⏸️',
    tone: 'waiting',
    spinner: false,
    terminal: false,
    priority: 50,
    labelKey: 'statusWaiting',
    ariaKey: 'statusAriaWaiting',
  ),
  CanonicalStatus.blocked: StatusSpec(
    status: CanonicalStatus.blocked,
    icon: '🔒',
    tone: 'blocked',
    spinner: false,
    terminal: false,
    priority: 80,
    labelKey: 'statusBlocked',
    ariaKey: 'statusAriaBlocked',
  ),
  CanonicalStatus.error: StatusSpec(
    status: CanonicalStatus.error,
    icon: '❌',
    tone: 'danger',
    spinner: false,
    terminal: false,
    priority: 90,
    labelKey: 'statusError',
    ariaKey: 'statusAriaError',
  ),
  CanonicalStatus.done: StatusSpec(
    status: CanonicalStatus.done,
    icon: '✅',
    tone: 'success',
    spinner: false,
    terminal: true,
    priority: 30,
    labelKey: 'statusDone',
    ariaKey: 'statusAriaDone',
  ),
  // 仅展示层：服务端把已取消的认领折叠成 runState idle，但「你把它停掉了」和
  // 「什么都没在跑」对读者是两件事，被中断的一轮更不能被打扮成已完成。
  CanonicalStatus.cancelled: StatusSpec(
    status: CanonicalStatus.cancelled,
    icon: '🚫',
    tone: 'muted',
    spinner: false,
    terminal: true,
    priority: 25,
    labelKey: 'statusCancelled',
    ariaKey: 'statusAriaCancelled',
  ),
  CanonicalStatus.archived: StatusSpec(
    status: CanonicalStatus.archived,
    icon: '🗄',
    tone: 'muted',
    spinner: false,
    terminal: true,
    priority: 20,
    labelKey: 'statusArchived',
    ariaKey: 'statusAriaArchived',
  ),
  CanonicalStatus.offline: StatusSpec(
    status: CanonicalStatus.offline,
    icon: '⊘',
    tone: 'muted',
    spinner: false,
    terminal: false,
    priority: 15,
    labelKey: 'statusOffline',
    ariaKey: 'statusAriaOffline',
  ),
  // 未知值的中性落点：既不落成功也不落进行中——认不出来的状态不能读作「做完了」
  // 或「还在跑」。每次命中都会记进诊断表。
  CanonicalStatus.unknown: StatusSpec(
    status: CanonicalStatus.unknown,
    icon: '❔',
    tone: 'neutral',
    spinner: false,
    terminal: false,
    priority: 0,
    labelKey: 'statusUnknown',
    ariaKey: 'statusAriaUnknown',
  ),
};

const Set<CanonicalStatus> sessionStatuses = {
  CanonicalStatus.idle,
  CanonicalStatus.queued,
  CanonicalStatus.running,
  CanonicalStatus.waiting,
  CanonicalStatus.blocked,
  CanonicalStatus.error,
  CanonicalStatus.done,
  CanonicalStatus.cancelled,
  CanonicalStatus.offline,
  CanonicalStatus.unknown,
};

const Set<CanonicalStatus> taskStatuses = {
  CanonicalStatus.idle,
  CanonicalStatus.queued,
  CanonicalStatus.running,
  CanonicalStatus.waiting,
  CanonicalStatus.blocked,
  CanonicalStatus.error,
  CanonicalStatus.done,
  CanonicalStatus.cancelled,
  CanonicalStatus.archived,
  CanonicalStatus.unknown,
};

/// 历史 / 相邻词表的单点兼容映射。别在各页面自己写别名判断——那正是 `error`
/// 在会话卡上渲染成记事本图标的成因。
const Map<String, CanonicalStatus> statusAliases = {
  // → done
  'completed': CanonicalStatus.done,
  'complete': CanonicalStatus.done,
  'success': CanonicalStatus.done,
  'succeeded': CanonicalStatus.done,
  'finished': CanonicalStatus.done,
  // → running
  'thinking': CanonicalStatus.running,
  'editing': CanonicalStatus.running,
  'working': CanonicalStatus.running,
  'processing': CanonicalStatus.running,
  'starting': CanonicalStatus.running,
  'assessing': CanonicalStatus.running,
  'busy': CanonicalStatus.running,
  'active': CanonicalStatus.running,
  'claimed': CanonicalStatus.running,
  'resumed': CanonicalStatus.running,
  'started': CanonicalStatus.running,
  // → waiting
  'frozen': CanonicalStatus.waiting,
  'paused': CanonicalStatus.waiting,
  'pending': CanonicalStatus.waiting,
  // → error
  'failed': CanonicalStatus.error,
  'fail': CanonicalStatus.error,
  'errored': CanonicalStatus.error,
  // → cancelled：用户主动停掉的工作。服务端把它折叠进 runState 'idle'，展示层
  // 保留区分，避免被读成「已完成」或「还在跑」。
  'cancelled': CanonicalStatus.cancelled,
  'canceled': CanonicalStatus.cancelled,
  'aborted': CanonicalStatus.cancelled,
  'interrupted': CanonicalStatus.cancelled,
  // → idle：释放/跳过是调度记账，不是用户取消，也没有东西在跑。
  'skipped': CanonicalStatus.idle,
  'released': CanonicalStatus.idle,
  // → offline
  'stopped': CanonicalStatus.offline,
  'disconnected': CanonicalStatus.offline,
  'inactive': CanonicalStatus.offline,
  'gone': CanonicalStatus.offline,
};

/// freezeReason → 状态。逐键镜像 src/session-work-scheduler.js 的
/// FREEZE_REASON_RUN_STATE，只有一处展示层细化：configuration_required 判 blocked
/// 而非 waiting——服务端说得对（需要用户动手），但要动的是别处的配置而不是在本对
/// 话里回一句，所以给锁而不是暂停。
const Map<String, CanonicalStatus> freezeReasonStatus = {
  'awaiting_user_input': CanonicalStatus.waiting,
  'awaiting_callback': CanonicalStatus.waiting,
  'waiting': CanonicalStatus.waiting,
  'classify_waiting': CanonicalStatus.waiting,
  'classify_background': CanonicalStatus.waiting,
  'configuration_required': CanonicalStatus.blocked,
  'error': CanonicalStatus.error,
  'classification_error': CanonicalStatus.error,
  'unknown_interruption': CanonicalStatus.error,
  'legacy_unresolved': CanonicalStatus.error,
  'classify_error': CanonicalStatus.error,
  'delivery_recovery': CanonicalStatus.running,
  'continuation_ready': CanonicalStatus.running,
  'incomplete_requires_resume': CanonicalStatus.running,
  'classify_running': CanonicalStatus.running,
  'prelaunch_deferred': CanonicalStatus.queued,
};

/// classify 字母 → 状态。逐键镜像 src/classify/vocab.js CLASSIFY_DISPLAY 的
/// cardStatus，只有 E 例外：那里 cardStatus 是 waiting、barTint 是 error，而
/// 「异常必须带统一错误图标、不得继续转圈」要求读者一眼看出出错，故取 barTint。
/// C 已退役（parseClassifyResult 会把 C 折成 W），保留仅为渲染历史记录。
const Map<String, CanonicalStatus> classifyLetterStatus = {
  'D': CanonicalStatus.done,
  'C': CanonicalStatus.running,
  'W': CanonicalStatus.waiting,
  'B': CanonicalStatus.waiting,
  'E': CanonicalStatus.error,
  'P': CanonicalStatus.running,
};

/// classify 字母 → canonical 状态；认不出来记诊断并落 unknown。
CanonicalStatus classifyStatusOf(String? letter) {
  final key = (letter ?? '').trim().toUpperCase();
  final hit = classifyLetterStatus[key];
  if (hit != null) return hit;
  if (key.isNotEmpty) _recordUnknown(StatusDomain.session, 'classify:$key');
  return CanonicalStatus.unknown;
}

/// freezeReason → 状态，认不出来时退回 [fallback]（默认 waiting：冻结着的会话确
/// 实没在跑，但不能因为原因陌生就报成故障）。
CanonicalStatus freezeReasonStatusOf(
  String? reason, {
  CanonicalStatus fallback = CanonicalStatus.waiting,
}) {
  final key = _norm(reason);
  if (key.isEmpty) return fallback;
  final hit = freezeReasonStatus[key];
  if (hit != null) return hit;
  _recordUnknown(StatusDomain.session, 'freezeReason:$key');
  return fallback;
}

// ── 未知值诊断 ──────────────────────────────────────────────────────────────
const int _unknownLimit = 50;
final Map<String, int> _unknownSeen = <String, int>{};

Map<String, int> unknownStatusDiagnostics() => Map.unmodifiable(_unknownSeen);

void resetUnknownStatusDiagnostics() => _unknownSeen.clear();

void _recordUnknown(StatusDomain domain, String raw) {
  final key = '${domain.name}:$raw';
  if (_unknownSeen.containsKey(key)) {
    _unknownSeen[key] = _unknownSeen[key]! + 1;
    return;
  }
  if (_unknownSeen.length >= _unknownLimit) return;
  _unknownSeen[key] = 1;
  debugPrint('[multicc/status] unrecognised status: $key');
}

Set<CanonicalStatus> _allowed(StatusDomain domain) =>
    domain == StatusDomain.session ? sessionStatuses : taskStatuses;

String _norm(Object? value) => (value?.toString() ?? '').trim().toLowerCase();

/// 原始字符串 → canonical 状态。认不出来一律 unknown（并记诊断）。
CanonicalStatus coerceStatus(StatusDomain domain, Object? raw) {
  final key = _norm(raw);
  if (key.isEmpty) return CanonicalStatus.unknown;
  final allowed = _allowed(domain);
  for (final s in allowed) {
    if (s.name == key) return s;
  }
  final alias = statusAliases[key];
  if (alias != null && allowed.contains(alias)) return alias;
  _recordUnknown(domain, key);
  return CanonicalStatus.unknown;
}

/// 会话状态。[runState] 来自服务端 getRunState()，[freezeReason] 是枚举键而非自
/// 由文本，[active] 只用于在没有 runState 时区分「离线」与「未知」。
CanonicalStatus sessionStatusOf({
  String? runState,
  String? freezeReason,
  bool? active,
}) {
  if (_norm(runState).isEmpty) {
    return active == false ? CanonicalStatus.offline : CanonicalStatus.unknown;
  }
  final base = coerceStatus(StatusDomain.session, runState);
  // 唯一的 freezeReason 细化。只叠加在 waiting 之上，所以上一次冻结遗留的陈旧
  // reason 永远盖不掉当前的 running/done 判定。
  if (base == CanonicalStatus.waiting &&
      freezeReasonStatus[_norm(freezeReason)] == CanonicalStatus.blocked) {
    return CanonicalStatus.blocked;
  }
  return base;
}

/// 一张会话卡同时握着的所有信号折叠成一个状态（镜像 Web sessionCardStatus）。
///
/// 优先级 runState > workspaceStatus > monitorStatus，外加一条覆盖规则：任何一路
/// 信号说 error，卡片就是 error——故障不能被并行的乐观信号盖住，那正是出错会话
/// 被渲染成一个普通图标的成因。[active] 只是进程存活，仅在完全没有业务信号时用
/// 来区分 idle 与 offline：活着但没活干是 idle，不是 running。
CanonicalStatus sessionCardStatusOf({
  String? runState,
  String? workspaceStatus,
  String? monitorStatus,
  String? freezeReason,
  bool? active,
}) {
  final signals = <String?>[runState, workspaceStatus, monitorStatus]
      .where((v) => _norm(v).isNotEmpty)
      .map((v) => coerceStatus(StatusDomain.session, v))
      .toList();
  if (signals.contains(CanonicalStatus.error)) return CanonicalStatus.error;
  for (final decided in signals) {
    if (decided == CanonicalStatus.unknown) continue;
    if (decided == CanonicalStatus.waiting &&
        freezeReasonStatus[_norm(freezeReason)] == CanonicalStatus.blocked) {
      return CanonicalStatus.blocked;
    }
    return decided;
  }
  return active == false ? CanonicalStatus.offline : CanonicalStatus.idle;
}

/// 任务状态。归档/完成这类显式生命周期决定优先于派生的 runState；其余一律由
/// runState 决定，而 runState 内部以 error 领先，故障不会被「还在跑」埋掉。
CanonicalStatus taskStatusOf({String? status, String? runState}) {
  final lifecycle = _norm(status);
  if (lifecycle == 'archived') return CanonicalStatus.archived;
  if (lifecycle == 'done') return CanonicalStatus.done;
  if (_norm(runState).isEmpty) {
    return lifecycle == 'active' ? CanonicalStatus.idle : CanonicalStatus.unknown;
  }
  return coerceStatus(StatusDomain.task, runState);
}

/// 多信号并存时取优先级最高者。
CanonicalStatus highestPriority(StatusDomain domain, Iterable<Object?> raw) {
  final list = raw
      .map((s) => coerceStatus(domain, s))
      .where((s) => s != CanonicalStatus.unknown)
      .toList();
  if (list.isEmpty) return CanonicalStatus.unknown;
  return list.reduce(
    (a, b) => statusPresentation[b]!.priority > statusPresentation[a]!.priority
        ? b
        : a,
  );
}

StatusSpec statusSpecOf(StatusDomain domain, Object? status) =>
    statusPresentation[coerceStatus(domain, status)]!;

Color statusToneColor(String tone) {
  switch (tone) {
    case 'info':
      return AppColors.blue;
    case 'running':
      return AppColors.codex;
    case 'waiting':
      return AppColors.amber;
    case 'blocked':
      return const Color(0xFFd29922);
    case 'success':
      return AppColors.accent;
    case 'danger':
      return AppColors.danger;
    case 'muted':
      return AppColors.faint;
    case 'neutral':
    default:
      return AppColors.muted;
  }
}

// ── reason 脱敏 ─────────────────────────────────────────────────────────────
const int _reasonMax = 120;
final RegExp _reUrl = RegExp(r'[a-z][a-z0-9+.\-]*://\S+', caseSensitive: false);
final RegExp _rePosixPath = RegExp(r'(^|\s)~?/[^\s"' "'" r']+');
final RegExp _reWinPath = RegExp(r'(^|\s)[A-Za-z]:\\[^\s"' "'" r']+');
final RegExp _reToken = RegExp(r'\b[A-Za-z0-9_\-]{24,}\b');
final RegExp _reSpace = RegExp(r'\s+');

/// reason 可能出现在 tooltip 里，所以绝不能把 token、文件路径或 URL 带出服务端。
/// 已知枚举键原样透出（构造上就安全，由调用方本地化），其余一律脱敏并截断。
String sanitizeReason(Object? text) {
  final raw = (text?.toString() ?? '').trim();
  if (raw.isEmpty) return '';
  if (freezeReasonStatus.containsKey(raw)) return raw;
  var safe = raw
      .replaceAll(_reUrl, '…')
      .replaceAll(_rePosixPath, ' …')
      .replaceAll(_reWinPath, ' …')
      .replaceAll(_reToken, '…')
      .replaceAll(_reSpace, ' ')
      .trim();
  if (safe.length > _reasonMax) safe = '${safe.substring(0, _reasonMax - 1)}…';
  return safe;
}

/// 统一的状态徽章。图标恒在、无障碍名恒在；只有 running 会转圈。
class StatusBadge extends StatelessWidget {
  const StatusBadge({
    super.key,
    required this.domain,
    required this.status,
    this.reason,
    this.showLabel = true,
    this.fontSize = 9.5,
    this.dense = false,
  });

  final StatusDomain domain;
  final Object? status;
  final String? reason;
  final bool showLabel;
  final double fontSize;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final spec = statusSpecOf(domain, status);
    final safeReason = sanitizeReason(reason);
    final color = spec.color;
    final icon = spec.spinner
        ? _SpinningGlyph(glyph: spec.icon, fontSize: fontSize)
        : Text(spec.icon, style: TextStyle(fontSize: fontSize));

    final chip = Container(
      padding: dense
          ? const EdgeInsets.symmetric(horizontal: 4, vertical: 1)
          : const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        border: Border.all(color: color.withValues(alpha: 0.4)),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          icon,
          if (showLabel) ...[
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                spec.label,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: color,
                  fontSize: fontSize,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ],
      ),
    );

    final labelled = Semantics(
      label: safeReason.isEmpty
          ? spec.semanticLabel
          : '${spec.semanticLabel} · $safeReason',
      child: ExcludeSemantics(child: chip),
    );
    return safeReason.isEmpty
        ? labelled
        : Tooltip(message: '${spec.label} · $safeReason', child: labelled);
  }
}

class _SpinningGlyph extends StatefulWidget {
  const _SpinningGlyph({required this.glyph, required this.fontSize});

  final String glyph;
  final double fontSize;

  @override
  State<_SpinningGlyph> createState() => _SpinningGlyphState();
}

class _SpinningGlyphState extends State<_SpinningGlyph>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final glyph = Text(widget.glyph, style: TextStyle(fontSize: widget.fontSize));
    // 尊重系统「减弱动态效果」设置。
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) return glyph;
    return RotationTransition(turns: _controller, child: glyph);
  }
}
