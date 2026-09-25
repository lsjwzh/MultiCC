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
  background,
  blocked,
  error,
  succeeded,
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
///
/// [labelKey] 是这个状态的通用词（会话列表、任务板）。
/// [ariaKey] 是无障碍名，永远用文字讲清状态。
/// [airLabelKey] 是 **Air 面** 用的那个词（侧栏任务行、控制台、任务详情）。Air 跟
///   它旁边印着的工作区租约 / 工作流阶段词是同一套词，所以单独占一列，而不是每个
///   Air 界面各留一张手抄表 —— 那正是「等待回答」被贴到后台等待上的成因。
///   Web 侧同一列由 `public/status-presentation.js` 的 `airStatusLabels()` 出，
///   `air.js` 的 `stateNames` 和控制台的 `STATUS_COPY` 都从它构建。
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
    required this.airLabelKey,
  });

  final CanonicalStatus status;
  final String icon;
  final String tone;
  final bool spinner;
  final bool terminal;
  final int priority;
  final String labelKey;
  final String ariaKey;
  final String airLabelKey;

  String get label => t(labelKey);

  /// 无障碍名：始终用文字讲清状态，不靠颜色传达（对应 WCAG 1.4.1）。
  String get semanticLabel => t(ariaKey);

  /// Air 面上的词。Air 面任何地方都不许再手写第二份状态词表。
  String get airLabel => t(airLabelKey);

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
    airLabelKey: 'airStateIdle',
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
    airLabelKey: 'airStateQueued',
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
    airLabelKey: 'airStateRunning',
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
    airLabelKey: 'airStateWaiting',
  ),
  // 在等后台任务（classify 字母 B）：回调或派出去的 worker 还在外面跑。它 **不是**
  // waiting —— 没有任何东西要用户回答，所以不能借用「该你了」那个词，也不该拿到那
  // 份注意力。优先级排在 waiting 之下（真有人等你回答永远更急）、succeeded 之上；
  // 故障（error/blocked）稳压它，后台等待永远不盖住故障。
  CanonicalStatus.background: StatusSpec(
    status: CanonicalStatus.background,
    icon: '⏳',
    tone: 'info',
    spinner: false,
    terminal: false,
    priority: 45,
    labelKey: 'statusBackground',
    ariaKey: 'statusAriaBackground',
    airLabelKey: 'airStateBackground',
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
    airLabelKey: 'airStateBlocked',
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
    airLabelKey: 'airStateFailed',
  ),
  CanonicalStatus.succeeded: StatusSpec(
    status: CanonicalStatus.succeeded,
    icon: '✅',
    tone: 'success',
    spinner: false,
    terminal: true,
    priority: 30,
    labelKey: 'statusSucceeded',
    ariaKey: 'statusAriaSucceeded',
    airLabelKey: 'airStateSucceeded',
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
    airLabelKey: 'airStateDone',
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
    airLabelKey: 'airStateCancelled',
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
    airLabelKey: 'airStateArchived',
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
    airLabelKey: 'airStateOffline',
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
    airLabelKey: 'airStateUnknown',
  ),
};

const Set<CanonicalStatus> sessionStatuses = {
  CanonicalStatus.idle,
  CanonicalStatus.queued,
  CanonicalStatus.running,
  CanonicalStatus.waiting,
  CanonicalStatus.background,
  CanonicalStatus.blocked,
  CanonicalStatus.error,
  CanonicalStatus.succeeded,
  CanonicalStatus.cancelled,
  CanonicalStatus.offline,
  CanonicalStatus.unknown,
};

const Set<CanonicalStatus> taskStatuses = {
  CanonicalStatus.idle,
  CanonicalStatus.queued,
  CanonicalStatus.running,
  CanonicalStatus.waiting,
  CanonicalStatus.background,
  CanonicalStatus.blocked,
  CanonicalStatus.error,
  CanonicalStatus.succeeded,
  CanonicalStatus.done,
  CanonicalStatus.cancelled,
  CanonicalStatus.archived,
  CanonicalStatus.unknown,
};

