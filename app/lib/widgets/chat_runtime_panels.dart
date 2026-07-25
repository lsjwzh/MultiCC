import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/chat_runtime_state.dart';

class PendingUserInputPanel extends StatefulWidget {
  final PendingUserInput input;
  final bool enabled;
  final ValueChanged<String> onAnswer;

  const PendingUserInputPanel({
    super.key,
    required this.input,
    required this.enabled,
    required this.onAnswer,
  });

  @override
  State<PendingUserInputPanel> createState() => _PendingUserInputPanelState();
}

class _PendingUserInputPanelState extends State<PendingUserInputPanel> {
  final Set<String> _selected = {};

  @override
  void didUpdateWidget(covariant PendingUserInputPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.input.requestId != widget.input.requestId) {
      _selected.clear();
    }
  }

  @override
  Widget build(BuildContext context) {
    final input = widget.input;
    final question = input.question.isEmpty
        ? t('pendingInputFallback')
        : input.question;
    return Container(
      key: const Key('pending-user-input-panel'),
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 7),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xFF211a08),
        border: Border.all(color: const Color(0xFF7d5d16)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              const Icon(
                Icons.help_outline_rounded,
                size: 16,
                color: Color(0xFFe3b341),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  t('pendingInputTitle'),
                  style: const TextStyle(
                    color: Color(0xFFf2cc60),
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            question,
            style: const TextStyle(
              color: Color(0xFFf0f3f6),
              fontSize: 13,
              height: 1.4,
            ),
          ),
          if (input.reason.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              input.reason,
              style: const TextStyle(
                color: Color(0xFFaeb6c2),
                fontSize: 11,
                height: 1.35,
              ),
            ),
          ],
          if (input.options.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: input.options
                  .map((option) {
                    if (!input.allowMultiple) {
                      return OutlinedButton(
                        key: Key('pending-option-$option'),
                        onPressed: widget.enabled
                            ? () => widget.onAnswer(option)
                            : null,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFFf2cc60),
                          side: const BorderSide(color: Color(0xFF7d5d16)),
                          visualDensity: VisualDensity.compact,
                        ),
                        child: Text(option),
                      );
                    }
                    return FilterChip(
                      key: Key('pending-option-$option'),
                      selected: _selected.contains(option),
                      onSelected: widget.enabled
                          ? (selected) {
                              setState(() {
                                if (selected) {
                                  _selected.add(option);
                                } else {
                                  _selected.remove(option);
                                }
                              });
                            }
                          : null,
                      label: Text(option),
                    );
                  })
                  .toList(growable: false),
            ),
            if (input.allowMultiple) ...[
              const SizedBox(height: 8),
              FilledButton.tonal(
                key: const Key('pending-submit-multiple'),
                onPressed: widget.enabled && _selected.isNotEmpty
                    ? () => widget.onAnswer(
                        input.options.where(_selected.contains).join(', '),
                      )
                    : null,
                child: Text(t('submitAnswer')),
              ),
            ],
          ],
          const SizedBox(height: 5),
          Text(
            t('pendingInputFreeTextHint'),
            style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
          ),
        ],
      ),
    );
  }
}

class SessionQueuePanel extends StatefulWidget {
  final SessionQueueState queue;
  final bool enabled;
  final Future<void> Function(String action) onAction;
  final Future<void> Function(String entryId) onCancelQueued;

  const SessionQueuePanel({
    super.key,
    required this.queue,
    required this.enabled,
    required this.onAction,
    required this.onCancelQueued,
  });

  @override
  State<SessionQueuePanel> createState() => _SessionQueuePanelState();
}

class _SessionQueuePanelState extends State<SessionQueuePanel> {
  bool _expanded = false;
  bool _busy = false;

  String _runStateLabel(SessionQueueRunState state) => switch (state) {
    SessionQueueRunState.idle => t('queueIdle'),
    SessionQueueRunState.queued => t('queueQueued'),
    SessionQueueRunState.running => t('queueRunning'),
    SessionQueueRunState.waiting => t('queueWaiting'),
    SessionQueueRunState.error => t('queueError'),
  };

