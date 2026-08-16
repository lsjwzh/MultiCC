import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/chat_runtime_state.dart';
import '../models/dispatch_queue.dart';
import '../models/vendor_quota.dart';
import '../utils/status_presentation.dart';

class PendingUserInputPanel extends StatefulWidget {
  final PendingUserInput input;
  final bool enabled;
  final ValueChanged<String> onAnswer;

  /// 收起为漂浮球（可选；不传则不显示收起按钮）。收起纯属本地 UI，
  /// 不改变「等待回答」的服务端语义。
  final VoidCallback? onCollapse;

  const PendingUserInputPanel({
    super.key,
    required this.input,
    required this.enabled,
    required this.onAnswer,
    this.onCollapse,
  });

  @override
  State<PendingUserInputPanel> createState() => _PendingUserInputPanelState();
}

class _PendingUserInputPanelState extends State<PendingUserInputPanel> {
  final Set<String> _selected = {};
  final TextEditingController _customAnswer = TextEditingController();

  @override
  void initState() {
    super.initState();
    _customAnswer.addListener(_refreshSubmitState);
  }

  void _refreshSubmitState() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _customAnswer
      ..removeListener(_refreshSubmitState)
      ..dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant PendingUserInputPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.input.requestId != widget.input.requestId) {
      _selected.clear();
      _customAnswer.clear();
    }
  }

  void _submitCustomAnswer() {
    final answer = _customAnswer.text.trim();
    if (!widget.enabled || answer.isEmpty) return;
    widget.onAnswer(answer);
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
              if (widget.onCollapse != null)
                IconButton(
                  key: const Key('pending-collapse'),
                  onPressed: widget.enabled ? widget.onCollapse : null,
                  icon: const Icon(Icons.unfold_less_rounded, size: 18),
                  tooltip: t('pendingInputCollapse'),
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 28,
                    minHeight: 28,
                  ),
                  color: const Color(0xFFf2cc60),
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
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  key: const Key('pending-free-text'),
                  controller: _customAnswer,
                  enabled: widget.enabled,
                  minLines: 1,
                  maxLines: 3,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => _submitCustomAnswer(),
                  style: const TextStyle(
                    color: Color(0xFFf0f3f6),
                    fontSize: 13,
                  ),
                  decoration: InputDecoration(
                    isDense: true,
                    hintText: t('pendingInputFreeTextHint'),
                    hintStyle: const TextStyle(
                      color: Color(0xFF8a909b),
                      fontSize: 11,
                    ),
                    filled: true,
                    fillColor: const Color(0xFF0d1117),
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 9,
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: const BorderSide(color: Color(0xFF574515)),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: const BorderSide(color: Color(0xFFd29922)),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 7),
              FilledButton(
                key: const Key('pending-submit-text'),
                onPressed:
                    widget.enabled && _customAnswer.text.trim().isNotEmpty
                    ? _submitCustomAnswer
                    : null,
                child: Text(t('submitAnswer')),
              ),
            ],
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

  /// 「立刻插入」：停掉当前回复并让这条暂存消息马上执行（web 端同名按钮）。
  /// 可选，省略时列表项只显示取消按钮（旧行为）。
  final Future<void> Function(String entryId)? onInsertQueued;

  const SessionQueuePanel({
    super.key,
    required this.queue,
    required this.enabled,
    required this.onAction,
    required this.onCancelQueued,
    this.onInsertQueued,
  });

  @override
  State<SessionQueuePanel> createState() => _SessionQueuePanelState();
}

class _SessionQueuePanelState extends State<SessionQueuePanel> {
  bool _expanded = false;
  bool _busy = false;