/// 历史 / 相邻词表的单点兼容映射。别在各页面自己写别名判断——那正是 `error`
/// 在会话卡上渲染成记事本图标的成因。
const Map<String, CanonicalStatus> statusAliases = {
  // → succeeded（turn outcome；不能解释成 TaskBoard lifecycle done）
  'completed': CanonicalStatus.succeeded,
  'complete': CanonicalStatus.succeeded,
  'done': CanonicalStatus.succeeded,
  'success': CanonicalStatus.succeeded,
  'succeeded': CanonicalStatus.succeeded,
  'finished': CanonicalStatus.succeeded,
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
///
/// awaiting_callback / classify_background 是 B（等后台任务）：回调在别人手里，
/// 不是在等你回答，落 background。
const Map<String, CanonicalStatus> freezeReasonStatus = {
  'awaiting_user_input': CanonicalStatus.waiting,
  'awaiting_callback': CanonicalStatus.background,
  'waiting': CanonicalStatus.waiting,
  'classify_waiting': CanonicalStatus.waiting,
  'classify_background': CanonicalStatus.background,
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
/// cardStatus（E 也在内：它的 cardStatus 就是 error —— API 异常是用户必须一眼看出
/// 的故障）。W 和 B 是两个不同的状态：W 等你回答，B 在等后台任务，把它们并成一个
/// 正是「一条根本不需要人回答的卡上写着『等待回答』」的成因。
/// C 已退役（parseClassifyResult 会把 C 折成 W），保留仅为渲染历史记录。
const Map<String, CanonicalStatus> classifyLetterStatus = {
  'D': CanonicalStatus.succeeded,
  'C': CanonicalStatus.running,
  'W': CanonicalStatus.waiting,
  'B': CanonicalStatus.background,
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

/// 归一化输入。除了服务端来的原始串，也接受已经 canonical 的枚举本身：
/// `CanonicalStatus.running.toString()` 是 `'CanonicalStatus.running'`，不拆开
/// 的话 `coerceStatus(domain, CanonicalStatus.running)` 会一路落到 unknown ——
/// 手里已经拿着权威状态的调用点反而渲染成「状态未知」。
String _norm(Object? value) {
  if (value is CanonicalStatus) return value.name;
  return (value?.toString() ?? '').trim().toLowerCase();
}

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

/// 任务状态。归档/完成这类显式生命周期决定优先于派生的 runState；执行成功只
/// 是 turn outcome，不能把 active 任务自动变成 done。
CanonicalStatus taskStatusOf({String? status, String? runState}) {
  final lifecycle = _norm(status);
  if (lifecycle == 'archived') return CanonicalStatus.archived;
  if (lifecycle == 'done') return CanonicalStatus.done;
  if (_norm(runState).isEmpty) {
    return lifecycle == 'active' ? CanonicalStatus.idle : CanonicalStatus.unknown;
  }
  if (<String>{'done', 'completed'}.contains(_norm(runState))) {
    return CanonicalStatus.succeeded;
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

// ── Air 词表：一份，给所有 Air 界面 ─────────────────────────────────────────
//
// Air（侧栏任务行、控制台、任务详情）说的是自己那套词 —— 跟它旁边印着的工作区
// 租约 / 工作流阶段词同源。这份词表的唯一来源是每个 spec 的 [StatusSpec.airLabelKey]
// 列（Web 侧同一列由 public/status-presentation.js 的 `airStatusLabels()` 出，
// air.js 的 stateNames 和控制台的 STATUS_COPY 都从它构建）。从前
// air_service.dart 的 airStateNames、air_task_status.dart 的 airStatusCopy 和
// air_task_details.dart 里那几处硬编码各写了一份，于是同一条任务在侧栏和控制台能
// 读出两个词 —— 后台等待借走「等待回答」也是这么来的。

/// 一个 canonical 状态在 Air 面上的词。
String airStatusWord(CanonicalStatus status) => statusPresentation[status]!.airLabel;

/// 全部 canonical 状态 → Air 词（整表，给 airLabel 那类按原始串取词的调用点）。
Map<CanonicalStatus, String> airStatusWords() => {
  for (final status in CanonicalStatus.values) status: airStatusWord(status),
};

/// 运行标记的颜色：和 Web 的 status-presentation.js `RING_TINTS` 是同一份，顺序也
/// 必须一样 —— 颜色按 id 哈希取，同一个 id 在两端要落到同一个色。
/// tests/test-status-presentation.js 逐项比对这两张表。
///
/// 为什么是静态的：一个「一直在动」的标记会让整屏永远出帧，而这台机器上 Web 端
/// 实测过 —— 关掉图形加速后屏幕上一个永续动画就能吃掉一个核。谁在跑这件事由描边、
/// 图标、色和文字一起说，不需要它动。
const List<int> ringTints = [
  0xFF7FB0FF,
  0xFFF7B98A,
  0xFF86CDF0,
  0xFFC2A8FF,
  0xFFA8D47E,
  0xFFF2A3BF,
  0xFF7FD3C2,
  0xFFF0C66A,
];

/// 同一件东西每次都挑到同一档；彼此之间看起来是随机的。用 id 而不是随机数：列表
/// 每次重画都换色会看着像在闪。哈希算法与 Web 的 ringTint 逐位一致（UTF-16 code
/// unit × 31，取 32 位无符号）。
Color ringTintFor(String? seed) {
  final text = seed ?? '';
  var hash = 0;
  for (var i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.codeUnitAt(i)) & 0xFFFFFFFF;
  }
  return Color(ringTints[hash % ringTints.length]);
}

Color statusToneColor(String tone) {
  switch (tone) {
    case 'info':
      return AppColors.blue;
    case 'running':
      return AppColors.codex;
    case 'waiting':
      return AppColors.amber;
    case 'blocked':
      return const Color(0xFFa85a25);
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

/// 统一的状态徽章。图标恒在、无障碍名恒在；只有 running 会戴那圈静态光晕。
class StatusBadge extends StatelessWidget {
  const StatusBadge({
    super.key,
    required this.domain,
    required this.status,
    this.reason,
    this.showLabel = true,
    this.fontSize = 9.5,
    this.dense = false,
    this.label,
    this.semanticLabel,
  });

  final StatusDomain domain;
  final Object? status;
  final String? reason;
  final bool showLabel;
  final double fontSize;
  final bool dense;

  /// 换掉注册表里那个词。Air 面自带一份中文（同 Web `air-admin.js` 的
  /// `STATUS_COPY`），可见文案和读屏念的必须是同一个词 —— 屏幕上写「执行中」、
  /// 读屏念「进行中」会让「它说的哪个状态」变成要猜的事。
  final String? label;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final spec = statusSpecOf(domain, status);
    final word = label ?? spec.label;
    final accessible = semanticLabel ?? spec.semanticLabel;
    final safeReason = sanitizeReason(reason);
    final color = spec.color;
    final icon = spec.spinner
        ? _RunningGlyph(glyph: spec.icon, fontSize: fontSize, color: color)
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
                word,
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
          ? accessible
          : '$accessible · $safeReason',
      child: ExcludeSemantics(child: chip),
    );
    return safeReason.isEmpty
        ? labelled
        : Tooltip(message: '$word · $safeReason', child: labelled);
  }
}

/// 运行标记：图标外面一圈**静态**的光晕，不再旋转。对应 Web 的
/// `.mc-status.st-spin .mc-status-ico`（那边也是同一个静态光晕）。
///
/// 谁在跑这件事由图标、色调、文案和（列表上的）静态描边一起说，不靠「一直在动」：
/// 屏幕上有东西永远在动，合成器就永远不归零，Web 端实测关掉图形加速时这类动画能
/// 吃掉一个核。系统「减弱动态效果」下连这圈光晕也去掉，只留图标。
class _RunningGlyph extends StatelessWidget {
  const _RunningGlyph({
    required this.glyph,
    required this.fontSize,
    required this.color,
  });

  final String glyph;
  final double fontSize;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final text = Text(glyph, style: TextStyle(fontSize: fontSize));
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) return text;
    return Container(
      padding: const EdgeInsets.all(1.5),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: color.withValues(alpha: 0.3), width: 1.5),
      ),
      child: text,
    );
  }
}