  Future<void> _run(Future<void> Function() action) async {
    if (_busy || !widget.enabled) return;
    setState(() => _busy = true);
    try {
      await action();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final queue = widget.queue;
    if (queue.items.isEmpty && !queue.isFrozen) {
      return const SizedBox.shrink();
    }
    return Container(
      key: const Key('session-queue-panel'),
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 7),
      decoration: BoxDecoration(
        color: const Color(0xFF161b22),
        border: Border.all(
          color: queue.runState == SessionQueueRunState.error
              ? const Color(0xFF8b2f36)
              : const Color(0xFF3d444d),
        ),
        borderRadius: BorderRadius.circular(10),
        boxShadow: const [
          BoxShadow(
            color: Color(0x55000000),
            blurRadius: 14,
            offset: Offset(0, -4),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  const Icon(
                    Icons.schedule_send_rounded,
                    size: 15,
                    color: Color(0xFFd29922),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    t('queuedMessageCount', {'n': '${queue.items.length}'}),
                    style: const TextStyle(
                      color: Color(0xFFd29922),
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      queue.isFrozen && queue.freezeReason != null
                          ? '${_runStateLabel(queue.runState)} · ${queue.freezeReason}'
                          : _runStateLabel(queue.runState),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.end,
                      style: const TextStyle(
                        color: Color(0xFF8a909b),
                        fontSize: 11,
                      ),
                    ),
                  ),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 18,
                    color: const Color(0xFF8a909b),
                  ),
                ],
              ),
            ),
          ),
          if (queue.isFrozen)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 7),
              child: Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  if (queue.canRetry)
                    _QueueActionButton(
                      key: const Key('queue-action-retry'),
                      label: t('retryTask'),
                      onPressed: _busy || !widget.enabled
                          ? null
                          : () => _run(() => widget.onAction('retry')),
                    ),
                  if (queue.canResume)
                    _QueueActionButton(
                      key: const Key('queue-action-resume'),
                      label: t('resumeTask'),
                      onPressed: _busy || !widget.enabled
                          ? null
                          : () => _run(() => widget.onAction('resume')),
                    ),
                  if (queue.canSkip)
                    _QueueActionButton(
                      key: const Key('queue-action-skip'),
                      label: t('skipTask'),
                      onPressed: _busy || !widget.enabled
                          ? null
                          : () => _run(() => widget.onAction('skip')),
                    ),
                  if (queue.canCancelActive)
                    _QueueActionButton(
                      key: const Key('queue-action-cancel'),
                      label: t('cancelTask'),
                      danger: true,
                      onPressed: _busy || !widget.enabled
                          ? null
                          : () => _run(() => widget.onAction('cancel')),
                    ),
                ],
              ),
            ),
          if (_expanded && queue.items.isNotEmpty)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 240),
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                child: Column(
                  children: queue.items
                      .map((item) {
                        return Container(
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 6,
                          ),
                          decoration: const BoxDecoration(
                            border: Border(
                              top: BorderSide(color: Color(0xFF30363d)),
                            ),
                          ),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(
                                child: Text(
                                  '${item.position}. ${item.text.isEmpty ? t('queuedMessageFallback') : item.text}',
                                  style: const TextStyle(
                                    color: Color(0xFFc9d1d9),
                                    fontSize: 12,
                                    height: 1.4,
                                  ),
                                ),
                              ),
                              if (item.canCancel)
                                IconButton(
                                  key: Key('cancel-queued-${item.entryId}'),
                                  tooltip: t('cancelQueuedMessage'),
                                  visualDensity: VisualDensity.compact,
                                  iconSize: 17,
                                  color: const Color(0xFFff7b72),
                                  onPressed: _busy || !widget.enabled
                                      ? null
                                      : () => _run(
                                          () => widget.onCancelQueued(
                                            item.entryId,
                                          ),
                                        ),
                                  icon: const Icon(Icons.close_rounded),
                                ),
                            ],
                          ),
                        );
                      })
                      .toList(growable: false),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _QueueActionButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final bool danger;

  const _QueueActionButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.danger = false,
  });

  @override
  Widget build(BuildContext context) => OutlinedButton(
    onPressed: onPressed,
    style: OutlinedButton.styleFrom(
      visualDensity: VisualDensity.compact,
      minimumSize: const Size(0, 32),
      foregroundColor: danger
          ? const Color(0xFFff7b72)
          : const Color(0xFFc9d1d9),
      side: BorderSide(
        color: danger ? const Color(0xFF8b2f36) : const Color(0xFF3d444d),
      ),
    ),
    child: Text(label),
  );
}