  // 文案/图标/色彩全部取自中心 registry，队列面板不再自带一套状态词表。
  StatusSpec _spec(CanonicalStatus state) => statusPresentation[state]!;

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
          color: queue.runState == CanonicalStatus.error
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
                    child: Builder(
                      builder: (_) {
                        final spec = _spec(queue.runState);
                        // freezeReason 会出现在用户可见文案里，必须先脱敏：
                        // 已知枚举键原样透出，其余去掉路径/URL/长 token 并截断。
                        final reason = queue.isFrozen
                            ? sanitizeReason(queue.freezeReason)
                            : '';
                        return Semantics(
                          label: spec.semanticLabel,
                          child: Text(
                            reason.isEmpty
                                ? '${spec.icon} ${spec.label}'
                                : '${spec.icon} ${spec.label} · $reason',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            textAlign: TextAlign.end,
                            style: const TextStyle(
                              color: Color(0xFF8a909b),
                              fontSize: 11,
                            ),
                          ),
                        );
                      },
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
                              // 插队优先的那条已经在等着抢占执行槽，按钮换成
                              // 不可点的状态标记，避免用户重复触发一次中断。
                              if (item.priority)
                                Padding(
                                  key: Key('queued-running-${item.entryId}'),
                                  padding: const EdgeInsets.only(left: 6),
                                  child: Text(
                                    t('queuedMessageRunning'),
                                    style: const TextStyle(
                                      color: Color(0xFFd29922),
                                      fontSize: 11,
                                    ),
                                  ),
                                )
                              else if (item.canInsert &&
                                  widget.onInsertQueued != null)
                                IconButton(
                                  key: Key('insert-queued-${item.entryId}'),
                                  tooltip: t('insertQueuedMessage'),
                                  visualDensity: VisualDensity.compact,
                                  iconSize: 17,
                                  color: const Color(0xFFd29922),
                                  onPressed: _busy || !widget.enabled
                                      ? null
                                      : () => _run(
                                          () => widget.onInsertQueued!(
                                            item.entryId,
                                          ),
                                        ),
                                  icon: const Icon(Icons.bolt_rounded),
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
  // GLM/Codex window bar and the DeepSeek balance bar arrive already resolved
  // from the server render — the panel paints them verbatim.
  final VendorQuotaView? limit;
  final VendorQuotaView? balance;
  // Vendor bars gated on the provider baseUrl (ark/zhipu/kimi), each tappable
  // like its web counterpart (install / auth / login / refetch).
  final VendorQuotaView? arkUsage;
  final VendorQuotaView? zhipuUsage;
  final VendorQuotaView? kimiUsage;
  final VendorQuotaView? claudeUsage;
  final VendorQuotaView? qoderUsage;
  final VendorQuotaView? opencodeUsage;
  final VendorQuotaView? codexUsage;
  final VoidCallback? onClaudeQuotaTap;
  final VoidCallback? onQoderQuotaTap;
  final VoidCallback? onOpenCodeQuotaTap;
  final VoidCallback? onCodexQuotaTap;
  final VoidCallback? onArkQuotaTap;
  final VoidCallback? onZhipuQuotaTap;
  final VoidCallback? onKimiQuotaTap;
  final VoidCallback? onRetry;

  const ChatRuntimeNoticePanel({
    super.key,
    this.apiError,
    this.limit,
    this.balance,
    this.arkUsage,
    this.zhipuUsage,
    this.kimiUsage,
    this.claudeUsage,
    this.qoderUsage,
    this.opencodeUsage,
    this.codexUsage,
    this.onClaudeQuotaTap,
    this.onQoderQuotaTap,
    this.onOpenCodeQuotaTap,
    this.onCodexQuotaTap,
    this.onArkQuotaTap,
    this.onZhipuQuotaTap,
    this.onKimiQuotaTap,
    this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    if (apiError == null &&
        limit == null &&
        balance == null &&
        arkUsage == null &&
        zhipuUsage == null &&
        kimiUsage == null &&
        claudeUsage == null &&
        qoderUsage == null &&
        opencodeUsage == null &&
        codexUsage == null) {
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
      // Slot order matches the web chat.html bar row: opencode, qoder, codex,
      // claude-rate-limit (subscription or routed window), balance, ark,
      // zhipu, kimi — then the api-error row the web shows in the same panel.
      child: Wrap(
        spacing: 10,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          if (opencodeUsage != null)
            _quotaBarView(
              opencodeUsage!,
              onTap: onOpenCodeQuotaTap,
              key: const Key('opencode-quota-bar'),
            ),
          if (qoderUsage != null)
            _quotaBarView(
              qoderUsage!,
              onTap: onQoderQuotaTap,
              key: const Key('qoder-quota-bar'),
            ),
          if (codexUsage != null)
            _quotaBarView(
              codexUsage!,
              onTap: onCodexQuotaTap,
              key: const Key('codex-quota-bar'),
            ),
          if (claudeUsage != null)
            _claudeUsageView(claudeUsage!, onTap: onClaudeQuotaTap),
          if (limit != null) _vendorQuotaView(limit!),
          if (balance != null) _vendorQuotaView(balance!),
          if (arkUsage != null)
            _quotaBarView(
              arkUsage!,
              onTap: onArkQuotaTap,
              key: const Key('ark-quota-bar'),
            ),
          if (zhipuUsage != null)
            _quotaBarView(
              zhipuUsage!,
              onTap: onZhipuQuotaTap,
              key: const Key('zhipu-quota-bar'),
            ),
          if (kimiUsage != null)
            _quotaBarView(
              kimiUsage!,
              onTap: onKimiQuotaTap,
              key: const Key('kimi-quota-bar'),
            ),
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

  /// Claude subscription limit bar — merged 5h + weekly/monthly windows (or an
  /// idle / actionable placeholder). Tapping refreshes the usage scrape, or
  /// opens the login window when the scrape reports no session.
  Widget _claudeUsageView(VendorQuotaView v, {VoidCallback? onTap}) =>
      _quotaBarView(v, onTap: onTap, key: const Key('claude-quota-bar'));

  /// A tappable quota bar: tapping refreshes, or opens the login window when
  /// the underlying scrape reports no session. Shared by the Claude, Qoder,
  /// OpenCode and Codex subscription bars (web: `quotaBarClick`).
  Widget _quotaBarView(VendorQuotaView v, {VoidCallback? onTap, Key? key}) {
    final chip = Semantics(
      label: v.tooltip.isNotEmpty ? '${v.text}\n${v.tooltip}' : v.text,
      button: true,
      child: Text(
        v.text,
        style: TextStyle(color: Color(v.color), fontSize: 11),
      ),
    );
    if (onTap == null) return chip;
    return InkWell(
      key: key,
      onTap: onTap,
      borderRadius: BorderRadius.circular(4),
      child: chip,
    );
  }

  Widget _vendorQuotaView(VendorQuotaView v) {
    return Semantics(
      label: v.tooltip.isNotEmpty ? '${v.text}\n${v.tooltip}' : v.text,
      child: Text(
        v.text,
        style: TextStyle(color: Color(v.color), fontSize: 11),
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

/// Compact two-way dispatch history dock. It is mounted in ChatView's Stack,
/// so the default collapsed FAB consumes no composer height. Expanding shows
/// at most five rows, with live operations first and recent terminal records
/// filling any remaining slots. The DTO never includes prompt text.
class DispatchQueuePanel extends StatefulWidget {
  final List<DispatchQueueEntry> entries;
  final String Function(String sessionId) resolveName;
  final Future<void> Function()? onRefresh;
  final ValueChanged<DispatchQueueEntry>? onOpenSession;
  final ValueChanged<bool>? onExpandedChanged;
  final bool initiallyExpanded;

  static const int maxRows = 5;

  const DispatchQueuePanel({
    super.key,
    required this.entries,
    required this.resolveName,
    this.onRefresh,
    this.onOpenSession,
    this.onExpandedChanged,
    this.initiallyExpanded = false,
  });

  @override
  State<DispatchQueuePanel> createState() => _DispatchQueuePanelState();
}

class _DispatchQueuePanelState extends State<DispatchQueuePanel> {
  late bool _expanded;

  @override
  void initState() {
    super.initState();
    _expanded = widget.initiallyExpanded;
  }

  @override
  void didUpdateWidget(covariant DispatchQueuePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initiallyExpanded != widget.initiallyExpanded) {
      _expanded = widget.initiallyExpanded;
    }
  }

  void _setExpanded(bool value) {
    if (_expanded == value) return;
    setState(() => _expanded = value);
    widget.onExpandedChanged?.call(value);
  }

  String _modeLabel(String? mode) {
    switch (mode) {
      case 'sync':
        return t('dispatchModeSync');
      case 'async':
        return t('dispatchModeAsync');
      case 'one_way':
        return t('dispatchModeOneWay');
      default:
        return '';
    }
  }

  String _stateLabel(DispatchQueueEntry e) {
    if (e.terminal) {
      switch (e.status) {
        case 'completed':
          return t('dispatchStateCompleted');
        case 'failed':
          return t('dispatchStateFailed');
        case 'interrupted':
          return t('dispatchStateInterrupted');
        case 'cancelled':
          return t('dispatchStateCancelled');
      }
    }
    switch (e.queueState) {
      case 'queued':
        final pos = e.queuePosition;
        if (pos == null) return t('dispatchStateQueuedNoPos');
        final len = e.queueLength;
        return (len != null && len > 1)
            ? t('dispatchStateQueuedLen', {'pos': '$pos', 'len': '$len'})
            : t('dispatchStateQueued', {'pos': '$pos'});
      case 'started':
      case 'running':
        return t('dispatchStateRunning');
      default:
        return t('dispatchStateUnknown');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.entries.isEmpty) return const SizedBox.shrink();
    final activeCount = widget.entries.where((entry) => !entry.terminal).length;
    if (!_expanded) {
      return Semantics(
        button: true,
        label: t('dispatchQueueExpand'),
        child: Material(
          key: const Key('dispatch-queue-fab'),
          color: const Color(0xFF1f6feb),
          shape: const CircleBorder(side: BorderSide(color: Color(0xFF6aa3ff))),
          elevation: 8,
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: () => _setExpanded(true),
            child: SizedBox(
              width: 46,
              height: 46,
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  const Center(
                    child: Icon(
                      Icons.swap_vert_rounded,
                      size: 22,
                      color: Colors.white,
                    ),
                  ),
                  if (activeCount > 0)
                    Positioned(
                      key: const Key('dispatch-active-badge'),
                      right: -4,
                      top: -5,
                      child: Container(
                        constraints: const BoxConstraints(minWidth: 19),
                        height: 19,
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: const Color(0xFFd73a49),
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: const Color(0xFF0f1115)),
                        ),
                        child: Text(
                          activeCount > 99 ? '99+' : '$activeCount',
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 10,
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

    final shown = widget.entries
        .take(DispatchQueuePanel.maxRows)
        .toList(growable: false);
    final rest = widget.entries.length - shown.length;
    final viewportWidth = MediaQuery.sizeOf(context).width;
    final panelWidth = viewportWidth > 388 ? 360.0 : viewportWidth - 28;
    return Container(
      key: const Key('dispatch-queue-panel'),
      width: panelWidth,
      padding: const EdgeInsets.fromLTRB(10, 8, 8, 8),
      decoration: BoxDecoration(
        color: const Color(0xFF141a24),
        border: Border.all(color: const Color(0xFF2d4a6e)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.swap_vert_rounded,
                size: 15,
                color: Color(0xFF6aa3ff),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  t('dispatchRecentTitle', {'n': '${widget.entries.length}'}),
                  style: const TextStyle(
                    color: Color(0xFF6aa3ff),
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              if (widget.onRefresh != null)
                IconButton(
                  onPressed: () => widget.onRefresh!(),
                  icon: const Icon(Icons.refresh_rounded, size: 15),
                  tooltip: t('dispatchQueueRefresh'),
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 28,
                    minHeight: 28,
                  ),
                  color: const Color(0xFF8a909b),
                ),
              IconButton(
                onPressed: () => _setExpanded(false),
                icon: const Icon(Icons.remove_rounded, size: 17),
                tooltip: t('dispatchQueueCollapse'),
                visualDensity: VisualDensity.compact,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                color: const Color(0xFF8a909b),
              ),
            ],
          ),
          const SizedBox(height: 4),
          for (final e in shown)
            _DispatchRow(
              entry: e,
              modeLabel: _modeLabel(e.mode),
              stateLabel: _stateLabel(e),
              resolveName: widget.resolveName,
              onOpenSession: widget.onOpenSession,
            ),
          if (rest > 0)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                t('dispatchQueueMore', {'n': '$rest'}),
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
            ),
        ],
      ),
    );
  }
}

class _DispatchRow extends StatelessWidget {
  final DispatchQueueEntry entry;
  final String modeLabel;
  final String stateLabel;
  final String Function(String sessionId) resolveName;
  final ValueChanged<DispatchQueueEntry>? onOpenSession;

  const _DispatchRow({
    required this.entry,
    required this.modeLabel,
    required this.stateLabel,
    required this.resolveName,
    required this.onOpenSession,
  });

  Color get _stateColor {
    if (entry.terminal) {
      if (entry.status == 'completed') return const Color(0xFF7fd49a);
      if (entry.status == 'failed' || entry.status == 'interrupted') {
        return const Color(0xFFf85149);
      }
      return const Color(0xFF8a909b);
    }
    if (entry.isQueued) return const Color(0xFFe3b341);
    if (entry.queueState == 'started' || entry.queueState == 'running') {
      return const Color(0xFF7fd49a);
    }
    return const Color(0xFF8a909b);
  }

  @override
  Widget build(BuildContext context) {
    final incoming = entry.relation == 'target';
    final rawName = entry.counterpartId;
    final name = rawName.isEmpty
        ? t('dispatchUnknownSession')
        : resolveName(rawName);
    final dirText = incoming
        ? t('dispatchDirIn', {'name': name})
        : t('dispatchDirOut', {'name': name});
    final navigationId = entry.navigationSessionId;
    return InkWell(
      key: Key('dispatch-row-${entry.operationId}'),
      onTap: navigationId.isEmpty || onOpenSession == null
          ? null
          : () => onOpenSession!(entry),
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 5),
        child: Row(
          children: [
            Icon(
              incoming ? Icons.south_west_rounded : Icons.north_east_rounded,
              size: 14,
              color: incoming
                  ? const Color(0xFFa78bfa)
                  : const Color(0xFF6aa3ff),
            ),
            const SizedBox(width: 5),
            Expanded(
              child: Text(
                modeLabel.isEmpty ? dirText : '$dirText · $modeLabel',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 12),
              ),
            ),
            const SizedBox(width: 6),
            Text(
              stateLabel,
              style: TextStyle(color: _stateColor, fontSize: 11),
            ),
            if (navigationId.isNotEmpty && onOpenSession != null) ...[
              const SizedBox(width: 3),
              const Icon(
                Icons.chevron_right_rounded,
                size: 15,
                color: Color(0xFF6e7681),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
