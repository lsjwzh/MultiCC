import 'package:flutter/material.dart';

import '../models/task_board.dart';
import '../theme.dart';

String _runStateLabel(String state) => switch (state) {
  'queued' => '排队中',
  'leasing' => '分配执行槽',
  'context_building' => '构建上下文',
  'running' => '执行中',
  'finalizing' => '保存结果',
  'usage_sealing' => '结算用量',
  'cleaning' => '清理中',
  'succeeded' => '已完成',
  'failed' => '失败',
  'cancelled' => '已取消',
  'interrupted' => '已中断',
  _ => '状态未知',
};

Color _runStateColor(String state) => switch (state) {
  'succeeded' => AppColors.codex,
  'failed' || 'interrupted' => AppColors.danger,
  'running' ||
  'context_building' ||
  'finalizing' ||
  'usage_sealing' => AppColors.accent,
  'queued' || 'leasing' => AppColors.blue,
  _ => AppColors.muted,
};

String _cleanupLabel(String state) => switch (state) {
  'done' => '已清理',
  'deleting' || 'cleaning' || 'running' => '清理中',
  _ => '待清理',
};

typedef TaskRunAnswerCallback =
    Future<void> Function(
      TaskRunSummary run,
      TaskRunPendingQuestion question,
      String text,
      String clientMsgId,
    );

var _answerNonce = 0;

String _answerClientId(String requestId) {
  _answerNonce += 1;
  final now = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
  final suffix = requestId.length <= 12
      ? requestId
      : requestId.substring(requestId.length - 12);
  return 'tb-answer-$now-${_answerNonce.toRadixString(36)}-$suffix';
}

/// Compact, task-owned execution history. It has no session opener by design:
/// execution slots are resource-pool internals, not traditional chat sessions.
class TaskRunSummaryList extends StatelessWidget {
  final List<TaskRunSummary> runs;
  final TaskRunAnswerCallback? onAnswer;

  const TaskRunSummaryList({super.key, required this.runs, this.onAnswer});

  List<TaskRunSummary> get _recentRuns {
    final sorted = [...runs]
      ..sort((a, b) {
        final byStarted = b.startedAt.compareTo(a.startedAt);
        return byStarted != 0 ? byStarted : b.runId.compareTo(a.runId);
      });
    return sorted.take(5).toList(growable: false);
  }

