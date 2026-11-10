import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../i18n.dart';
import '../models/unattended_state.dart';
import '../providers/chat_provider.dart';
import '../services/goal_precheck.dart';
import '../theme.dart';

/// 无人值守在聊天页的两种入口：常驻悬浮球（状态一眼可见）+ 点开后的大面板。
/// 契约见 docs/unattended-mode.md；HTTP 与 WS 都经 [ChatProvider]。

class _StatusStyle {
  final Color color;
  final Color background;
  final IconData icon;
  final String labelKey;

  const _StatusStyle({
    required this.color,
    required this.background,
    required this.icon,
    required this.labelKey,
  });
}

_StatusStyle _statusStyle(String? status) {
  switch (status) {
    case UnattendedState.statusActive:
      return const _StatusStyle(
        color: AppColors.success,
        background: Color(0xFFedf8f1),
        icon: Icons.autorenew_rounded,
        labelKey: 'unattendedStatusActive',
      );
    case UnattendedState.statusAchieved:
      return const _StatusStyle(
        color: AppColors.success,
        background: Color(0xFFedf8f1),
        icon: Icons.check_circle_rounded,
        labelKey: 'unattendedStatusAchieved',
      );
    case UnattendedState.statusNeedsHuman:
      return const _StatusStyle(
        color: AppColors.amber,
        background: Color(0xFFfff8eb),
        icon: Icons.front_hand_rounded,
        labelKey: 'unattendedStatusNeedsHuman',
      );
    case UnattendedState.statusExhausted:
      return const _StatusStyle(
        color: AppColors.warning,
        background: Color(0xFFfff4ea),
        icon: Icons.hourglass_bottom_rounded,
        labelKey: 'unattendedStatusExhausted',
      );
    case UnattendedState.statusError:
      return const _StatusStyle(
        color: AppColors.danger,
        background: AppColors.dangerSoft,
        icon: Icons.error_outline_rounded,
        labelKey: 'unattendedStatusError',
      );
    case UnattendedState.statusStopped:
      return const _StatusStyle(
        color: AppColors.faint,
        background: Color(0xFFeef3f8),
        icon: Icons.pause_rounded,
        labelKey: 'unattendedStatusStopped',
      );
    default:
      return const _StatusStyle(
        color: AppColors.faint,
        background: Color(0xFFeef3f8),
        icon: Icons.smart_toy_outlined,
        labelKey: 'unattendedNotStarted',
      );
  }
}

/// 剩余值守时间的紧凑文案：1小时20分 / 45分 / <1分 / 已超时。
String unattendedRemainingText(Duration remaining) {
  if (remaining.inSeconds <= 0) return t('unattendedRemainingOver');
  if (remaining.inSeconds < 60) return t('unattendedRemainingUnderMinute');
  final minutes = remaining.inMinutes;
  if (minutes < 60) {
    return t('unattendedRemainingMinutes', {'minutes': '$minutes'});
  }
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  return rest == 0
      ? t('unattendedRemainingHours', {'hours': '$hours'})
      : t('unattendedRemainingHoursMinutes', {
          'hours': '$hours',
          'minutes': '$rest',
        });
}

/// active 且服务端给了 deadlineAt 才有「剩余」；其余状态返回 null（不画徽标）。
String? unattendedRemainingLabel(UnattendedState? state, int nowMs) {
  if (state == null || !state.isActive) return null;
  final remaining = state.remaining(nowMs);
  return remaining == null ? null : unattendedRemainingText(remaining);
}

/// 判断标准为空，或短到没有约束力（如「完成」「ok」）都算不够可验证。
bool unattendedCriteriaInsufficient(List<String> criteria) {
  if (criteria.isEmpty) return true;
  return criteria.any((line) => line.trim().length < 4);
}

/// 服务端预检回包是否满足「直接启动」：判定 ok、没有 issues/questions，
/// 且用户已经写了不空洞的判断标准。其余情况一律先给用户看推荐卡。
bool unattendedPrecheckPasses(
  Map<String, dynamic> data,
  List<String> criteria,
) {
  if (data['ok'] != true) return false;
  if ('${data['verdict'] ?? ''}' != 'ok') return false;
  if (goalPrecheckStringList(data['issues']).isNotEmpty) return false;
  if (goalPrecheckStringList(data['questions']).isNotEmpty) return false;
  return !unattendedCriteriaInsufficient(criteria);
}

/// 剩余时间每 30 秒刷新一次：只在 active 时挂一个 periodic timer，失活和
/// dispose 时都取消。横幅、悬浮球、面板各持一个（生命周期与各自 widget 绑定）。
mixin UnattendedRemainingTicker<T extends StatefulWidget> on State<T> {
  int get unattendedNowMs;

  Timer? _remainingTimer;

  void syncUnattendedRemainingTicker({required bool active}) {
    if (active) {
      _remainingTimer ??= Timer.periodic(const Duration(seconds: 30), (_) {
        if (mounted) setState(() {});
      });
    } else {
      _remainingTimer?.cancel();
      _remainingTimer = null;
    }
  }

  @override
  void dispose() {
    _remainingTimer?.cancel();
    _remainingTimer = null;
    super.dispose();
  }
}

