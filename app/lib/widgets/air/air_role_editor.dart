import 'dart:convert';

import 'package:flutter/material.dart';

import '../../services/agent_preset_service.dart';
import '../../services/air_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';

/// 任务的角色上下文 —— Web 侧是 `public/air-role-editor.js`。
///
/// 一个任务挂若干个具名角色（最多 8 个，服务端把关）：名字 + 说明，说明是真正
/// 拼进提示词的那段。可以手写，也可以从角色库里附一个。
///
/// 保存分两种：任务已经存在就写回 `/api/air/tasks/:id/roles`；任务还没创建
/// （目录下的新任务输入区）就把编辑结果交回调用方，由创建流程在发第一条消息
/// 之前写进去 —— 绑定说的是「下一条消息」，而下一条消息正是紧接着的那条。
Future<List<AirRoleBinding>?> showAirRoleEditor(
  BuildContext context, {
  required SettingsService settings,
  required List<AirRoleBinding> initial,
  String? taskId,
  int version = 0,
  Future<void> Function()? onSaved,
  AirService? service,
  AgentPresetService? presetService,
}) {
  return showDialog<List<AirRoleBinding>>(
    context: context,
    builder: (_) => _AirRoleEditorDialog(
      settings: settings,
      initial: initial,
      taskId: taskId,
      version: version,
      onSaved: onSaved,
      service: service,
      presetService: presetService,
    ),
  );
}

/// 一次「同一份内容的重试」对应一个幂等键。服务端按 (taskId, clientMsgId) 去重：
/// 内容没变就复用同一个 id，内容变了才换新的 —— 和创建流程同一套规矩。
class _RoleAttempt {
  String fingerprint = '';
  String clientMsgId = '';

  static int _seq = 0;

  String _next() =>
      'app-air-role-${DateTime.now().microsecondsSinceEpoch}-${_seq++}';

  String forBindings(List<AirRoleBinding> bindings) {
    final next = jsonEncode(bindings.map((b) => b.toJson()).toList());
    if (next != fingerprint || clientMsgId.isEmpty) {
      fingerprint = next;
      clientMsgId = _next();
    }
    return clientMsgId;
  }
}

class _Row {
  _Row({String name = '', String prompt = ''})
    : nameCtrl = TextEditingController(text: name),
      promptCtrl = TextEditingController(text: prompt);

  final TextEditingController nameCtrl;
  final TextEditingController promptCtrl;

  void dispose() {
    nameCtrl.dispose();
    promptCtrl.dispose();
  }
}

class _AirRoleEditorDialog extends StatefulWidget {
  const _AirRoleEditorDialog({
    required this.settings,
    required this.initial,
    required this.taskId,
    required this.version,
    required this.onSaved,
    required this.service,
    required this.presetService,
  });

  final SettingsService settings;
  final List<AirRoleBinding> initial;
  final String? taskId;
  final int version;
  final Future<void> Function()? onSaved;
  final AirService? service;
  final AgentPresetService? presetService;

  @override
  State<_AirRoleEditorDialog> createState() => _AirRoleEditorDialogState();
}

class _AirRoleEditorDialogState extends State<_AirRoleEditorDialog> {
  /// Web 也卡 8 个：再多就不是「附加几个角色」，而是把提示词搬进来了。
  static const _maxRows = 8;
  static const _maxPromptLength = 40000;

  final _rows = <_Row>[];
  final _attempt = _RoleAttempt();
  AirService? _owned;
  late final AgentPresetService _presetApi;
  bool _saving = false;
  String _error = '';

  /// 角色库的索引状态：null = 还没读到（下拉禁用），空列表 = 读到了但没内容，
  /// [_presetUnavailable] = 读不到，这时只能手写。
  List<AgentPresetSummary>? _presets;
  bool _presetUnavailable = false;

  bool get _draft => widget.taskId == null;

  AirService get _service => widget.service ?? (_owned ??= AirService(settings: widget.settings));

