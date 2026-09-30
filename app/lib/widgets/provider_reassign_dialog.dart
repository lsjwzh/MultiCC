import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/manage_service.dart';
import '../theme.dart';

/// 「批量迁移会话…」弹层 —— 与网页管理台（`public/air-provider.js` 的
/// `openReassign`）同一份契约：
///
///   1. `{dryRun:true}`                    → 有多少会话绑在这条线路上、哪些线路可用
///   2. `{targetProviderId, dryRun:true}`  → 逐会话预演（含模型替换）
///   3. `{targetProviderId}`               → 真迁移
///
/// 服务端每个会话走的都是 AI 配置弹窗那条 PATCH，所以模型替换、Auto 会话不动、
/// 忙会话下一轮生效这些口径和单会话切换完全一致。
class ProviderReassignDialog extends StatefulWidget {
  final ManageService manage;
  final Map<String, dynamic> provider;
  const ProviderReassignDialog({
    super.key,
    required this.manage,
    required this.provider,
  });

  @override
  State<ProviderReassignDialog> createState() => _ProviderReassignDialogState();
}

class _ProviderReassignDialogState extends State<ProviderReassignDialog> {
  /// 服务端 reason 码 → 文案键，与 Web 的 reassignReasonKeys 一一对应。
  static const _reasonKeys = <String, String>{
    'auto_selection': 'airProviderReassignReasonAutoSelection',
    'cli_incompatible': 'airProviderReassignReasonCliIncompatible',
    'system_session': 'airProviderReassignReasonSystemSession',
    'patch_rejected': 'airProviderReassignReasonPatchRejected',
  };

  Map<String, dynamic>? _plan;
  Map<String, dynamic>? _preview;
  String _target = '';
  String _error = '';
  bool _busy = false;

  String get _appType => (widget.provider['appType'] ?? 'claude').toString();
  String get _id => (widget.provider['id'] ?? '').toString();

  @override
  void initState() {
    super.initState();
    _loadPlan();
  }

  static int _int(Object? value) =>
      value is num ? value.toInt() : int.tryParse('$value') ?? 0;

  static List<Map<String, dynamic>> _list(Object? value) =>
      ((value as List?) ?? const <dynamic>[])
          .whereType<Map>()
          .map((item) => item.cast<String, dynamic>())
          .toList();

  String _reason(Map<String, dynamic> item) {
    final code = (item['reason'] ?? '').toString();
    if (code.isEmpty) return '';
    return t(_reasonKeys[code] ?? 'airProviderReassignReasonUnknown');
  }

  String _detail(Map<String, dynamic> item) {
    final bits = <String>[(item['cli'] ?? 'claude').toString()];
    final model = (item['model'] ?? '').toString();
    if (model.isNotEmpty) bits.add(model);
    return bits.join(' · ');
  }

