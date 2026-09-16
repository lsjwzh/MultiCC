// 分类条：AI 助手对当前会话的理解（目标 · 阶段 · 状态）。
//
// 自 chat_screen.dart 抽出 —— 那个文件已顶到 3k 行预算，而这条 bar 本就是自成一
// 体的 widget（只依赖 registry、i18n 与状态条的共享渲染）。

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../utils/session_status_helpers.dart';
import '../utils/status_presentation.dart';

/// AI 助手对当前会话的理解条（目标 · 阶段 · 状态），对齐 web 的
/// `#aux-classify-bar`。公开而非私有：两个动作药丸的显隐规则直接照抄 web 的
/// `can-mark-done`(W) / `can-cancel-task`(P) 两个 class，是条容易改坏的规则，
/// 需要能被 widget 测试直接钉住。
class AuxClassifyBar extends StatelessWidget {
  final String goal;
  final String phase;

  /// Live classify-state letter (D/W/B/E/P). Drives the pill tint, aligned
  /// with main_shell _classifyBadge and the web CLASSIFY_DISPLAY barTint.
  final String classifyState;

  /// True when the classifier behind this bar is unhealthy, so [goal]/[phase]
  /// are frozen at the last thing it managed to say. The bar keeps showing them
  /// — they are still the best description we have — and marks them as paused;
  /// without this the goal reads as a live judgement that simply never changes.
  final bool stale;

  /// Non-null when state is W: shows the localized turn-success button.
  /// The compatibility endpoint changes only turn outcome, never task lifecycle.
  final VoidCallback? onMarkTurnSucceeded;

  /// Non-null when state is P (processing): shows 「✕ 取消」. Web gates the same
  /// button on `can-cancel-task` and wires it to cancelStreaming().
  final VoidCallback? onCancelTurn;

  const AuxClassifyBar({
    super.key,
    required this.goal,
    required this.phase,
    required this.classifyState,
    this.stale = false,
    this.onMarkTurnSucceeded,
    this.onCancelTurn,
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
    // classify 字母 → canonical 状态 → 图标/色彩，全部走中心 registry：这条
    // bar 曾自带一套色表（E 是 ⚠、卡片却是 ❌），现在与会话卡、任务面板同源。
    final spec = statusPresentation[classifyStatusOf(classifyState)]!;
    final phaseColor = spec.color;
    final phaseBg = phaseColor.withValues(alpha: 0.12);
    final phaseBorder = phaseColor.withValues(alpha: 0.34);
    final stateEmoji = spec.icon;
    final phaseLabel = _phaseLabel(phase);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: const BoxDecoration(
        color: Color(0xFFf4f8fd),
        border: Border(bottom: BorderSide(color: Color(0xFFf8fbff))),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.auto_awesome_outlined,
            size: 14,
            color: Color(0xFF8a9aab),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Tooltip(
              message: stale ? '$goal\n${t('auxVerdictPausedHint')}' : goal,
              child: Text(
                goal,
                style: TextStyle(
                  color: const Color(0xFF4a6076),
                  fontSize: 12,
                  height: 1.3,
                  // A paused verdict is de-emphasised, not hidden: still the best
                  // description on screen, no longer claiming to be the current one.
                  fontStyle: stale ? FontStyle.italic : FontStyle.normal,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          // The marker sits between the goal and the state pill, so it reads as a
          // caveat about both rather than as another state.
          if (stale) ...[
            const SizedBox(width: 6),
            Tooltip(message: t('auxVerdictPausedHint'), child: verdictStaleChip()),
          ],
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
          // Cancel button: visible only when state is P (processing). Same slot
          // and same red tint as the web's ac-cancel-task pill; the action is
          // the composer's Stop — cancel the in-flight turn.
          if (onCancelTurn != null) ...[
            const SizedBox(width: 6),
            Tooltip(
              message: t('cancelTurnFromBarTitle'),
              child: GestureDetector(
                key: const Key('classify-cancel-turn'),
                onTap: onCancelTurn,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xFFfdf0ef),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: const Color(0x88b64e43)),
                  ),
                  child: Text(
                    t('cancelTurnFromBar'),
                    style: const TextStyle(
                      color: Color(0xFFb64e43),
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ),
          ],
          // Turn-success button: visible only when state is W (waiting-for-user)
          if (onMarkTurnSucceeded != null) ...[
            const SizedBox(width: 6),
            GestureDetector(
              onTap: onMarkTurnSucceeded,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0xFFedf8f1),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: const Color(0x882ba67a)),
                ),
                child: Text(
                  t('markTurnSucceeded'),
                  style: const TextStyle(
                    color: Color(0xFF2ba67a),
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