  @override
  void initState() {
    super.initState();
    for (final binding in widget.initial.take(_maxRows)) {
      _rows.add(_Row(name: binding.name, prompt: binding.prompt));
    }
    _presetApi =
        widget.presetService ?? AgentPresetService(settings: widget.settings);
    _loadPresets();
  }

  @override
  void dispose() {
    for (final row in _rows) {
      row.dispose();
    }
    if (widget.presetService == null) _presetApi.close();
    _owned?.close();
    super.dispose();
  }

  Future<void> _loadPresets() async {
    try {
      final index = await _presetApi.fetchIndex();
      if (!mounted) return;
      setState(() {
        _presets = index.presets
            .map((p) => AgentPresetSummary(id: p.id, name: p.name))
            .toList();
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _presetUnavailable = true);
    }
  }

  void _addRow({String name = '', String prompt = ''}) {
    if (_rows.length >= _maxRows) return;
    setState(() => _rows.add(_Row(name: name, prompt: prompt)));
  }

  void _removeRow(_Row row) {
    setState(() {
      _rows.remove(row);
      row.dispose();
    });
  }

  Future<void> _attachPreset(String presetId) async {
    try {
      final preset = await _presetApi.fetchPreset(presetId);
      if (!mounted) return;
      _addRow(name: preset.name, prompt: preset.prompt ?? '');
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = '角色内容读取失败，请稍后重试。');
    }
  }

