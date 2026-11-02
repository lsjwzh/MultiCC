import 'dart:convert';

import 'package:flutter/material.dart';
import '../i18n.dart';
import '../utils/format.dart';

String contextSourceLabel(String mode) {
  if (!mode.startsWith('memory:')) return t('usageContextPolicy');
  const names = {
    'builtin': 'Builtin',
    'machine': 'Machine',
    'cli': 'Cli',
    'shared': 'Shared',
    'task': 'Task',
    'own': 'Own',
    'skill': 'Skill',
    'withdrawn': 'Withdrawn',
  };
  return t('usageContextMemory${names[mode.substring(7)] ?? 'Task'}');
}

String contextSourceMeta(Map source) {
  final version = '${source['version'] ?? ''}';
  return '${source['retained'] == true ? ' · ${t('usageContextRetained')}' : ''}'
      '${source['truncated'] == true ? ' · ${t('usageContextTruncated')}' : ''}'
      '${version.isNotEmpty ? ' · v ${version.substring(0, version.length.clamp(0, 12))}' : ''}';
}

// ── 本轮引用来源（contextTrace）的两种形态 ─────────────────────────────────
//
// 旧消息内嵌的是完整对象（sources/retained/omitted/diagnostics 都在）；新消息
// 只内嵌摘要 `{summary: true, count: N, ...}`，明细要拿 traceId 去
// GET /api/sessions/:id/context 现拉。下面这几个函数是两种形态的唯一分流点：
// 底部条的数量、弹窗要不要去拉明细、明细里的数量，都从这儿取，别各自再猜一遍。

/// 摘要形态：只有 count，没有 sources 明细。
bool contextTraceIsSummary(Map? trace) => trace?['summary'] == true;

List<Map<String, dynamic>> contextTraceSources(Map? trace) {
  final raw = trace?['sources'];
  if (raw is! List) return const [];
  return raw
      .whereType<Map>()
      .map((value) => Map<String, dynamic>.from(value))
      .toList();
}

/// 引用来源数（含当前任务本身）。摘要用服务端给的 `count`；完整对象照旧数 sources。
int contextTraceCount(Map? trace) {
  if (trace == null) return 0;
  if (contextTraceIsSummary(trace)) {
    final raw = trace['count'];
    final n = raw is num ? raw.toInt() : int.tryParse('${raw ?? ''}');
    if (n != null && n >= 0) return n;
  }
  return 1 + contextTraceSources(trace).length;
}

/// 手里的 trace 是否还需要去服务端拉明细：摘要必须拉；完整对象带 sources 时也拉
/// （为了 include=messages 的消息正文），与旧行为一致。
bool contextTraceNeedsDetail(Map? trace) =>
    trace != null &&
    (contextTraceIsSummary(trace) || contextTraceSources(trace).isNotEmpty);

/// 摘要 + 拉回来的明细 → 要画的 trace。明细里没有的字段（理论上不会）沿用摘要的，
/// 且 `summary` 只认明细自己的说法；手里本来就是完整对象时，明细原样替换它。
Map<String, dynamic> contextTraceExpanded(
  Map<String, dynamic> base,
  Map<String, dynamic> full,
) {
  if (!contextTraceIsSummary(base)) return full;
  return {...base, ...full, 'summary': full['summary'] == true};
}

/// `omittedCounts`：按原因统计的省略数（"not_relevant" 只出现在这里，不再逐条列在
/// omitted 里）。非正数/非数字的条目丢掉。
Map<String, int> contextOmittedCounts(Map? trace) {
  final raw = trace?['omittedCounts'];
  if (raw is! Map) return const {};
  final out = <String, int>{};
  raw.forEach((reason, value) {
    final n = value is num ? value.toInt() : int.tryParse('${value ?? ''}');
    if (n != null && n > 0) out['$reason'] = n;
  });
  return out;
}