/// 聊天页常驻的无人值守悬浮球。状态配色见契约：idle 灰、active 绿（呼吸）、
/// needs_human 琥珀、achieved 勾、stopped/exhausted/error 灰红。
class UnattendedFab extends StatefulWidget {
  const UnattendedFab({
    super.key,
    required this.state,
    required this.onTap,
    this.now,
  });

  final UnattendedState? state;
  final VoidCallback onTap;

  /// 测试注入的时钟（毫秒）；生产走 [DateTime.now]。
  final int Function()? now;

  @override
  State<UnattendedFab> createState() => _UnattendedFabState();
}

class _UnattendedFabState extends State<UnattendedFab>
    with
        SingleTickerProviderStateMixin,
        UnattendedRemainingTicker<UnattendedFab> {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  @override
  int get unattendedNowMs =>
      widget.now?.call() ?? DateTime.now().millisecondsSinceEpoch;

  @override
  void initState() {
    super.initState();
    _syncPulse();
    syncUnattendedRemainingTicker(active: widget.state?.isActive == true);
  }

  @override
  void didUpdateWidget(covariant UnattendedFab oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncPulse();
    syncUnattendedRemainingTicker(active: widget.state?.isActive == true);
  }

  void _syncPulse() {
    final active = widget.state?.isActive == true;
    if (active && !_pulse.isAnimating) {
      _pulse.repeat(reverse: true);
    } else if (!active && _pulse.isAnimating) {
      _pulse.stop();
      _pulse.value = 1;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final style = _statusStyle(state?.status);
    final remaining = unattendedRemainingLabel(state, unattendedNowMs);
    final tooltip = state == null
        ? t('unattendedFabTooltip')
        : '${t('unattended')} · ${t(style.labelKey)}';
    return Tooltip(
      message: tooltip,
      child: GestureDetector(
        key: const ValueKey('unattended-fab'),
        onTap: widget.onTap,
        child: AnimatedBuilder(
          animation: _pulse,
          builder: (context, child) => Opacity(
            opacity: widget.state?.isActive == true
                ? 0.55 + 0.45 * _pulse.value
                : 1,
            child: child,
          ),
          child: Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: style.color,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.14),
                  blurRadius: 8,
                  offset: const Offset(0, 3),
                ),
              ],
            ),
            child: Stack(
              alignment: Alignment.center,
              children: [
                // 判定中（v2）：verdict 开始到落地之间转圈，图标暂时让位。
                if (state?.evaluating == true)
                  const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                    ),
                  )
                else
                  Icon(style.icon, color: Colors.white, size: 22),
                // 「第 x/y 轮」已退场：只在 active 且有截止时间时显示剩余。
                if (remaining != null)
                  Positioned(
                    right: 2,
                    bottom: 1,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 3,
                        vertical: 0.5,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        remaining,
                        key: const ValueKey('unattended-fab-remaining'),
                        style: TextStyle(
                          color: style.color,
                          fontSize: 8,
                          fontWeight: FontWeight.w700,
                        ),
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

/// 面板底部按钮组该出哪一套。拆成纯函数是为了能在不构造整个 ChatProvider 的
/// 情况下钉住契约：只有 active 能 stop/update，needs_human/exhausted/stopped/
/// error 能 resume，从未启用或已达成重新 start。
enum UnattendedSheetActionMode { start, active, resume }

/// `pausedBy`（v2）→ 用户可读的暂停原因；没有（含老服务端）时返回 null。
String? unattendedPausedByLabel(String? pausedBy) => switch (pausedBy) {
  UnattendedState.pausedByUser => t('unattendedPausedByUser'),
  UnattendedState.pausedByInput => t('unattendedPausedByInput'),
  UnattendedState.pausedByCancel => t('unattendedPausedByCancel'),
  _ => null,
};

/// 输入框上方 banner 的「为什么停在这里」：需要人工时优先给 humanReason，
/// 其余看 pausedBy（Web 的 bannerReasonText 同一规则）。
String unattendedBannerReason(UnattendedState state) {
  if (state.needsHuman) {
    final reason = state.lastVerdict?.humanReason.trim() ?? '';
    final fallback = state.lastVerdict?.reason.trim() ?? '';
    final text = reason.isNotEmpty ? reason : fallback;
    return text.isEmpty
        ? t('unattendedStatusNeedsHuman')
        : t('unattendedHumanReason', {'reason': text});
  }
  return unattendedPausedByLabel(state.pausedBy) ?? '';
}

/// 聊天输入框正上方的无人值守条（v2 产品决定）：`active` 时说明输入为什么被锁，
/// 主按钮是「暂停并接管」；stopped / needs_human / exhausted / error 时给小号的
/// 「继续无人值守」+ 暂停原因。achieved 与从未启用不占位置。
class UnattendedComposerBanner extends StatefulWidget {
  const UnattendedComposerBanner({super.key, required this.provider, this.now});

  final ChatProvider provider;

  /// 测试注入的时钟（毫秒）；生产走 [DateTime.now]。
  final int Function()? now;

  @override
  State<UnattendedComposerBanner> createState() =>
      _UnattendedComposerBannerState();
}

class _UnattendedComposerBannerState extends State<UnattendedComposerBanner>
    with UnattendedRemainingTicker<UnattendedComposerBanner> {
  @override
  int get unattendedNowMs =>
      widget.now?.call() ?? DateTime.now().millisecondsSinceEpoch;

  @override
  Widget build(BuildContext context) {
    final provider = widget.provider;
    final state = provider.unattended;
    // 只在 active 时挂 30 秒刷新；失活/销毁由 mixin 取消。
    syncUnattendedRemainingTicker(active: state?.isActive == true);
    if (state == null) return const SizedBox.shrink();
    final active = state.isActive;
    final resumable =
        state.needsHuman || state.isExhausted || state.isStopped || state.isError;
    if (!active && !resumable) return const SizedBox.shrink();
    final style = _statusStyle(state.status);
    final busy = provider.unattendedBusy;
    final evaluating = state.evaluating;
    final remaining = unattendedRemainingLabel(state, unattendedNowMs);
    final main = active
        ? (remaining != null
                  ? t('unattendedBannerActive', {'remaining': remaining})
                  : t('unattendedStatusActive')) +
              (evaluating ? ' · ${t('unattendedJudging')}' : '')
        : t(style.labelKey);
    final reason = active ? '' : unattendedBannerReason(state);
    final leading = active && evaluating
        ? SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              valueColor: AlwaysStoppedAnimation<Color>(style.color),
            ),
          )
        : Icon(
            active ? Icons.smart_toy_rounded : style.icon,
            size: active ? 15 : 14,
            color: style.color,
          );
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Container(
        key: const ValueKey('unattended-banner'),
        width: double.infinity,
        padding: EdgeInsets.fromLTRB(10, active ? 6 : 3, 6, active ? 6 : 3),
        decoration: BoxDecoration(
          color: style.background,
          border: Border.all(color: style.color.withValues(alpha: 0.35)),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          children: [
            leading,
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                main,
                key: const ValueKey('unattended-banner-text'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: style.color,
                  fontSize: active ? 12.5 : 11.5,
                  fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
            ),
            if (reason.isNotEmpty)
              Flexible(
                child: Text(
                  reason,
                  key: const ValueKey('unattended-banner-reason'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 11.5,
                  ),
                ),
              ),
            TextButton(
              key: ValueKey(
                active ? 'unattended-pause' : 'unattended-resume-banner',
              ),
              onPressed: busy
                  ? null
                  : active
                  ? provider.stopUnattended
                  : provider.resumeUnattended,
              style: TextButton.styleFrom(
                foregroundColor: active
                    ? AppColors.danger
                    : AppColors.accentDark,
                visualDensity: VisualDensity.compact,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 30),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              child: Text(
                active
                    ? t('unattendedPauseTakeover')
                    : t('unattendedBannerResume'),
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

UnattendedSheetActionMode unattendedSheetActionMode(UnattendedState? state) {
  if (state?.isActive == true) return UnattendedSheetActionMode.active;
  if (state?.canResume == true) return UnattendedSheetActionMode.resume;
  return UnattendedSheetActionMode.start;
}

Future<void> showUnattendedSheet(
  BuildContext context, {
  required ChatProvider provider,
  http.Client? httpClient,
  int Function()? now,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) =>
        _UnattendedSheet(provider: provider, httpClient: httpClient, now: now),
  );
}

class _UnattendedSheet extends StatefulWidget {
  const _UnattendedSheet({required this.provider, this.httpClient, this.now});

  final ChatProvider provider;

  /// 预检请求走它（测试桩），生产为 null。
  final http.Client? httpClient;

  /// 测试注入的时钟（毫秒）；生产走 [DateTime.now]。
  final int Function()? now;

  @override
  State<_UnattendedSheet> createState() => _UnattendedSheetState();
}

enum _DurationUnit { minutes, hours }

class _UnattendedSheetState extends State<_UnattendedSheet>
    with UnattendedRemainingTicker<_UnattendedSheet> {
  late final TextEditingController _goalCtrl;
  late final TextEditingController _durationCtrl;
  final List<TextEditingController> _criteria = [];
  final TextEditingController _recGoalCtrl = TextEditingController();
  final TextEditingController _recCriteriaCtrl = TextEditingController();
  GoalPrecheckConfig _precheckConfig = const GoalPrecheckConfig();
  _DurationUnit _durationUnit = _DurationUnit.hours;
  bool _checking = false;

  /// 预检结果卡：建议（result）或不可用（unavailable），两种都只在用户确认后才启动。
  bool _precheckResult = false;
  bool _precheckUnavailable = false;

  /// 这次预检是不是「点启动」触发的 —— 决定卡片按钮是「采用并启动」还是「采用建议」。
  bool _precheckFromStart = false;
  String _precheckHeadline = '';
  List<String> _precheckIssues = const [];
  String _precheckErrorMessage = '';
  String _localError = '';

  @override
  int get unattendedNowMs =>
      widget.now?.call() ?? DateTime.now().millisecondsSinceEpoch;

  UnattendedState? get _state => widget.provider.unattended;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.provider.clearUnattendedError();
    });
    final state = widget.provider.unattended;
    _goalCtrl = TextEditingController(text: state?.goal ?? '');
    final minutes =
        state?.maxDurationMinutes ??
        widget.provider.unattendedLimits.maxDurationMinutesDefault;
    // 默认 2 小时：整小时用「小时」显示，否则原样用分钟。
    if (minutes >= 60 && minutes % 60 == 0) {
      _durationUnit = _DurationUnit.hours;
      _durationCtrl = TextEditingController(text: '${minutes ~/ 60}');
    } else {
      _durationUnit = _DurationUnit.minutes;
      _durationCtrl = TextEditingController(text: '$minutes');
    }
    for (final line in state?.criteria ?? const <String>[]) {
      _criteria.add(TextEditingController(text: line));
    }
    if (_criteria.isEmpty) _criteria.add(TextEditingController());
    unawaited(
      GoalPrecheckConfig.load(
        settings: widget.provider.settings,
        httpClient: widget.httpClient,
      ).then((config) {
        if (mounted) setState(() => _precheckConfig = config);
      }),
    );
  }

  @override
  void dispose() {
    _goalCtrl.dispose();
    _durationCtrl.dispose();
    _recGoalCtrl.dispose();
    _recCriteriaCtrl.dispose();
    for (final controller in _criteria) {
      controller.dispose();
    }
    super.dispose();
  }

  List<String> _readCriteria() => [
    for (final controller in _criteria)
      if (controller.text.trim().isNotEmpty)
        controller.text.trim().length > UnattendedState.maxCriterionLength
            ? controller.text.trim().substring(
                0,
                UnattendedState.maxCriterionLength,
              )
            : controller.text.trim(),
  ];

  /// 最长值守时间：小时单位先换成分钟，再按服务端 limits 收口（默认 120）。
  int _readMaxDurationMinutes() {
    final limits = widget.provider.unattendedLimits;
    final parsed = int.tryParse(_durationCtrl.text.trim());
    if (parsed == null) return limits.maxDurationMinutesDefault;
    final minutes = _durationUnit == _DurationUnit.hours ? parsed * 60 : parsed;
    return limits.clampDurationMinutes(
      minutes <= 0 ? limits.maxDurationMinutesMin : minutes,
    );
  }

  /// 切换分钟/小时时尽量保持时长不变（分钟→小时向上取整，至少 1 小时）。
  void _setDurationUnit(_DurationUnit unit) {
    if (_durationUnit == unit) return;
    final current = int.tryParse(_durationCtrl.text.trim());
    int? next = current;
    if (current != null) {
      if (_durationUnit == _DurationUnit.hours &&
          unit == _DurationUnit.minutes) {
        next = current * 60;
      } else if (_durationUnit == _DurationUnit.minutes &&
          unit == _DurationUnit.hours) {
        next = (current / 60).ceil();
      }
    }
    setState(() {
      _durationUnit = unit;
      if (next != null) _durationCtrl.text = '$next';
    });
  }

  /// 预检拿「目标 + 当前判断标准」一起送：只发目标会让模型看不到用户已经
  /// 写下的验收条件，推荐标准容易重复或跑偏。
  String _precheckTask() {
    final goal = _goalCtrl.text.trim();
    final criteria = _readCriteria();
    if (criteria.isEmpty) return goal;
    return '$goal\n\n判断标准：\n${criteria.map((line) => '- $line').join('\n')}';
  }

  Future<Map<String, dynamic>> _runPrecheck() async {
    final data = await requestGoalPrecheck(
      settings: widget.provider.settings,
      task: _precheckTask(),
      dimensions: _precheckConfig.dimensions,
      httpClient: widget.httpClient,
      precheckWaitMs: _precheckConfig.precheckWaitMs,
    );
    return data;
  }

  /// 把预检结果落成建议卡；[fromStart] 决定按钮组。
  void _applyPrecheckResult(
    Map<String, dynamic> data, {
    required bool fromStart,
  }) {
    final issues = [
      ...goalPrecheckStringList(data['issues']),
      ...goalPrecheckStringList(data['questions']),
    ];
    final suggested = goalPrecheckStringList(
      data['criteria'],
    ).take(UnattendedState.maxCriteria).toList();
    final revised = (data['revised'] as String?)?.trim() ?? '';
    final verdictOk = '${data['verdict'] ?? ''}' == 'ok';
    _precheckFromStart = fromStart;
    _precheckResult = true;
    _precheckUnavailable = false;
    _precheckIssues = issues;
    _precheckHeadline = verdictOk && issues.isEmpty
        ? t('unattendedPrecheckMissingCriteria')
        : t('unattendedPrecheckUnclearGoal');
    _recGoalCtrl.text = revised.isNotEmpty ? revised : _goalCtrl.text.trim();
    _recCriteriaCtrl.text = (suggested.isNotEmpty
            ? suggested
            : _readCriteria())
        .join('\n');
  }

  void _dismissPrecheck() {
    setState(() {
      _precheckResult = false;
      _precheckUnavailable = false;
      _precheckFromStart = false;
      _precheckIssues = const [];
    });
  }

  /// 「AI 补全判断标准」：手动预检，只展示建议卡，不启动。
  Future<void> _draftCriteria() async {
    if (_checking) return;
    final goal = _goalCtrl.text.trim();
    if (goal.isEmpty) {
      setState(() => _localError = t('unattendedGoalRequired'));
      return;
    }
    setState(() {
      _checking = true;
      _localError = '';
      _precheckResult = false;
      _precheckUnavailable = false;
      _precheckIssues = const [];
    });
    final data = await _runPrecheck();
    if (!mounted) return;
    setState(() {
      _checking = false;
      if (data['ok'] == true) {
        _applyPrecheckResult(data, fromStart: false);
      } else {
        _precheckUnavailable = true;
        _precheckFromStart = false;
        _precheckErrorMessage = '${data['error'] ?? t('unknownError')}';
      }
    });
  }

  /// 点「启动」：先自动预检，再按结果决定直接启动 / 给建议卡 / 给不可用提示。
  Future<void> _startFromTap() async {
    if (_checking || widget.provider.unattendedBusy) return;
    final goal = _goalCtrl.text.trim();
    if (goal.isEmpty) {
      setState(() => _localError = t('unattendedGoalRequired'));
      return;
    }
    final criteria = _readCriteria();
    setState(() {
      _checking = true;
      _localError = '';
      _precheckResult = false;
      _precheckUnavailable = false;
      _precheckIssues = const [];
    });
    final data = await _runPrecheck();
    if (!mounted) return;
    setState(() {
      _checking = false;
      if (data['ok'] != true) {
        _precheckFromStart = true;
        _precheckUnavailable = true;
        _precheckErrorMessage = '${data['error'] ?? t('unknownError')}';
        return;
      }
      if (unattendedPrecheckPasses(data, criteria)) {
        // (a) 判定 ok、无提醒、标准齐备：不打扰，直接启动。
        unawaited(_performStart(goal: goal, criteria: criteria));
        return;
      }
      // (b) 目标不清 / 标准缺失或过于空洞：先给建议卡，绝不静默启动。
      _applyPrecheckResult(data, fromStart: true);
    });
  }

  Future<void> _performStart({
    String? goal,
    List<String>? criteria,
    bool resume = false,
  }) async {
    final provider = widget.provider;
    final ok = resume
        ? await provider.resumeUnattended(
            maxDurationMinutes: _readMaxDurationMinutes(),
          )
        : await provider.startUnattended(
            goal: goal ?? _goalCtrl.text,
            criteria: criteria ?? _readCriteria(),
            maxDurationMinutes: _readMaxDurationMinutes(),
          );
    if (!mounted) return;
    if (!ok) return;
    setState(() {
      _precheckResult = false;
      _precheckUnavailable = false;
      _precheckFromStart = false;
      _precheckIssues = const [];
    });
    _snack(t('unattendedStarted'));
  }

  /// 把建议卡里的目标/标准写回主表单（可能被用户编辑过）。
  void _adoptRecommendation() {
    final goal = _recGoalCtrl.text.trim();
    if (goal.isNotEmpty) _goalCtrl.text = goal;
    final lines = _recCriteriaCtrl.text
        .split('\n')
        .map((line) => line.trim())
        .where((line) => line.isNotEmpty)
        .take(UnattendedState.maxCriteria)
        .toList();
    if (lines.isNotEmpty) {
      for (final controller in _criteria) {
        controller.dispose();
      }
      _criteria
        ..clear()
        ..addAll(lines.map((line) => TextEditingController(text: line)));
    }
    setState(() {
      _precheckResult = false;
      _precheckFromStart = false;
      _precheckIssues = const [];
    });
  }

  Future<void> _adoptAndStart() async {
    _adoptRecommendation();
    await _performStart(goal: _goalCtrl.text, criteria: _readCriteria());
  }

  /// 预检不可用时点「仍然启动」：用户已经看见提示，按原样启动。
  Future<void> _startAnyway() async {
    _dismissPrecheck();
    await _performStart(goal: _goalCtrl.text, criteria: _readCriteria());
  }

  void _addCriterion() {
    if (_criteria.length >= UnattendedState.maxCriteria) return;
    setState(() => _criteria.add(TextEditingController()));
  }

  void _removeCriterion(int index) {
    if (_criteria.length <= 1) return;
    setState(() {
      _criteria.removeAt(index).dispose();
    });
  }

  Future<void> _save() async {
    final ok = await widget.provider.updateUnattended(
      goal: _goalCtrl.text,
      criteria: _readCriteria(),
      maxDurationMinutes: _readMaxDurationMinutes(),
    );
    if (!mounted) return;
    if (ok) _snack(t('unattendedSaved'));
  }

  Future<void> _stop() async {
    final ok = await widget.provider.stopUnattended();
    if (!mounted) return;
    if (ok) _snack(t('unattendedStopped'));
  }

  void _snack(String text) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(text)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.provider,
      builder: (context, _) {
        final state = _state;
        final busy = widget.provider.unattendedBusy;
        // 预检中所有输入与动作都禁用，第二次点「启动」直接忽略。
        final locked = busy || _checking;
        syncUnattendedRemainingTicker(active: state?.isActive == true);
        final error =
            _localError.isNotEmpty
            ? _localError
            : (widget.provider.unattendedError ?? '');
        return Padding(
          padding: EdgeInsets.fromLTRB(
            16,
            14,
            16,
            MediaQuery.of(context).viewInsets.bottom + 16,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const Icon(
                      Icons.smart_toy_rounded,
                      color: AppColors.accent,
                      size: 20,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      t('unattended'),
                      style: const TextStyle(
                        color: AppColors.textBright,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const Spacer(),
                    IconButton(
                      key: const ValueKey('unattended-close'),
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(
                        Icons.close_rounded,
                        color: AppColors.muted,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  t('unattendedSheetHint'),
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 12,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 12),
                _statusBlock(state),
                const SizedBox(height: 12),
                Text(
                  t('unattendedGoal'),
                  style: const TextStyle(color: AppColors.muted, fontSize: 12),
                ),
                const SizedBox(height: 4),
                TextField(
                  key: const ValueKey('unattended-goal'),
                  controller: _goalCtrl,
                  enabled: !locked,
                  maxLines: 3,
                  minLines: 2,
                  maxLength: UnattendedState.maxGoalLength,
                  style: const TextStyle(
                    color: AppColors.text,
                    fontSize: 13.5,
                    height: 1.4,
                  ),
                  decoration: InputDecoration(
                    hintText: t('unattendedGoalHint'),
                    hintStyle: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 12.5,
                    ),
                    counterText: '',
                    filled: true,
                    fillColor: AppColors.well,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: const BorderSide(color: AppColors.line),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Text(
                      t('unattendedCriteria'),
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 12,
                      ),
                    ),
                    const Spacer(),
                    Text(
                      '${_criteria.length}/${UnattendedState.maxCriteria}',
                      style: const TextStyle(
                        color: AppColors.faint,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                for (var i = 0; i < _criteria.length; i++)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Row(
                      children: [
                        Expanded(
                          child: TextField(
                            key: ValueKey('unattended-criterion-$i'),
                            controller: _criteria[i],
                            enabled: !locked,
                            maxLength: UnattendedState.maxCriterionLength,
                            style: const TextStyle(
                              color: AppColors.text,
                              fontSize: 13,
                            ),
                            decoration: InputDecoration(
                              hintText: t('unattendedCriterionHint'),
                              hintStyle: const TextStyle(
                                color: AppColors.faint,
                                fontSize: 12.5,
                              ),
                              counterText: '',
                              isDense: true,
                              contentPadding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 9,
                              ),
                              filled: true,
                              fillColor: AppColors.well,
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(8),
                                borderSide: const BorderSide(
                                  color: AppColors.line,
                                ),
                              ),
                            ),
                          ),
                        ),
                        IconButton(
                          key: ValueKey('unattended-criterion-remove-$i'),
                          onPressed: locked || _criteria.length <= 1
                              ? null
                              : () => _removeCriterion(i),
                          iconSize: 17,
                          visualDensity: VisualDensity.compact,
                          tooltip: t('unattendedCriterionRemove'),
                          icon: const Icon(
                            Icons.remove_circle_outline,
                            color: AppColors.faint,
                          ),
                        ),
                      ],
                    ),
                  ),
                Row(
                  children: [
                    TextButton.icon(
                      key: const ValueKey('unattended-add-criterion'),
                      onPressed:
                          locked ||
                              _criteria.length >= UnattendedState.maxCriteria
                          ? null
                          : _addCriterion,
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                      ),
                      icon: const Icon(Icons.add_rounded, size: 16),
                      label: Text(
                        t('unattendedCriteriaAdd'),
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                    const Spacer(),
                    TextButton.icon(
                      key: const ValueKey('unattended-draft-criteria'),
                      onPressed: locked ? null : _draftCriteria,
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                      ),
                      icon: _checking
                          ? const SizedBox(
                              width: 13,
                              height: 13,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                              ),
                            )
                          : const Icon(Icons.auto_awesome, size: 16),
                      label: Text(
                        t('unattendedDraftCriteria'),
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                  ],
                ),
                if (_precheckResult || _precheckUnavailable)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: _precheckCard(),
                  ),
                const SizedBox(height: 8),
                // 「最长值守时间」：数字 + 分钟/小时，默认 2 小时，按 limits 收口。
                Row(
                  children: [
                    Text(
                      t('unattendedMaxDuration'),
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(width: 8),
                    SizedBox(
                      width: 72,
                      child: TextField(
                        key: const ValueKey('unattended-max-duration'),
                        controller: _durationCtrl,
                        enabled: !locked,
                        keyboardType: TextInputType.number,
                        style: const TextStyle(
                          color: AppColors.text,
                          fontSize: 13,
                        ),
                        decoration: InputDecoration(
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 8,
                          ),
                          filled: true,
                          fillColor: AppColors.well,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(8),
                            borderSide: const BorderSide(
                              color: AppColors.line,
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    ChoiceChip(
                      key: const ValueKey('unattended-duration-unit-minutes'),
                      label: Text(t('unattendedDurationMinutesUnit')),
                      selected: _durationUnit == _DurationUnit.minutes,
                      onSelected: locked
                          ? null
                          : (_) => _setDurationUnit(_DurationUnit.minutes),
                      visualDensity: VisualDensity.compact,
                      labelStyle: const TextStyle(fontSize: 11.5),
                    ),
                    const SizedBox(width: 4),
                    ChoiceChip(
                      key: const ValueKey('unattended-duration-unit-hours'),
                      label: Text(t('unattendedDurationHoursUnit')),
                      selected: _durationUnit == _DurationUnit.hours,
                      onSelected: locked
                          ? null
                          : (_) => _setDurationUnit(_DurationUnit.hours),
                      visualDensity: VisualDensity.compact,
                      labelStyle: const TextStyle(fontSize: 11.5),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  t('unattendedMaxDurationRange', {
                    'min': '${widget.provider.unattendedLimits.maxDurationMinutesMin}',
                    'max': '${widget.provider.unattendedLimits.maxDurationMinutesMax}',
                  }),
                  style: const TextStyle(
                    color: AppColors.faint,
                    fontSize: 11,
                  ),
                ),
                if (error.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(
                      error,
                      style: const TextStyle(
                        color: AppColors.danger,
                        fontSize: 12,
                      ),
                    ),
                  ),
                const SizedBox(height: 14),
                _actions(state, busy),
              ],
            ),
          ),
        );
      },
    );
  }

  /// 预检结果卡：目标预检（issues + 可编辑建议）或「暂不可用」提示。
  /// 手动「AI 补全判断标准」与点「启动」自动预检共用这一张卡。
  Widget _precheckCard() {
    final fromStart = _precheckFromStart;
    if (_precheckUnavailable) {
      return Container(
        key: const ValueKey('unattended-precheck-unavailable'),
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
        decoration: BoxDecoration(
          color: AppColors.amber.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppColors.amber.withValues(alpha: 0.4)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.info_outline_rounded,
                  size: 16,
                  color: AppColors.amber,
                ),
                const SizedBox(width: 6),
                Text(
                  t('unattendedPrecheckUnavailable'),
                  style: const TextStyle(
                    color: AppColors.amber,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            if (_precheckErrorMessage.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  t('unattendedPrecheckFailed', {
                    'error': _precheckErrorMessage,
                  }),
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 11.5,
                    height: 1.35,
                  ),
                ),
              ),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  key: const ValueKey('unattended-precheck-cancel'),
                  onPressed: _dismissPrecheck,
                  child: Text(t('unattendedPrecheckCancel')),
                ),
                if (fromStart)
                  FilledButton(
                    key: const ValueKey('unattended-precheck-start-anyway'),
                    onPressed: _startAnyway,
                    child: Text(t('unattendedPrecheckStartAnyway')),
                  ),
              ],
            ),
          ],
        ),
      );
    }
    return Container(
      key: const ValueKey('unattended-precheck-card'),
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.75),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.accent.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              const Icon(
                Icons.auto_awesome,
                size: 15,
                color: AppColors.accent,
              ),
              const SizedBox(width: 6),
              Text(
                t('unattendedPrecheckTitle'),
                style: const TextStyle(
                  color: AppColors.accentDark,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            _precheckHeadline,
            key: const ValueKey('unattended-precheck-headline'),
            style: const TextStyle(
              color: AppColors.text,
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
            ),
          ),
          for (final issue in _precheckIssues)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                '• $issue',
                style: const TextStyle(
                  color: AppColors.muted,
                  fontSize: 11.5,
                  height: 1.35,
                ),
              ),
            ),
          const SizedBox(height: 8),
          Text(
            t('unattendedPrecheckRecommendGoal'),
            style: const TextStyle(color: AppColors.muted, fontSize: 11),
          ),
          const SizedBox(height: 3),
          TextField(
            key: const ValueKey('unattended-precheck-goal'),
            controller: _recGoalCtrl,
            enabled: !_checking,
            maxLines: 3,
            minLines: 1,
            maxLength: UnattendedState.maxGoalLength,
            style: const TextStyle(color: AppColors.text, fontSize: 12.5),
            decoration: InputDecoration(
              isDense: true,
              counterText: '',
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 8,
                vertical: 7,
              ),
              filled: true,
              fillColor: AppColors.well,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: const BorderSide(color: AppColors.line),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            t('unattendedPrecheckRecommendCriteria'),
            style: const TextStyle(color: AppColors.muted, fontSize: 11),
          ),
          const SizedBox(height: 3),
          TextField(
            key: const ValueKey('unattended-precheck-criteria'),
            controller: _recCriteriaCtrl,
            enabled: !_checking,
            maxLines: 4,
            minLines: 2,
            style: const TextStyle(color: AppColors.text, fontSize: 12.5),
            decoration: InputDecoration(
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 8,
                vertical: 7,
              ),
              filled: true,
              fillColor: AppColors.well,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(8),
                borderSide: const BorderSide(color: AppColors.line),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 6,
            runSpacing: 4,
            children: [
              TextButton(
                key: const ValueKey('unattended-precheck-cancel'),
                onPressed: _dismissPrecheck,
                style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                ),
                child: Text(t('unattendedPrecheckCancel')),
              ),
              if (fromStart) ...[
                OutlinedButton(
                  key: const ValueKey('unattended-precheck-start-as-is'),
                  onPressed: _startAnyway,
                  child: Text(t('unattendedPrecheckStartAsIs')),
                ),
                FilledButton(
                  key: const ValueKey('unattended-precheck-use-start'),
                  onPressed: _adoptAndStart,
                  child: Text(t('unattendedPrecheckUseAndStart')),
                ),
              ] else
                FilledButton(
                  key: const ValueKey('unattended-precheck-adopt'),
                  onPressed: _adoptRecommendation,
                  child: Text(t('unattendedPrecheckAdopt')),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _statusBlock(UnattendedState? state) {
    final style = _statusStyle(state?.status);
    final verdict = state?.lastVerdict;
    final remaining = unattendedRemainingLabel(state, unattendedNowMs);
    final progress = state == null
        ? null
        : [
            t('unattendedJudgedCount', {'count': '${state.rounds}'}),
            if (remaining != null)
              t('unattendedRemaining', {'remaining': remaining}),
          ].join(' · ');
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: style.background,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: style.color.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(style.icon, color: style.color, size: 17),
              const SizedBox(width: 6),
              Text(
                t(style.labelKey),
                key: const ValueKey('unattended-status'),
                style: TextStyle(
                  color: style.color,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              if (progress != null)
                Text(
                  progress,
                  key: const ValueKey('unattended-progress'),
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 11.5,
                  ),
                ),
            ],
          ),
          // v2：判定中（verdict 开始到落地）转圈；暂停原因（pausedBy）单列一行。
          if (state != null && state.evaluating)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                key: const ValueKey('unattended-evaluating'),
                children: [
                  SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation<Color>(style.color),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    t('unattendedJudging'),
                    style: TextStyle(
                      color: style.color,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          if (state != null && state.pausedBy != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                unattendedPausedByLabel(state.pausedBy) ?? '',
                key: const ValueKey('unattended-paused-by'),
                style: const TextStyle(
                  color: AppColors.muted,
                  fontSize: 12,
                  height: 1.35,
                ),
              ),
            ),
          if (verdict != null && verdict.reason.trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                t('unattendedLastReason', {'reason': verdict.reason.trim()}),
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 12,
                  height: 1.35,
                ),
              ),
            ),
          if (state != null && state.needsHuman)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.7),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: AppColors.amber.withValues(alpha: 0.5),
                  ),
                ),
                child: Text(
                  t('unattendedHumanReason', {
                    'reason': verdict != null && verdict.humanReason.isNotEmpty
                        ? verdict.humanReason
                        : (verdict?.reason ?? ''),
                  }),
                  key: const ValueKey('unattended-human-reason'),
                  style: const TextStyle(
                    color: AppColors.amber,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    height: 1.35,
                  ),
                ),
              ),
            ),
          if (state != null && state.history.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              t('unattendedHistory'),
              style: const TextStyle(
                color: AppColors.muted,
                fontSize: 11,
                fontWeight: FontWeight.w600,
              ),
            ),
            for (final entry in state.history.reversed.take(5))
              Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text(
                  '${_verdictLabel(entry.verdict)}'
                  '${entry.reason.trim().isEmpty ? '' : ' · ${entry.reason.trim()}'}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 11.5,
                    height: 1.3,
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }

  String _verdictLabel(String verdict) => switch (verdict) {
    'achieved' => t('unattendedStatusAchieved'),
    'needs_human' => t('unattendedStatusNeedsHuman'),
    'continue' => t('unattendedVerdictContinue'),
    _ => verdict,
  };

  Widget _actions(UnattendedState? state, bool busy) {
    final mode = unattendedSheetActionMode(state);
    final active = mode == UnattendedSheetActionMode.active;
    final canResume = mode == UnattendedSheetActionMode.resume;
    // 预检中连「保存/停止/继续」一起锁住；启动按钮自己负责显示检查文案。
    final disabled = busy || _checking;
    return Row(
      children: [
        if (active) ...[
          Expanded(
            child: OutlinedButton(
              key: const ValueKey('unattended-save'),
              onPressed: disabled ? null : _save,
              child: Text(t('unattendedSave')),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: FilledButton(
              key: const ValueKey('unattended-stop'),
              onPressed: disabled ? null : _stop,
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.danger,
                foregroundColor: Colors.white,
              ),
              child: Text(t('unattendedStop')),
            ),
          ),
        ] else ...[
          if (canResume) ...[
            Expanded(
              child: OutlinedButton(
                key: const ValueKey('unattended-stop'),
                onPressed: disabled ? null : _stop,
                child: Text(t('unattendedStop')),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              flex: 2,
              child: FilledButton(
                key: const ValueKey('unattended-resume'),
                // 继续不跑预检：状态已经在服务端了，只补一个可选的时限。
                onPressed: disabled ? null : () => _performStart(resume: true),
                child: Text(t('unattendedResume')),
              ),
            ),
          ] else
            Expanded(
              child: FilledButton(
                key: const ValueKey('unattended-start'),
                onPressed: disabled ? null : _startFromTap,
                child: _checking
                    ? Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const SizedBox(
                            width: 13,
                            height: 13,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          const SizedBox(width: 6),
                          Text(t('unattendedPrecheckChecking')),
                        ],
                      )
                    : Text(t('unattendedStart')),
              ),
            ),
        ],
      ],
    );
  }
}
