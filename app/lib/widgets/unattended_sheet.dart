import 'dart:async';

import 'package:flutter/material.dart';

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

/// 聊天页常驻的无人值守悬浮球。状态配色见契约：idle 灰、active 绿（呼吸）、
/// needs_human 琥珀、achieved 勾、stopped/exhausted/error 灰红。
class UnattendedFab extends StatefulWidget {
  const UnattendedFab({super.key, required this.state, required this.onTap});

  final UnattendedState? state;
  final VoidCallback onTap;

  @override
  State<UnattendedFab> createState() => _UnattendedFabState();
}

class _UnattendedFabState extends State<UnattendedFab>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  @override
  void initState() {
    super.initState();
    _syncPulse();
  }

  @override
  void didUpdateWidget(covariant UnattendedFab oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncPulse();
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
    final rounds = state?.rounds ?? 0;
    final maxRounds = state?.maxRounds ?? 0;
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
                Icon(style.icon, color: Colors.white, size: 22),
                if (state != null && maxRounds > 0)
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
                        '$rounds/$maxRounds',
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

UnattendedSheetActionMode unattendedSheetActionMode(UnattendedState? state) {
  if (state?.isActive == true) return UnattendedSheetActionMode.active;
  if (state?.canResume == true) return UnattendedSheetActionMode.resume;
  return UnattendedSheetActionMode.start;
}

Future<void> showUnattendedSheet(
  BuildContext context, {
  required ChatProvider provider,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => _UnattendedSheet(provider: provider),
  );
}

class _UnattendedSheet extends StatefulWidget {
  const _UnattendedSheet({required this.provider});

  final ChatProvider provider;

  @override
  State<_UnattendedSheet> createState() => _UnattendedSheetState();
}

class _UnattendedSheetState extends State<_UnattendedSheet> {
  late final TextEditingController _goalCtrl;
  late final TextEditingController _roundsCtrl;
  final List<TextEditingController> _criteria = [];
  GoalPrecheckConfig _precheckConfig = const GoalPrecheckConfig();
  bool _checking = false;
  String _precheckError = '';
  List<String> _precheckNotes = const [];
  String _localError = '';

  UnattendedState? get _state => widget.provider.unattended;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.provider.clearUnattendedError();
    });
    final state = widget.provider.unattended;
    _goalCtrl = TextEditingController(text: state?.goal ?? '');
    _roundsCtrl = TextEditingController(
      text:
          '${state?.maxRounds ?? widget.provider.unattendedLimits.maxRoundsDefault}',
    );
    for (final line in state?.criteria ?? const <String>[]) {
      _criteria.add(TextEditingController(text: line));
    }
    if (_criteria.isEmpty) _criteria.add(TextEditingController());
    unawaited(
      GoalPrecheckConfig.load(settings: widget.provider.settings).then((
        config,
      ) {
        if (mounted) setState(() => _precheckConfig = config);
      }),
    );
  }

  @override
  void dispose() {
    _goalCtrl.dispose();
    _roundsCtrl.dispose();
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

  int _readMaxRounds() {
    final limits = widget.provider.unattendedLimits;
    final value = int.tryParse(_roundsCtrl.text.trim()) ?? limits.maxRoundsDefault;
    return value.clamp(1, limits.maxRoundsMax);
  }

  Future<void> _draftCriteria() async {
    final goal = _goalCtrl.text.trim();
    if (goal.isEmpty) {
      setState(() => _localError = t('unattendedGoalRequired'));
      return;
    }
    setState(() {
      _checking = true;
      _precheckError = '';
      _precheckNotes = const [];
    });
    final data = await requestGoalPrecheck(
      settings: widget.provider.settings,
      task: goal,
      dimensions: _precheckConfig.dimensions,
      precheckWaitMs: _precheckConfig.precheckWaitMs,
    );
    if (!mounted) return;
    setState(() {
      _checking = false;
      if (data['ok'] == true) {
        final criteria = goalPrecheckStringList(data['criteria']);
        if (criteria.isNotEmpty) {
          for (final controller in _criteria) {
            controller.dispose();
          }
          _criteria
            ..clear()
            ..addAll(
              criteria
                  .take(UnattendedState.maxCriteria)
                  .map((line) => TextEditingController(text: line)),
            );
        }
        _precheckNotes = [
          ...goalPrecheckStringList(data['issues']),
          ...goalPrecheckStringList(data['questions']),
        ];
      } else {
        _precheckError = t('unattendedPrecheckFailed', {
          'error': '${data['error'] ?? t('unknownError')}',
        });
      }
    });
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

  Future<void> _start({bool resume = false}) async {
    final provider = widget.provider;
    setState(() => _localError = '');
    final ok = resume
        ? await provider.resumeUnattended()
        : await provider.startUnattended(
            goal: _goalCtrl.text,
            criteria: _readCriteria(),
            maxRounds: _readMaxRounds(),
          );
    if (!mounted) return;
    if (ok) {
      _snack(t('unattendedStarted'));
    }
  }

  Future<void> _save() async {
    final ok = await widget.provider.updateUnattended(
      goal: _goalCtrl.text,
      criteria: _readCriteria(),
      maxRounds: _readMaxRounds(),
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
                _statusBlock(state, busy),
                const SizedBox(height: 12),
                Text(
                  t('unattendedGoal'),
                  style: const TextStyle(color: AppColors.muted, fontSize: 12),
                ),
                const SizedBox(height: 4),
                TextField(
                  key: const ValueKey('unattended-goal'),
                  controller: _goalCtrl,
                  enabled: !busy,
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
                            enabled: !busy,
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
                          onPressed: busy || _criteria.length <= 1
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
                          busy ||
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
                      onPressed: busy || _checking ? null : _draftCriteria,
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
                if (_precheckNotes.isNotEmpty)
                  Text(
                    _precheckNotes.map((line) => '• $line').join('\n'),
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 11.5,
                      height: 1.35,
                    ),
                  ),
                if (_precheckError.isNotEmpty)
                  Text(
                    _precheckError,
                    style: const TextStyle(
                      color: AppColors.danger,
                      fontSize: 11.5,
                    ),
                  ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Text(
                      t('unattendedMaxRounds'),
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(width: 8),
                    SizedBox(
                      width: 78,
                      child: TextField(
                        key: const ValueKey('unattended-max-rounds'),
                        controller: _roundsCtrl,
                        enabled: !busy,
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
                    const SizedBox(width: 8),
                    Text(
                      t('unattendedMaxRoundsRange'),
                      style: const TextStyle(
                        color: AppColors.faint,
                        fontSize: 11,
                      ),
                    ),
                  ],
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

  Widget _statusBlock(UnattendedState? state, bool busy) {
    final style = _statusStyle(state?.status);
    final rounds = state?.rounds ?? 0;
    final maxRounds = state?.maxRounds ?? widget.provider.unattendedLimits.maxRoundsDefault;
    final verdict = state?.lastVerdict;
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
              if (state != null)
                Text(
                  t('unattendedRoundProgress', {
                    'round': '$rounds',
                    'max': '$maxRounds',
                  }),
                  style: const TextStyle(
                    color: AppColors.muted,
                    fontSize: 11.5,
                  ),
                ),
            ],
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
    return Row(
      children: [
        if (active) ...[
          Expanded(
            child: OutlinedButton(
              key: const ValueKey('unattended-save'),
              onPressed: busy ? null : _save,
              child: Text(t('unattendedSave')),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: FilledButton(
              key: const ValueKey('unattended-stop'),
              onPressed: busy ? null : _stop,
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
                onPressed: busy ? null : _stop,
                child: Text(t('unattendedStop')),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              flex: 2,
              child: FilledButton(
                key: const ValueKey('unattended-resume'),
                onPressed: busy ? null : () => _start(resume: true),
                child: Text(t('unattendedResume')),
              ),
            ),
          ] else
            Expanded(
              child: FilledButton(
                key: const ValueKey('unattended-start'),
                onPressed: busy ? null : _start,
                child: Text(t('unattendedStart')),
              ),
            ),
        ],
      ],
    );
  }
}