/// 省略原因码 → 本地化文案；不认识的原因码原样显示。
String contextOmitReasonLabel(String reason) {
  const keys = {
    'not_relevant': 'usageContextOmitReasonNotRelevant',
    'budget': 'usageContextOmitReasonBudget',
    'duplicate': 'usageContextOmitReasonDuplicate',
    'duplicate_in_native': 'usageContextOmitReasonDuplicateNative',
  };
  final key = keys[reason];
  return key == null ? reason : t(key);
}

/// 省略总数 = 逐条列出的 + 只在 omittedCounts 里统计的。某个原因的统计数超出
/// 已逐条列出的部分才算新增，这样无论 omittedCounts 是否把已列出的原因也统计
/// 在内，都不会重复计数。
int contextOmittedTotal(List omitted, Map<String, int> counts) {
  var extra = 0;
  counts.forEach((reason, n) {
    final listed = omitted
        .whereType<Map>()
        .where((source) => '${source['reason']}' == reason)
        .length;
    if (n > listed) extra += n - listed;
  });
  return omitted.length + extra;
}

class ContextBudgetDetails extends StatelessWidget {
  final Map<String, dynamic> trace;
  const ContextBudgetDetails({super.key, required this.trace});
  @override
  Widget build(BuildContext context) {
    final budget = trace['budget'] as Map? ?? {};
    final title = t('usageContextBudget', {
      'used': '${budget['used'] ?? 0}',
      'limit': '${budget['limit'] ?? 0}',
    });
    // 摘要里没有 retained/omitted 明细：不能把「沿用 0 项 · 省略 0 项」当事实
    // 画出来，只给预算一行，明细拉回来后再换成可展开的完整版。
    if (contextTraceIsSummary(trace)) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(title, style: const TextStyle(fontSize: 11)),
      );
    }
    final omitted = trace['omitted'] as List? ?? [];
    final retained = trace['retained'] as List? ?? [];
    final diagnostics = trace['diagnostics'] as List? ?? [];
    final omittedCounts = contextOmittedCounts(trace);
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      title: Text(title, style: const TextStyle(fontSize: 11)),
      subtitle: Text(
        t('usageContextSelection', {
          'kept': '${retained.length}',
          'omitted': '${contextOmittedTotal(omitted, omittedCounts)}',
        }),
        style: const TextStyle(fontSize: 10),
      ),
      children: [
        for (final source in retained.whereType<Map>())
          ListTile(
            dense: true,
            title: Text('${source['taskName'] ?? source['id']}'),
            subtitle: Text(t('usageContextRetained')),
          ),
        for (final entry in omittedCounts.entries)
          ListTile(
            dense: true,
            title: Text(
              t('usageContextOmittedCount', {
                'reason': contextOmitReasonLabel(entry.key),
                'n': '${entry.value}',
              }),
            ),
          ),
        for (final source in omitted.whereType<Map>())
          ListTile(
            dense: true,
            title: Text('${source['id']}'),
            subtitle: Text('${source['reason']}'),
          ),
        for (final source in diagnostics.whereType<Map>())
          ListTile(
            dense: true,
            title: Text('${source['path'] ?? ''}'),
            subtitle: Text('${source['reason']}'),
          ),
      ],
    );
  }
}

String _contextSourceMode(dynamic value) {
  final mode = value?.toString() ?? '';
  if (mode == 'refilled') return t('usageContextRefilled');
  if (RegExp(r'^(memory|context|task):').hasMatch(mode)) {
    return contextSourceLabel(mode);
  }
  // 任务图谱上下文的引用来源：mode 形如 graph:parent / graph:memory。
  final graph = RegExp(r'^graph:(.+)$').firstMatch(mode);
  if (graph != null) {
    final key =
        'usageContextGraph${graph.group(1)![0].toUpperCase()}${graph.group(1)!.substring(1)}';
    final labeled = t(key);
    return labeled == key ? t('usageContextGraphTask') : labeled;
  }
  return t('usageContextImported');
}

