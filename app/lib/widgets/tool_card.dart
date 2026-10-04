import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../models/tool_input_view.dart';
import '../utils/cli_display.dart';
import 'run_config/run_labels.dart';

const Map<String, String> _kToolIcons = {
  'Bash': '>_',
  'Read': '📄',
  'Edit': '✏️',
  'Write': '💾',
  'Glob': '🔍',
  'Grep': '🔎',
  'Agent': '🤖',
  'WebFetch': '🌐',
  'WebSearch': '🌐',
};

String toolIconFor(String name) => _kToolIcons[name] ?? '⚙️';

/// Short status/description line for a tool call, shared by the card and the
/// compact rows in [ToolCallGroup]. Mirrors the web tool-desc lifecycle: while
/// running the input summary (command / file_path / …) is shown; once done it
/// is replaced by the outcome plus the measured wall-clock duration — "done ·
/// 1.5s" — and only when both timing stamps exist. Legacy history without tool
/// timing degrades to the bare "done"/"failed" (never a fabricated 0ms).
String toolDescriptionFor(ToolCall tc, {int max = 60}) {
  if (!tc.isDone) {
    final d = tc.description;
    if (d.isNotEmpty) return d.length > max ? '${d.substring(0, max)}…' : d;
    return 'running…';
  }
  final base = tc.isError ? 'failed' : 'done';
  final dur = humanizeToolDuration(tc.durationMs);
  return dur.isEmpty ? base : '$base · $dur';
}

class ToolCardWidget extends StatefulWidget {
  final ToolCall toolCall;
  const ToolCardWidget({super.key, required this.toolCall});

  @override
  State<ToolCardWidget> createState() => _ToolCardWidgetState();
}

class _ToolCardWidgetState extends State<ToolCardWidget> {
  bool _expanded = false;

  String get _icon => toolIconFor(widget.toolCall.name);

  String get _description => toolDescriptionFor(widget.toolCall);

  String _prettyInput() {
    // Typed preview (Bash → "$ cmd", Read → file path, Edit → old/new diff,
    // …) mirroring the web's renderToolInput; raw text when the JSON is
    // incomplete (mid-stream) or unparsable.
    final parsed = widget.toolCall.parsedInput;
    if (parsed != null) return renderToolInput(widget.toolCall.name, parsed);
    return widget.toolCall.inputJson;
  }

  @override
  Widget build(BuildContext context) {
    final isError = widget.toolCall.isError;
    final isDone = widget.toolCall.isDone;

    return Container(
      margin: const EdgeInsets.only(top: 8),
      decoration: BoxDecoration(
        border: Border.all(color: const Color(0xFFdce6f1)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header (tap to expand)
          GestureDetector(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFFf8fbff),
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(7),
                  topRight: const Radius.circular(7),
                  bottomLeft: _expanded ? Radius.zero : const Radius.circular(7),
                  bottomRight: _expanded ? Radius.zero : const Radius.circular(7),
                ),
              ),
              child: Row(
                children: [
                  Text(_icon, style: const TextStyle(fontSize: 14)),
                  const SizedBox(width: 8),
                  Text(
                    widget.toolCall.name,
                    style: const TextStyle(
                      color: Color(0xFF1267b5),
                      fontWeight: FontWeight.w600,
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _description,
                      style: TextStyle(
                        color: isDone
                            ? (isError ? const Color(0xFFb64e43) : const Color(0xFF1e8a55))
                            : const Color(0xFF6f8096),
                        fontSize: 12,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 4),
                  if (!isDone)
                    const SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.5,
                        color: Color(0xFF1267b5),
                      ),
                    ),
                  Icon(
                    _expanded ? Icons.chevron_right_rounded : Icons.chevron_right_rounded,
                    color: const Color(0xFF8a9aab),
                    size: 16,
                  ),
                ],
              ),
            ),
          ),