  Future<void> _save() async {
    final bindings = _rows
        .map(
          (r) => AirRoleBinding(
            name: r.nameCtrl.text.trim(),
            prompt: r.promptCtrl.text.trim(),
          ),
        )
        .toList();
    // 名字和说明都要有，否则这条绑定是空的；服务端也会拒，但在这里说比等一个
    // 409 回来更直接。
    for (final binding in bindings) {
      if (binding.name.isEmpty || binding.prompt.isEmpty) {
        setState(() => _error = '每个角色都要有名称和说明。');
        return;
      }
    }
    setState(() {
      _saving = true;
      _error = '';
    });
    try {
      if (_draft) {
        if (mounted) Navigator.of(context).pop(bindings);
        return;
      }
      await _service.updateRoles(
        widget.taskId!,
        expectedVersion: widget.version,
        bindings: bindings,
        clientMsgId: _attempt.forBindings(bindings),
      );
      await widget.onSaved?.call();
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e'.contains('role_version_conflict')
            ? '角色已在其他页面更新，请关闭后重新打开。'
            : '$e';
      });
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      key: const ValueKey('air-role-editor'),
      backgroundColor: AppColors.bg,
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 32),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppColors.radiusPanel),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _header(),
            Flexible(
              child: ListView(
                key: const ValueKey('air-role-rows'),
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(18, 4, 18, 8),
                children: [
                  Text(
                    // 保存后什么时候生效，是这一页最要紧的一句话。
                    _draft
                        ? '创建任务时会写入这些角色，第一条消息即按此执行。'
                        : '保存后对下一条新消息生效。正在执行和已经排队的消息保留原角色。',
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 12.5,
                      height: 1.6,
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (_rows.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 14),
                      child: Text(
                        '还没有附加角色。这个任务按目录默认的角色协作。',
                        style: TextStyle(color: AppColors.faint, fontSize: 12.5),
                      ),
                    ),
                  for (final row in _rows) _rowView(row),
                  const SizedBox(height: 4),
                  _presetPicker(),
                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      key: const ValueKey('air-role-add'),
                      onPressed: _rows.length >= _maxRows
                          ? null
                          : () => _addRow(),
                      icon: const Icon(Icons.add_rounded, size: 18),
                      label: Text(
                        _rows.length >= _maxRows
                            ? '最多 $_maxRows 个角色'
                            : '添加角色',
                      ),
                    ),
                  ),
                  if (_error.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        _error,
                        key: const ValueKey('air-role-error'),
                        style: const TextStyle(
                          color: AppColors.danger,
                          fontSize: 12.5,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            _actions(),
          ],
        ),
      ),
    );
  }

  Widget _header() => Padding(
    padding: const EdgeInsets.fromLTRB(18, 16, 8, 0),
    child: Row(
      children: [
        const Expanded(
          child: Text(
            '角色上下文',
            style: TextStyle(
              color: AppColors.text,
              fontSize: 17,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        IconButton(
          key: const ValueKey('air-role-close'),
          onPressed: _saving ? null : () => Navigator.of(context).pop(),
          icon: const Icon(Icons.close_rounded, size: 20),
          color: AppColors.muted,
          tooltip: '关闭',
        ),
      ],
    ),
  );

  Widget _rowView(_Row row) {
    final index = _rows.indexOf(row);
    return Container(
      key: ValueKey('air-role-row-$index'),
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(AppColors.radiusCard),
        border: Border.all(color: AppColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  key: ValueKey('air-role-name-$index'),
                  controller: row.nameCtrl,
                  maxLength: 80,
                  decoration: const InputDecoration(
                    labelText: '角色名称',
                    counterText: '',
                    isDense: true,
                  ),
                ),
              ),
              IconButton(
                key: ValueKey('air-role-remove-$index'),
                onPressed: _saving ? null : () => _removeRow(row),
                icon: const Icon(Icons.delete_outline_rounded, size: 18),
                color: AppColors.faint,
                tooltip: '移除',
              ),
            ],
          ),
          const SizedBox(height: 6),
          TextField(
            key: ValueKey('air-role-prompt-$index'),
            controller: row.promptCtrl,
            maxLines: 4,
            minLines: 3,
            maxLength: _maxPromptLength,
            decoration: const InputDecoration(
              labelText: '角色说明',
              counterText: '',
              isDense: true,
              alignLabelWithHint: true,
            ),
          ),
        ],
      ),
    );
  }

  Widget _presetPicker() {
    if (_presetUnavailable) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 6),
        child: Text(
          '角色库暂不可用，可手动添加',
          style: TextStyle(color: AppColors.faint, fontSize: 12.5),
        ),
      );
    }
    final presets = _presets;
    return DropdownButtonFormField<String>(
      key: const ValueKey('air-role-preset'),
      isExpanded: true,
      decoration: const InputDecoration(
        isDense: true,
        border: OutlineInputBorder(),
      ),
      // 读不到索引时这一行是禁用的，但没有它使用者就不知道该等什么。
      hint: Text(presets == null ? '正在读取角色库…' : '从角色库附加…'),
      items: [
        for (final preset in presets ?? const <AgentPresetSummary>[])
          DropdownMenuItem(value: preset.id, child: Text(preset.name)),
      ],
      onChanged: (presets == null || _rows.length >= _maxRows)
          ? null
          : (value) {
              if (value != null) _attachPreset(value);
            },
    );
  }

  Widget _actions() => Padding(
    padding: const EdgeInsets.fromLTRB(18, 4, 18, 16),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.end,
      children: [
        TextButton(
          key: const ValueKey('air-role-cancel'),
          onPressed: _saving ? null : () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        const SizedBox(width: 8),
        FilledButton(
          key: const ValueKey('air-role-save'),
          onPressed: _saving ? null : _save,
          style: FilledButton.styleFrom(
            backgroundColor: AppColors.accentDark,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppColors.radiusButton),
            ),
          ),
          child: Text(
            _saving
                ? '正在保存…'
                : (_draft ? '使用这些角色' : '保存角色'),
          ),
        ),
      ],
    ),
  );
}

/// 角色库索引里的一行。名字是给下拉看的，说明要等选中之后再拉 —— 索引里
/// 本来就不带 prompt，几千字的提示词没必要为了列个名字全下下来。
class AgentPresetSummary {
  const AgentPresetSummary({required this.id, required this.name});

  final String id;
  final String name;
}