class ChatRuntimeNoticePanel extends StatelessWidget {
  final ApiErrorPolicyState? apiError;
  final UsageWindowLimit? limit;
  final UsageBalance? balance;
  final VoidCallback? onRetry;

  const ChatRuntimeNoticePanel({
    super.key,
    this.apiError,
    this.limit,
    this.balance,
    this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    if (apiError == null && limit == null && balance == null) {
      return const SizedBox.shrink();
    }
    return Container(
      key: const Key('chat-runtime-notice-panel'),
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: const BoxDecoration(
        color: Color(0xFF0a0c0f),
        border: Border(bottom: BorderSide(color: Color(0xFF20242b))),
      ),
      child: Wrap(
        spacing: 10,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          if (limit != null) _limitView(context, limit!),
          if (balance != null) _balanceView(balance!),
          if (apiError != null) _errorView(apiError!),
          if (apiError?.canManualRetry == true && onRetry != null)
            OutlinedButton.icon(
              key: const Key('api-error-manual-retry'),
              onPressed: onRetry,
              style: OutlinedButton.styleFrom(
                visualDensity: VisualDensity.compact,
                foregroundColor: const Color(0xFFff9b9b),
                side: const BorderSide(color: Color(0xFF8b2f36)),
              ),
              icon: const Icon(Icons.refresh_rounded, size: 16),
              label: Text(t('retryTask')),
            ),
        ],
      ),
    );
  }

  Widget _limitView(BuildContext context, UsageWindowLimit value) {
    final used = value.usedPercentage;
    final label = value.provider == 'codex'
        ? t('codexWeeklyLimit')
        : value.provider == 'glm'
        ? t('glmFiveHourLimit')
        : t('claudeFiveHourLimit');
    final reset = value.resetsAtMs == null
        ? ''
        : TimeOfDay.fromDateTime(
            DateTime.fromMillisecondsSinceEpoch(value.resetsAtMs!),
          ).format(context);
    final color = value.status == 'rejected'
        ? const Color(0xFFff7b72)
        : value.status == 'allowed_warning'
        ? const Color(0xFFe3b341)
        : const Color(0xFF7ee787);
    final percent = used == null ? '—' : '${used.toStringAsFixed(1)}%';
    return Semantics(
      label: '$label $percent',
      child: Text(
        reset.isEmpty
            ? '$label · $percent'
            : '$label · $percent · ${t('resetsAt', {'time': reset})}',
        style: TextStyle(color: color, fontSize: 11),
      ),
    );
  }

  Widget _balanceView(UsageBalance value) {
    final text = !value.available
        ? t('balanceUnavailable')
        : '${value.currency ?? ''} ${value.total?.toStringAsFixed(2) ?? '—'}'
              .trim();
    return Text(
      '${t('deepSeekBalance')} · $text',
      style: TextStyle(
        color: value.available
            ? const Color(0xFF7ee787)
            : const Color(0xFFe3b341),
        fontSize: 11,
      ),
    );
  }

  Widget _errorView(ApiErrorPolicyState value) {
    final retry = value.isRetryScheduled
        ? t('serverRetryScheduled')
        : value.userAction.isNotEmpty
        ? value.userAction
        : value.message;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 520),
      child: Text(
        '${value.provider} · ${value.category}'
        '${value.httpStatus == null ? '' : ' · HTTP ${value.httpStatus}'}'
        '${retry.isEmpty ? '' : ' · $retry'}',
        style: TextStyle(
          color: value.isRetryScheduled
              ? const Color(0xFFe3b341)
              : const Color(0xFFff9b9b),
          fontSize: 11,
          height: 1.35,
        ),
      ),
    );
  }
}