          // Body (expanded)
          if (_expanded)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: const BoxDecoration(
                color: Color(0xFFf4f8fd),
                border: Border(top: BorderSide(color: Color(0xFFf8fbff))),
                borderRadius: BorderRadius.only(
                  bottomLeft: Radius.circular(7),
                  bottomRight: Radius.circular(7),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (widget.toolCall.inputJson.isNotEmpty) ...[
                    const Text(
                      'Input:',
                      style: TextStyle(fontSize: 11, color: Color(0xFF8a9aab), fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 4),
                    SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Text(
                        _prettyInput(),
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 12,
                          color: Color(0xFF6f8096),
                          height: 1.5,
                        ),
                      ),
                    ),
                  ],
                  // Thinking 的 result 就是它自己的正文（上面已经显示过），不再重复一遍。
                  if (widget.toolCall.result != null &&
                      (isError || widget.toolCall.name != 'Thinking')) ...[
                    const SizedBox(height: 8),
                    Text(
                      isError ? 'Error:' : 'Result:',
                      style: TextStyle(
                        fontSize: 11,
                        color: isError ? const Color(0xFFb64e43) : const Color(0xFF1e8a55),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Container(
                      constraints: const BoxConstraints(maxHeight: 200),
                      child: SingleChildScrollView(
                        child: Text(
                          _truncate(widget.toolCall.result!, 2000),
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 12,
                            color: Color(0xFF6f8096),
                            height: 1.5,
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }

  String _truncate(String s, int max) => s.length > max ? '${s.substring(0, max)}…' : s;
}

/// [attribution] 的展示名：车道/线路/模型，各自非空才占一段；空表 = 没有可说的。
///
/// 车道复用 `cli_display.dart` 的展示表（未知 id 回落成 id 本身）；线路复用
/// `run_config/run_labels.dart` 的 `providerDisplayLabel`（catalog 里没有时用服务端随消息
/// 下发的 `providerName`，再退到 id —— 与聊天头部那颗胶囊同一套说法）。
List<String> modelAttributionSegments(ModelAttribution? attribution) {
  if (attribution == null) return const [];
  final segments = <String>[];
  final cli = attribution.cli;
  if (cli != null && cli.isNotEmpty) {
    final name = cliDisplayName(cli);
    if (name.isNotEmpty) segments.add(name);
  }
  final providerId = attribution.providerId ?? '';
  final providerName = attribution.providerName ?? '';
  if (providerId.isNotEmpty || providerName.isNotEmpty) {
    final name = providerDisplayLabel(
      providerId,
      providers: const <Map<String, dynamic>>[],
      resolved: providerName.isEmpty ? null : providerName,
      model: attribution.model,
    );
    if (name.isNotEmpty) segments.add(name);
  }
  final model = attribution.model;
  if (model != null && model.isNotEmpty) segments.add(model);
  return segments;
}

/// 「由 <车道> · <线路> · <模型> 产出」那一小段字。
///
/// 它是**搭车**显示的：贴到页脚某一行（轨迹的「N tools · 时长 wall-clock」文案
/// 行，或 🕐/⏱ 时间行）的最右端，不额外占一行 —— 那些行右边本来就是空的。靠右由
/// 宿主行负责（Flutter 侧是 Row 的 spaceBetween，Web 侧是 flex 的 margin-left:auto），
/// 这里只管这段字本身：弱化小字 + 悬停说明 + 窄屏省略号。
///
/// [segments] 为空 = 没有可说的，返回空壳；调用方**不该**把它塞进宿主行 ——
/// 那会多出一个空的 flex 项，把那一行的排布也带歪。
class ModelAttributionLabel extends StatelessWidget {
  const ModelAttributionLabel({super.key, required this.segments});

  /// 非空的展示名，由 [modelAttributionSegments] 给出。
  final List<String> segments;

  @override
  Widget build(BuildContext context) {
    if (segments.isEmpty) return const SizedBox.shrink();
    return Tooltip(
      message: t('chatModelAttributionHint'),
      child: Text(
        t('chatModelAttribution', {'what': segments.join(' · ')}),
        key: const ValueKey('message-model-attribution'),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(color: Color(0xFF6f8096), fontSize: 11),
      ),
    );
  }
}

/// 测量完整（起止都在、结束不早于开始）的工具段加上服务端时间轴里的模型段
/// （请求 / 思考 / 输出）合计至少两段，才会画出轨迹条 —— 也是那行
/// 「⏱ N tools · 时长 wall-clock」文案的成立条件（两者同生共死）。
/// 模型归属要搭在那一行上，落点判定因此得先问这一句。
bool hasTrajectoryContent(List<ToolCall> toolCalls, [TurnTimeline? timeline]) =>
    _measuredTools(toolCalls, timeline).length + (timeline?.spans.length ?? 0) >= 2;

/// 有时间轴时 Thinking 伪工具不再单独画：思考段已经由时间轴给出（与 Web 同规则）。
List<ToolCall> _measuredTools(List<ToolCall> toolCalls, [TurnTimeline? timeline]) => toolCalls
    .where((tool) {
      final startedAt = tool.startedAt;
      final endedAt = tool.endedAt;
      if (timeline != null && tool.name == 'Thinking') return false;
      return startedAt != null && endedAt != null && endedAt >= startedAt;
    })
    .toList(growable: false);

const _timelineColors = <String, Color>{
  'request': Color(0x8Cd29922),
  'thinking': Color(0xFFa371f7),
  'output': Color(0xFF3fb950),
};

/// Turn-internal trajectory, matching the Web strip.
///
/// Each measured span is positioned at its real start offset and sized by its
/// duration inside the wall-clock window. With a server [timeline] (every
/// lane) the window starts at the turn submit time and the model's own
/// stretches — request in flight, thinking, output — are drawn next to the
/// tools, so no part of the turn is unexplained. Without one (legacy history)
/// the window runs from the earliest tool start, stretched to
/// [turnDurationMs] when that is longer. Fewer than two measured spans stay
/// hidden instead of fabricating a flat or zero-duration timeline.
class ToolTrajectory extends StatelessWidget {
  final List<ToolCall> toolCalls;

  /// 整轮墙钟时长（用户发出 → AI 回复完成），包含大模型请求时间。缺省时退回
  /// 工具自身最早开始 → 最晚结束那段窗口。
  final int? turnDurationMs;

  /// 服务端时间轴（请求 / 思考 / 输出段 + 轮次起点）。老历史为 null。
  final TurnTimeline? timeline;

  /// 这条回复的模型归属，贴在文案行的**最右端**（不额外占一行）。缺省/null
  /// （老历史、服务端没说话、或归属已经贴在别处）时这一块与从前一字不差。
  final ModelAttribution? attribution;
  const ToolTrajectory({
    super.key,
    required this.toolCalls,
    this.turnDurationMs,
    this.timeline,
    this.attribution,
  });

  @override
  Widget build(BuildContext context) {
    final tl = timeline;
    final measured = _measuredTools(toolCalls, tl);
    final modelSpans = tl?.spans ?? const <TimelineSpan>[];
    if (measured.length + modelSpans.length < 2) return const SizedBox.shrink();

    final starts = [
      ...measured.map((tool) => tool.startedAt!),
      ...modelSpans.map((span) => span.start),
    ];
    final ends = [
      ...measured.map((tool) => tool.endedAt!),
      ...modelSpans.map((span) => span.end),
    ];
    final firstStartedAt = tl != null
        ? math.min(tl.origin, starts.reduce(math.min))
        : starts.reduce(math.min);
    final lastEndedAt = ends.reduce(math.max);
    final toolSpanMs = lastEndedAt - firstStartedAt;
    final wallClockMs = math.max(
      toolSpanMs,
      (turnDurationMs != null && turnDurationMs! > toolSpanMs)
          ? turnDurationMs!
          : 0,
    );
    final layoutSpanMs = math.max(wallClockMs, 1);
    final duration = humanizeToolDuration(wallClockMs);
    final totals = <String, int>{};
    for (final span in modelSpans) {
      totals[span.kind] = (totals[span.kind] ?? 0) + span.durationMs;
    }
    final breakdown = [
      for (final kind in TurnTimeline.kinds)
        if ((totals[kind] ?? 0) > 0)
          '$kind ${humanizeToolDuration(totals[kind]!)}',
    ];

    return Semantics(
      label: '${measured.length} tools, $duration wall-clock',
      child: Padding(
        key: const Key('tool-trajectory'),
        padding: const EdgeInsets.only(top: 6, bottom: 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            LayoutBuilder(
              builder: (context, constraints) {
                if (!constraints.hasBoundedWidth || constraints.maxWidth <= 0) {
                  return const SizedBox(height: 8);
                }
                final trackWidth = constraints.maxWidth;
                return Container(
                  key: const Key('tool-trajectory-track'),
                  height: 8,
                  clipBehavior: Clip.hardEdge,
                  decoration: BoxDecoration(
                    color: const Color(0xFFeef3f8),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Stack(
                    children: [
                      // Model spans first so tool segments paint on top.
                      for (var index = 0; index < modelSpans.length; index++)
                        _TrajectoryBar(
                          key: ValueKey(
                            'timeline-segment-$index-${modelSpans[index].kind}',
                          ),
                          start: modelSpans[index].start,
                          end: modelSpans[index].end,
                          label: modelSpans[index].kind,
                          color: _timelineColors[modelSpans[index].kind]!,
                          firstStartedAt: firstStartedAt,
                          layoutSpanMs: layoutSpanMs,
                          trackWidth: trackWidth,
                        ),
                      for (var index = 0; index < measured.length; index++)
                        _ToolTrajectorySegment(
                          key: ValueKey(
                            'tool-trajectory-segment-$index-'
                            '${measured[index].isError ? 'error' : 'ok'}',
                          ),
                          toolCall: measured[index],
                          firstStartedAt: firstStartedAt,
                          layoutSpanMs: layoutSpanMs,
                          trackWidth: trackWidth,
                        ),
                    ],
                  ),
                );
              },
            ),
            const SizedBox(height: 3),
            _labelRow(measured.length, duration, breakdown),
          ],
        ),
      ),
    );
  }

  /// 「⏱ N tools · Xs wall-clock」那一行（有时间轴时后缀各模型段合计）。模型
  /// 归属就搭在这一行的最右端 —— 页脚里这一行右边本来就是空的，不必为它多占
  /// 一行。没有归属时返回的就是从前那个孤零零的 [Text]。
  Widget _labelRow(int toolCount, String duration, List<String> breakdown) {
    final label = Text(
      ['⏱ $toolCount tools · $duration wall-clock', ...breakdown].join(' · '),
      key: const Key('tool-trajectory-label'),
      style: const TextStyle(color: Color(0xFF6f8096), fontSize: 11),
    );
    final segments = modelAttributionSegments(attribution);
    if (segments.isEmpty) return label;
    // 两段都用 Flexible：窄屏 / 大字号下各自让位（文案换行、归属省略号），
    // 谁都不越出气泡。spaceBetween 是「贴右」的机关 —— 余量全部落在两段之间，
    // 归属那一段因此顶在这一行的最右端（Web 侧是同一个意思的 margin-left:auto）。
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Flexible(child: label),
        const SizedBox(width: 10),
        Flexible(child: ModelAttributionLabel(segments: segments)),
      ],
    );
  }
}

/// One positioned bar of the strip; shared by model spans and tool segments.
class _TrajectoryBar extends StatelessWidget {
  final int start;
  final int end;
  final String label;
  final Color color;
  final int firstStartedAt;
  final int layoutSpanMs;
  final double trackWidth;

  const _TrajectoryBar({
    super.key,
    required this.start,
    required this.end,
    required this.label,
    required this.color,
    required this.firstStartedAt,
    required this.layoutSpanMs,
    required this.trackWidth,
  });

  @override
  Widget build(BuildContext context) {
    final left = ((start - firstStartedAt) / layoutSpanMs) * trackWidth;
    final rawWidth = ((end - start) / layoutSpanMs) * trackWidth;
    final remainingWidth = math.max(trackWidth - left, 0.0);
    final width = math.min(math.max(rawWidth, 2.0), remainingWidth);
    return Positioned(
      left: left,
      top: 1,
      bottom: 1,
      width: width,
      child: Tooltip(
        message: '$label · ${humanizeToolDuration(end - start)}',
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );
  }
}

class _ToolTrajectorySegment extends StatelessWidget {
  final ToolCall toolCall;
  final int firstStartedAt;
  final int layoutSpanMs;
  final double trackWidth;

  const _ToolTrajectorySegment({
    super.key,
    required this.toolCall,
    required this.firstStartedAt,
    required this.layoutSpanMs,
    required this.trackWidth,
  });

  @override
  Widget build(BuildContext context) {
    final startedAt = toolCall.startedAt!;
    final durationMs = toolCall.endedAt! - startedAt;
    final left = ((startedAt - firstStartedAt) / layoutSpanMs) * trackWidth;
    final rawWidth = (durationMs / layoutSpanMs) * trackWidth;
    final remainingWidth = math.max(trackWidth - left, 0.0);
    final width = math.min(math.max(rawWidth, 2.0), remainingWidth);
    final duration = humanizeToolDuration(durationMs);

    return Positioned(
      left: left,
      top: 1,
      bottom: 1,
      width: width,
      child: Tooltip(
        message: '${toolCall.name} · $duration',
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: (toolCall.isError
                    ? const Color(0xFFb64e43)
                    : const Color(0xFF1267b5))
                .withValues(alpha: 0.85),
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );
  }
}

/// Renders the tool calls of one assistant message. Up to [_maxVisible] are
/// shown inline as normal cards (each expandable in place). Beyond that, they
/// collapse into a fixed-height box that only lists the most recent few actions
/// as compact rows; tapping opens a bottom sheet with the full, scrollable list.
class ToolCallGroup extends StatelessWidget {
  final List<ToolCall> toolCalls;
  const ToolCallGroup({super.key, required this.toolCalls});

  static const _maxVisible = 3;

  @override
  Widget build(BuildContext context) {
    if (toolCalls.isEmpty) return const SizedBox.shrink();
    // Few enough to show in full — keep the directly-expandable cards.
    if (toolCalls.length <= _maxVisible) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: toolCalls.map((tc) => ToolCardWidget(toolCall: tc)).toList(),
      );
    }

    // Many calls: a compact, fixed-height box showing only the latest few.
    final recent = toolCalls.sublist(toolCalls.length - _maxVisible);
    final running = toolCalls.any((tc) => !tc.isDone);
    return Container(
      margin: const EdgeInsets.only(top: 8),
      decoration: BoxDecoration(
        border: Border.all(color: const Color(0xFFdce6f1)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => _openSheet(context),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: const BoxDecoration(
                color: Color(0xFFf8fbff),
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(7),
                  topRight: Radius.circular(7),
                ),
              ),
              child: Row(
                children: [
                  const Text('🔧', style: TextStyle(fontSize: 13)),
                  const SizedBox(width: 8),
                  Text(
                    '${toolCalls.length} 个工具调用',
                    style: const TextStyle(
                      color: Color(0xFF1267b5),
                      fontWeight: FontWeight.w600,
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (running)
                    const SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.5,
                        color: Color(0xFF1267b5),
                      ),
                    ),
                  const Spacer(),
                  const Text(
                    '查看全部',
                    style: TextStyle(color: Color(0xFF6f8096), fontSize: 11),
                  ),
                  const Icon(
                    Icons.unfold_more_rounded,
                    color: Color(0xFF8a9aab),
                    size: 16,
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final tc in recent) _CompactToolRow(toolCall: tc),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _openSheet(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFFffffff),
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
      ),
      builder: (_) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.6,
        minChildSize: 0.3,
        maxChildSize: 0.95,
        builder: (context, scrollCtrl) => Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 8, 6),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '工具调用 · ${toolCalls.length}',
                      style: const TextStyle(
                        color: Color(0xFF20364d),
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close, color: Color(0xFF6f8096)),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: Color(0xFFdce6f1)),
            Expanded(
              child: ListView(
                controller: scrollCtrl,
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
                children: [
                  for (final tc in toolCalls) ToolCardWidget(toolCall: tc),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One-line summary of a tool call used inside the collapsed [ToolCallGroup].
class _CompactToolRow extends StatelessWidget {
  final ToolCall toolCall;
  const _CompactToolRow({required this.toolCall});

  @override
  Widget build(BuildContext context) {
    final isDone = toolCall.isDone;
    final isError = toolCall.isError;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Text(toolIconFor(toolCall.name), style: const TextStyle(fontSize: 12)),
          const SizedBox(width: 7),
          Text(
            toolCall.name,
            style: const TextStyle(
              color: Color(0xFF1267b5),
              fontWeight: FontWeight.w600,
              fontSize: 12,
            ),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              toolDescriptionFor(toolCall, max: 48),
              style: TextStyle(
                color: isDone
                    ? (isError
                        ? const Color(0xFFb64e43)
                        : const Color(0xFF1e8a55))
                    : const Color(0xFF6f8096),
                fontSize: 11,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 6),
          if (!isDone)
            const SizedBox(
              width: 10,
              height: 10,
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: Color(0xFF1267b5),
              ),
            )
          else
            Icon(
              isError
                  ? Icons.error_outline_rounded
                  : Icons.check_circle_outline_rounded,
              size: 12,
              color: isError ? const Color(0xFFb64e43) : const Color(0xFF1e8a55),
            ),
        ],
      ),
    );
  }
}