String _contextMessageText(dynamic value) {
  if (value is String) return value;
  try {
    return jsonEncode(value);
  } catch (_) {
    return value?.toString() ?? '';
  }
}

/// 使用量弹窗里的「引用 N」区块：数量、当前任务、预算/省略、逐个来源。
///
/// [trace] 可以是摘要（只有数量与当前任务，[loading] 时配进度条、[error] 非空时
/// 配错误文案），也可以是拉回来的完整明细或旧消息内嵌的完整对象。
class ContextTraceSection extends StatelessWidget {
  final Map<String, dynamic> trace;
  final bool loading;
  final String error;
  const ContextTraceSection({
    super.key,
    required this.trace,
    this.loading = false,
    this.error = '',
  });

  @override
  Widget build(BuildContext context) {
    final current = trace['currentTask'] is Map
        ? Map<String, dynamic>.from(trace['currentTask'] as Map)
        : const <String, dynamic>{};
    final sources = contextTraceSources(trace);
    final expired = trace['detailExpired'] == true;
    final children = <Widget>[
      const Divider(color: Color(0xFFdce6f1), height: 20),
      Row(
        children: [
          const Icon(Icons.link, size: 14, color: Color(0xFF005cc5)),
          const SizedBox(width: 5),
          Text(
            t('usageContextSources', {'n': '${contextTraceCount(trace)}'}),
            style: const TextStyle(color: Color(0xFF4a6076), fontSize: 12),
          ),
        ],
      ),
      if (expired) ...[
        const SizedBox(height: 4),
        Text(
          t('usageContextDetailExpired'),
          style: const TextStyle(color: Color(0xFFb4701f), fontSize: 10),
        ),
      ],
      const SizedBox(height: 7),
      Text(
        '${t('usageContextCurrent')} · ${t('usageContextNative')}',
        style: const TextStyle(color: Color(0xFF6f8096), fontSize: 10),
      ),
      SelectableText(
        (current['taskName'] ?? current['taskId'] ?? '').toString(),
        style: const TextStyle(color: Color(0xFF4a6076), fontSize: 12),
      ),
      SelectableText(
        (current['taskId'] ?? '').toString(),
        style: const TextStyle(color: Color(0xFF8a9aab), fontSize: 10),
      ),
    ];
    if (trace['budget'] is Map) {
      children.add(ContextBudgetDetails(trace: trace));
    }
    for (final source in sources) {
      children.add(_sourceTile(source, expired: expired));
    }
    if (loading) {
      children.add(
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 6),
          child: LinearProgressIndicator(minHeight: 2),
        ),
      );
    }
    if (error.isNotEmpty) {
      children.add(
        Text(
          error,
          style: const TextStyle(color: Color(0xFFb64e43), fontSize: 11),
        ),
      );
    }
    children.add(
      Padding(
        padding: const EdgeInsets.only(top: 7),
        child: Text(
          t('usageContextManagedScope'),
          style: const TextStyle(color: Color(0xFF8a9aab), fontSize: 10),
        ),
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    );
  }

  static Widget _sourceTile(
    Map<String, dynamic> source, {
    required bool expired,
  }) {
    final messages = source['messages'] is List
        ? (source['messages'] as List).whereType<Map>().toList()
        : const <Map>[];
    final count = (source['messageCount'] as num?)?.toInt() ?? messages.length;
    final tokens = (source['estimatedTokens'] as num?)?.toInt() ?? 0;
    final omitted = (source['omittedExchanges'] as num?)?.toInt() ?? 0;
    final isGraph = RegExp(
      r'^(graph|memory|task|context):',
    ).hasMatch('${source['mode']}');
    // 明细过期后沿用来源可能只剩 id/version/reason：没有 mode 就别冒充
    // 「初始化导入」或「0 条消息」，只显示它还剩的元信息。
    final stub = expired && '${source['mode'] ?? ''}'.isEmpty;
    String subtitle;
    if (stub) {
      final meta = contextSourceMeta(source);
      subtitle = meta.startsWith(' · ') ? meta.substring(3) : meta;
      if (subtitle.isEmpty) subtitle = '${source['reason'] ?? ''}';
    } else {
      subtitle =
          '${_contextSourceMode(source['mode'])}'
          '${isGraph ? '' : ' · ${t('usageContextMessages', {'n': '$count'})}'}'
          '${tokens > 0 ? ' · ${t('usageContextApproxTokens', {'n': formatCompactTokens(tokens)})}' : ''}'
          '${omitted > 0 ? ' · ${t('usageContextOmitted', {'n': '$omitted'})}' : ''}${contextSourceMeta(source)}';
    }
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      childrenPadding: const EdgeInsets.only(left: 8, bottom: 4),
      dense: true,
      title: Text(
        (source['taskName'] ?? source['taskId'] ?? source['id'] ?? '')
            .toString(),
        style: const TextStyle(color: Color(0xFF4a6076), fontSize: 12),
      ),
      subtitle: Text(
        subtitle,
        style: const TextStyle(color: Color(0xFF6f8096), fontSize: 10),
      ),
      children:
          <List<String>>[
                ...messages.map(
                  (message) => [
                    message['role'] == 'user'
                        ? t('tbRoleUser')
                        : t('tbRoleAssistant'),
                    _contextMessageText(message['content']),
                  ],
                ),
                // 图谱上下文来源没有消息，只有实际注入的那一行节选。
                if (source['excerpt'] is String &&
                    (source['excerpt'] as String).trim().isNotEmpty)
                  [
                    t('usageContextExcerpt'),
                    (source['excerpt'] as String).trim(),
                  ],
                if (source['path'] != null)
                  [t('usageContextPath'), '${source['path']}'],
                if (source['reason'] != null)
                  [t('usageContextReason'), '${source['reason']}'],
              ]
              .map(
                (pair) => Padding(
                  padding: const EdgeInsets.only(bottom: 7),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 34,
                        child: Text(
                          pair[0],
                          style: const TextStyle(
                            color: Color(0xFF8a9aab),
                            fontSize: 10,
                          ),
                        ),
                      ),
                      Expanded(
                        child: SelectableText(
                          pair[1],
                          style: const TextStyle(
                            color: Color(0xFF6f8096),
                            fontSize: 11,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              )
              .toList(),
    );
  }
}

/// 使用量弹窗里的来源区：[trace] 是手里这条消息内嵌的（摘要，或旧的完整对象）。
///
/// 需要明细时（见 [contextTraceNeedsDetail]）调用一次 [load] 拉完整对象再换上；
/// 拉取中画进度条，失败时退回手里的 trace 并给出错误文案 —— 摘要至少还能显示
/// 数量和当前任务。不需要明细（没有 sources 的完整对象）就不发请求。
class ContextTraceLoader extends StatefulWidget {
  final Map<String, dynamic> trace;
  final Future<Map<String, dynamic>> Function() load;
  const ContextTraceLoader({super.key, required this.trace, required this.load});

  @override
  State<ContextTraceLoader> createState() => _ContextTraceLoaderState();
}

class _ContextTraceLoaderState extends State<ContextTraceLoader> {
  // 只在 initState 里发一次：父级重建不该让一份 100KB+ 的明细再拉一遍。
  late final Future<Map<String, dynamic>>? _future =
      contextTraceNeedsDetail(widget.trace) ? widget.load() : null;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Map<String, dynamic>>(
      initialData: widget.trace,
      future: _future,
      builder: (context, snapshot) {
        // 失败时 snapshot.data 为空：不能连来源区一起丢掉。
        final data = snapshot.data;
        final trace = data == null
            ? widget.trace
            : contextTraceExpanded(widget.trace, data);
        return ContextTraceSection(
          trace: trace,
          loading: snapshot.connectionState == ConnectionState.waiting,
          error: snapshot.hasError ? t('usageContextLoadFailed') : '',
        );
      },
    );
  }
}