  Future<void> _loadPlan() async {
    try {
      final plan = await widget.manage.reassignProviderSessions(
        _appType,
        _id,
        dryRun: true,
      );
      if (!mounted) return;
      setState(() => _plan = plan);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _plan = const {
          'total': 0,
          'sessions': <dynamic>[],
          'targets': <dynamic>[],
          'results': <dynamic>[],
          'otherReferences': <String, dynamic>{},
        };
        _error = t('airProviderReassignFailed', {'message': '$e'});
      });
    }
  }

  Future<void> _pickTarget(String? id) async {
    setState(() {
      _target = id ?? '';
      _preview = null;
      _error = '';
    });
    if (_target.isEmpty) return;
    try {
      final preview = await widget.manage.reassignProviderSessions(
        _appType,
        _id,
        targetProviderId: _target,
        dryRun: true,
      );
      if (!mounted) return;
      setState(() => _preview = preview);
    } catch (e) {
      if (!mounted) return;
      setState(
        () => _error = t('airProviderReassignFailed', {'message': '$e'}),
      );
    }
  }

  Future<void> _apply() async {
    if (_target.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final result = await widget.manage.reassignProviderSessions(
        _appType,
        _id,
        targetProviderId: _target,
      );
      if (!mounted) return;
      final skipped = _list(
        result['results'],
      ).where((item) => item['status'] == 'skipped').toList();
      final deferred = _int(result['deferred']);
      var summary = t('airProviderReassignDone', {
        'count': '${_int(result['switched'])}',
        'skipped': '${_int(result['skipped'])}',
      });
      if (deferred > 0) {
        summary += t('airProviderReassignDoneDeferred', {'count': '$deferred'});
      }
      if (skipped.isNotEmpty) {
        final items = skipped
            .map((item) {
              final reason = _reason(item);
              return '${item['label']}('
                  '${reason.isEmpty ? t('airProviderReassignReasonUnknown') : reason})';
            })
            .join(t('airProviderListSeparator'));
        summary +=
            ' · ${t('airProviderReassignSkippedList', {'items': items})}';
      }
      Navigator.pop(context, summary);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = t('airProviderReassignFailed', {'message': '$e'});
      });
    }
  }

  /// 与 Web 的 `group()` 同形：标题带条数，可选的脚注，逐行「名字 + 等宽细节」。
  Widget _group(
    String title,
    List<Map<String, dynamic>> rows, {
    String note = '',
  }) {
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '$title · ${rows.length}',
            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
          ),
          if (note.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                note,
                style: const TextStyle(color: AppColors.muted, fontSize: 11),
              ),
            ),
          const SizedBox(height: 6),
          for (final row in rows)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      (row['label'] ?? '').toString(),
                      style: const TextStyle(fontSize: 12),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if ((row['detail'] ?? '').toString().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(left: 8),
                      child: Text(
                        (row['detail']).toString(),
                        style: const TextStyle(
                          fontSize: 11.5,
                          fontFamily: 'monospace',
                          color: AppColors.muted,
                        ),
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// 目标下拉：只列服务端算过「至少有一个会话搬得过去」的线路，选项里带上条数，
  /// 用户不用点开就知道这条目标会漏掉谁。
  Widget _targetPicker(List<Map<String, dynamic>> targets) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            t('airProviderReassignTargetLabel'),
            style: const TextStyle(
              color: AppColors.muted,
              fontSize: 12.5,
              fontWeight: FontWeight.w500,
            ),
          ),
          DropdownButtonFormField<String>(
            key: const ValueKey('provider-reassign-target'),
            value: _target.isEmpty ? null : _target,
            isExpanded: true,
            dropdownColor: AppColors.panel2,
            style: const TextStyle(color: AppColors.text, fontSize: 13),
            hint: Text(
              targets.isEmpty
                  ? t('airProviderReassignNoTargets')
                  : t('airProviderReassignTargetPlaceholder'),
              style: const TextStyle(color: AppColors.faint, fontSize: 13),
            ),
            decoration: InputDecoration(
              filled: true,
              fillColor: AppColors.panel2,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 12,
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: AppColors.line),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: AppColors.accent),
              ),
            ),
            items: [
              for (final item in targets)
                DropdownMenuItem<String>(
                  value: item['id'].toString(),
                  child: Text(
                    t('airProviderReassignTargetOption', {
                      'name': (item['name'] ?? item['id']).toString(),
                      'count': '${_int(item['compatibleSessions'])}',
                    }),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
            onChanged: targets.isEmpty ? null : _pickTarget,
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final plan = _plan;
    final preview = _preview;
    final sessions = _list(plan?['sessions']);
    final targets = _list(plan?['targets']);
    final previewResults = _list(preview?['results']);

    // 有预演就按预演画（每行带切换后的模型），否则画 dry-run 清单。
    final rows = previewResults.isNotEmpty
        ? previewResults
              .map(
                (item) => <String, dynamic>{
                  'status': item['status'],
                  'label': item['label'],
                  'detail': [
                    _detail(item),
                    if (item['modelReset'] == true)
                      t('airProviderReassignModelReset', {
                        'from': (item['modelBefore'] ?? '').toString().isEmpty
                            ? t('airProviderReassignModelDefault')
                            : item['modelBefore'].toString(),
                        'to': (item['modelAfter'] ?? '').toString().isEmpty
                            ? t('airProviderReassignModelDefault')
                            : item['modelAfter'].toString(),
                      }),
                  ].where((bit) => bit.isNotEmpty).join(' · '),
                },
              )
              .toList()
        : sessions
              .map(
                (item) => <String, dynamic>{
                  'status': (item['reason'] ?? '').toString().isEmpty
                      ? 'bound'
                      : 'skipped',
                  'label': item['label'],
                  'detail': (item['reason'] ?? '').toString().isEmpty
                      ? _detail(item)
                      : _reason(item),
                },
              )
              .toList();

    final other = ((plan?['otherReferences'] as Map?) ?? const {})
        .cast<String, dynamic>();
    final otherCount = [
      'auto_candidate',
      'subagent',
      'default',
      'aux',
    ].fold<int>(0, (sum, kind) => sum + _int(other[kind]));

    return AlertDialog(
      backgroundColor: AppColors.panel,
      title: Text(
        t('airProviderReassignTitle', {
          'name': (widget.provider['name'] ?? _id).toString(),
        }),
      ),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                t('airProviderReassignIntro'),
                style: const TextStyle(
                  color: AppColors.muted,
                  fontSize: 12.5,
                  height: 1.45,
                ),
              ),
              if (plan == null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    t('airProviderReassignLoading'),
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 12,
                    ),
                  ),
                )
              else if (_int(plan['total']) == 0)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    t('airProviderReassignEmpty'),
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 12,
                    ),
                  ),
                )
              else ...[
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    t('airProviderReassignCount', {
                      'count': '${_int(plan['total'])}',
                    }),
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
                if (otherCount > 0)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      t('airProviderReassignOtherRefs', {
                        'count': '$otherCount',
                      }),
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 11.5,
                      ),
                    ),
                  ),
                _group(
                  t('airProviderReassignBoundTitle'),
                  rows,
                  note: t('airProviderReassignModelNote'),
                ),
                _targetPicker(targets),
                if (preview != null) ...[
                  _group(
                    t('airProviderReassignWillSwitch'),
                    rows.where((row) => row['status'] == 'switched').toList(),
                    note: _int(preview['deferred']) > 0
                        ? t('airProviderReassignDeferredCount', {
                            'count': '${_int(preview['deferred'])}',
                          })
                        : '',
                  ),
                  _group(
                    t('airProviderReassignWillSkip'),
                    rows.where((row) => row['status'] == 'skipped').toList(),
                  ),
                ],
                if (plan['truncated'] == true)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      t('airProviderReassignTruncated', {
                        'count': '${sessions.length}',
                      }),
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 11.5,
                      ),
                    ),
                  ),
              ],
              if (_error.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    _error,
                    style: const TextStyle(
                      color: AppColors.danger,
                      fontSize: 12,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(
            t('airProviderReassignClose'),
            style: const TextStyle(color: AppColors.muted),
          ),
        ),
        FilledButton(
          onPressed: (_target.isNotEmpty && !_busy) ? _apply : null,
          style: FilledButton.styleFrom(backgroundColor: AppColors.accentDark),
          child: Text(t('airProviderReassignConfirm')),
        ),
      ],
    );
  }
}