  @override
  Widget build(BuildContext context) {
    final recent = _recentRuns;
    if (recent.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            '最近执行',
            style: TextStyle(
              color: AppColors.muted,
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
            ),
          ),
          const SizedBox(height: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 230),
            child: SingleChildScrollView(
              child: Column(
                children: [
                  for (final run in recent)
                    _TaskRunCard(run: run, onAnswer: onAnswer),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TaskRunCard extends StatelessWidget {
  final TaskRunSummary run;
  final TaskRunAnswerCallback? onAnswer;

  const _TaskRunCard({required this.run, this.onAnswer});

  @override
  Widget build(BuildContext context) {
    final usage = run.usage;
    final known = usage.hasKnownUsage && usage.totalTokens != null;
    final cleanup = _cleanupLabel(run.cleanupState);
    return Container(
      key: ValueKey('task-run-summary-${run.runId}'),
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.bgSoft,
        border: Border.all(
          color: run.cleanupState == 'error'
              ? AppColors.danger.withValues(alpha: 0.65)
              : AppColors.line,
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  _runStateLabel(run.executionStatus),
                  style: TextStyle(
                    color: _runStateColor(run.executionStatus),
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              Text(
                known ? '${usage.totalTokens} tokens' : '未观测',
                style: const TextStyle(color: AppColors.text, fontSize: 10.5),
              ),
              const SizedBox(width: 8),
              Text(
                cleanup,
                style: TextStyle(
                  color: run.cleanupState == 'error'
                      ? AppColors.danger
                      : AppColors.faint,
                  fontSize: 10,
                ),
              ),
            ],
          ),
          if (usage.dimensions.isNotEmpty) ...[
            const SizedBox(height: 5),
            for (final dimension in usage.dimensions)
              _ProviderUsageRow(dimension: dimension),
          ],
          if (run.pendingQuestion case final question?) ...[
            const SizedBox(height: 8),
            _TaskRunQuestion(run: run, question: question, onAnswer: onAnswer),
          ],
        ],
      ),
    );
  }
}

class _TaskRunQuestion extends StatefulWidget {
  final TaskRunSummary run;
  final TaskRunPendingQuestion question;
  final TaskRunAnswerCallback? onAnswer;

  const _TaskRunQuestion({
    required this.run,
    required this.question,
    required this.onAnswer,
  });

  @override
  State<_TaskRunQuestion> createState() => _TaskRunQuestionState();
}

class _TaskRunQuestionState extends State<_TaskRunQuestion> {
  final TextEditingController _controller = TextEditingController();
  final Set<String> _selected = <String>{};
  bool _sending = false;
  bool _resolved = false;
  String _lastAnswer = '';
  String _clientMsgId = '';
  String? _result;
  bool _resultIsError = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit(String rawText) async {
    final text = rawText.trim();
    final callback = widget.onAnswer;
    if (text.isEmpty || callback == null || _sending || _resolved) return;
    if (_clientMsgId.isEmpty || _lastAnswer != text) {
      _clientMsgId = _answerClientId(widget.question.requestId);
      _lastAnswer = text;
    }
    setState(() {
      _sending = true;
      _result = '发送中…';
      _resultIsError = false;
    });
    try {
      await callback(widget.run, widget.question, text, _clientMsgId);
      if (!mounted) return;
      setState(() {
        _sending = false;
        _resolved = true;
        _result = '回答已发送';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _resultIsError = true;
        _result = error.toString();
      });
    }
  }

  void _toggleOption(String option, bool selected) {
    if (_sending || _resolved) return;
    setState(() {
      if (selected) {
        _selected.add(option);
      } else {
        _selected.remove(option);
      }
    });
  }

  void _submitComposed() {
    final answers = <String>[..._selected];
    final custom = _controller.text.trim();
    if (custom.isNotEmpty) answers.add(custom);
    _submit(answers.join(', '));
  }

  @override
  Widget build(BuildContext context) {
    final question = widget.question;
    final enabled = widget.onAnswer != null && !_sending && !_resolved;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.accent.withValues(alpha: 0.45)),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '需要你的回答',
              style: TextStyle(
                color: AppColors.accent,
                fontSize: 10,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 3),
            Text(
              question.question,
              style: const TextStyle(color: AppColors.text, fontSize: 12),
            ),
            if (question.reason.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(
                question.reason,
                style: const TextStyle(color: AppColors.faint, fontSize: 10),
              ),
            ],
            if (question.options.isNotEmpty) ...[
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  for (final option in question.options)
                    if (question.allowMultiple)
                      FilterChip(
                        key: Key('task-run-answer-option-$option'),
                        label: Text(option),
                        selected: _selected.contains(option),
                        onSelected: enabled
                            ? (selected) => _toggleOption(option, selected)
                            : null,
                      )
                    else
                      ActionChip(
                        key: Key('task-run-answer-option-$option'),
                        label: Text(option),
                        onPressed: enabled ? () => _submit(option) : null,
                      ),
                ],
              ),
            ],
            const SizedBox(height: 6),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: _controller,
                    enabled: enabled,
                    minLines: 1,
                    maxLines: 3,
                    style: const TextStyle(color: AppColors.text, fontSize: 11),
                    decoration: const InputDecoration(
                      hintText: '也可以输入自定义回答',
                      isDense: true,
                    ),
                    onSubmitted: (_) => _submitComposed(),
                  ),
                ),
                const SizedBox(width: 6),
                FilledButton(
                  onPressed: enabled ? _submitComposed : null,
                  child: const Text('回答'),
                ),
              ],
            ),
            if (_result case final result?) ...[
              const SizedBox(height: 4),
              Text(
                result,
                style: TextStyle(
                  color: _resultIsError ? AppColors.danger : AppColors.codex,
                  fontSize: 10,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ProviderUsageRow extends StatelessWidget {
  final TaskRunUsageDimension dimension;

  const _ProviderUsageRow({required this.dimension});

  @override
  Widget build(BuildContext context) {
    final known = dimension.observedEvents > 0;
    final provider = dimension.model.isEmpty
        ? dimension.providerName
        : '${dimension.providerName} · ${dimension.model}';
    return Padding(
      key: ValueKey(
        'task-run-provider-${dimension.providerId}-${dimension.model}',
      ),
      padding: const EdgeInsets.only(top: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            provider,
            style: const TextStyle(color: AppColors.blue, fontSize: 10),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          Text(
            known
                ? '输入 ${dimension.freshInput} · 缓存读 ${dimension.cacheRead} · '
                      '缓存写 ${dimension.cacheWrite} · 输出 ${dimension.output} · '
                      '推理 ${dimension.reasoning}'
                : '未观测',
            style: const TextStyle(color: AppColors.faint, fontSize: 9.5),
          ),
        ],
      ),
    );
  }
}
