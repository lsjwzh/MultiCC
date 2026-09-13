import 'dart:convert';

import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';

/// 「新任务」对话框 —— Web 侧是 `public/air.html` 的 `#new-task-dialog`
/// （表单 `#new-task-form`，处理器在 `air.js:1581-1599`）。
///
/// 它和目录里那个「创建并执行」输入区不是一回事，两条路各管一半：
///
/// * 输入区（[AirQuickComposer]）要的是「描述完就走」——一段话 + 线路 + 角色 +
///   附件，创建和发第一条消息是一条流水线。它适合已经有目标、只是要说清楚。
/// * 这个对话框要的是「先把壳搭好」——先给任务一个名字、挑好 AI 工具、可选写死
///   一个模型和一段角色说明；第一条消息之后在会话里再发。名字是这里独有的字段，
///   输入区那条路直接拿那段话当标题。
///
/// 成功后返回创建出来的 taskId（调用方负责刷新快照并打开它）；取消返回 null。
Future<String?> showAirNewTaskDialog(
  BuildContext context, {
  required AirDirectory directory,
  required List<String> clis,
  required SettingsService settings,
  AirService? service,
}) {
  return showDialog<String>(
    context: context,
    builder: (_) => _AirNewTaskDialog(
      directory: directory,
      clis: clis,
      settings: settings,
      service: service,
    ),
  );
}

/// 一次创建动作的幂等键。Web 用的指纹是 `JSON.stringify([directoryId, values])`
/// —— 同一次重试（一个字都没改）复用同一个 clientMsgId，服务端就只建一个任务；
/// 改了任何一个字段就换新 id，那是一次「说法变了的新任务」。这里保持同样的规矩，
/// 免得对话框里点两下多出一个空任务。
class _CreateAttempt {
  String fingerprint = '';
  String clientMsgId = '';

  static int _seq = 0;

  String _next() =>
      'app-air-new-${DateTime.now().microsecondsSinceEpoch}-${_seq++}';

  String forValues(Map<String, String> values) {
    final next = jsonEncode([values]);
    if (next != fingerprint || clientMsgId.isEmpty) {
      fingerprint = next;
      clientMsgId = _next();
    }
    return clientMsgId;
  }
}

class _AirNewTaskDialog extends StatefulWidget {
  const _AirNewTaskDialog({
    required this.directory,
    required this.clis,
    required this.settings,
    required this.service,
  });

  final AirDirectory directory;
  final List<String> clis;
  final SettingsService settings;
  final AirService? service;

  @override
  State<_AirNewTaskDialog> createState() => _AirNewTaskDialogState();
}

class _AirNewTaskDialogState extends State<_AirNewTaskDialog> {
  /// Web 的输入框长度上限（`maxlength`），照抄 —— 服务端也按这几个数把关。
  static const _maxTitleLength = 120;
  static const _maxModelLength = 100;
  static const _maxRoleLength = 40000;

  final _titleCtrl = TextEditingController();
  final _modelCtrl = TextEditingController();
  final _roleCtrl = TextEditingController();
  final _attempt = _CreateAttempt();

  AirService? _owned;
  late String _cli;
  bool _roleOpen = false;
  bool _submitting = false;
  String _error = '';

  AirService get _service =>
      widget.service ?? (_owned ??= AirService(settings: widget.settings));

  @override
  void initState() {
    super.initState();
    // 目录的默认 CLI 是列表第一条（Web 也是把 data.clis 原样铺成 <option>，
    // 第一项即默认值）。一个 CLI 都没有时留空，由服务端用目录默认值填。
    _cli = widget.clis.isEmpty ? '' : widget.clis.first;
  }

  @override
  void dispose() {
    _titleCtrl.dispose();
    _modelCtrl.dispose();
    _roleCtrl.dispose();
    if (_owned != null && widget.service == null) _owned!.close();
    super.dispose();
  }

  Future<void> _submit() async {
    final title = _titleCtrl.text.trim();
    if (title.isEmpty) {
      setState(() => _error = '请先给任务起个名字。');
      return;
    }
    final model = _modelCtrl.text.trim();
    final rolePrompt = _roleCtrl.text.trim();
    setState(() {
      _submitting = true;
      _error = '';
    });
    try {
      final taskId = await _service.createTask(
        dirId: widget.directory.id,
        title: title,
        clientMsgId: _attempt.forValues({
          'title': title,
          'cli': _cli,
          'model': model,
          'rolePrompt': rolePrompt,
        }),
        cli: _cli,
        model: model,
        rolePrompt: rolePrompt,
      );
      if (mounted) Navigator.of(context).pop(taskId);
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error.toString();
          _submitting = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: AppColors.panel,
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(AppColors.radiusPanel)),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460, maxHeight: 620),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _head(),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(18, 4, 18, 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // 建在哪个目录上 —— Web 的 `#create-directory` 就是这句，
                    // 对话框里没有选目录的控件，因为入口是从某个目录点进来的。
                    Text(
                      widget.directory.path,
                      style: const TextStyle(
                        color: AppColors.blue,
                        fontSize: 11.5,
                      ),
                    ),
                    const SizedBox(height: 14),
                    _label('任务名称'),
                    const SizedBox(height: 6),
                    TextField(
                      key: const ValueKey('air-new-task-title'),
                      controller: _titleCtrl,
                      autofocus: true,
                      maxLength: _maxTitleLength,
                      textInputAction: TextInputAction.next,
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 13.5,
                      ),
                      decoration: _field(hint: '例如：完善登录页面'),
                    ),
                    const SizedBox(height: 4),
                    _label('AI 工具'),
                    const SizedBox(height: 6),
                    _cliPicker(),
                    const SizedBox(height: 14),
                    _label('模型（可选）'),
                    const SizedBox(height: 6),
                    TextField(
                      key: const ValueKey('air-new-task-model'),
                      controller: _modelCtrl,
                      maxLength: _maxModelLength,
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 13.5,
                      ),
                      decoration: _field(hint: '跟随默认配置'),
                    ),
                    const SizedBox(height: 4),
                    _roleSection(),
                    if (_error.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      Text(
                        _error,
                        key: const ValueKey('air-new-task-error'),
                        style: const TextStyle(
                          color: AppColors.danger,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            _footer(),
          ],
        ),
      ),
    );
  }

  Widget _head() => Padding(
    padding: const EdgeInsets.fromLTRB(18, 16, 10, 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'NEW TASK',
                style: TextStyle(
                  color: AppColors.faint,
                  fontSize: 10,
                  letterSpacing: 0.8,
                ),
              ),
              SizedBox(height: 2),
              Text(
                '新任务',
                style: TextStyle(
                  color: AppColors.text,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
        IconButton(
          key: const ValueKey('air-new-task-close'),
          onPressed: _submitting ? null : () => Navigator.of(context).pop(),
          iconSize: 20,
          tooltip: '关闭',
          icon: const Icon(Icons.close_rounded, color: AppColors.muted),
        ),
      ],
    ),
  );

  Widget _label(String text) => Text(
    text,
    style: const TextStyle(color: AppColors.muted, fontSize: 12),
  );

  /// `maxLength` 会自带一行「0/120」的计数器，手机上那一行纯属噪声（Web 那边
  /// 也只在输入框角上写个数字）。上限仍然生效，只是不显示这一行。
  InputDecoration _field({required String hint}) => InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: AppColors.faint, fontSize: 13),
        isDense: true,
        filled: true,
        fillColor: AppColors.well,
        counterText: '',
        contentPadding: const EdgeInsets.symmetric(horizontal: 11, vertical: 11),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppColors.radiusChip),
          borderSide: const BorderSide(color: AppColors.line),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppColors.radiusChip),
          borderSide: const BorderSide(color: AppColors.line),
        ),
      );

  Widget _cliPicker() {
    // 一个 CLI 都没有（快照还没回来）时退化成一句说明，不给一个空下拉 ——
    // 空下拉选不出东西，用户会以为是坏了。
    if (widget.clis.isEmpty) {
      return const Text(
        '暂时读不到可用的 AI 工具，创建时会用目录的默认值。',
        style: TextStyle(color: AppColors.faint, fontSize: 12.5),
      );
    }
    return DropdownButtonFormField<String>(
      key: const ValueKey('air-new-task-cli'),
      value: _cli.isEmpty ? null : _cli,
      isDense: true,
      dropdownColor: AppColors.panel,
      style: const TextStyle(color: AppColors.text, fontSize: 13.5),
      decoration: _field(hint: 'AI 工具'),
      items: [
        for (final cli in widget.clis)
          DropdownMenuItem<String>(value: cli, child: Text(cli)),
      ],
      onChanged: _submitting
          ? null
          : (value) => setState(() => _cli = value ?? _cli),
    );
  }

  /// 「角色上下文（可选）」在 Web 上是个 `<details>` —— 默认收起，因为多数任务
  /// 不需要它，展开就占掉半个屏幕。这里同样是可折叠的。
  Widget _roleSection() {
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(AppColors.radiusChip),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            key: const ValueKey('air-new-task-role-header'),
            borderRadius: BorderRadius.circular(AppColors.radiusChip),
            onTap: () => setState(() => _roleOpen = !_roleOpen),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 11),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '角色上下文（可选）',
                      style: TextStyle(
                        color: _roleOpen ? AppColors.text : AppColors.muted,
                        fontSize: 12.5,
                      ),
                    ),
                  ),
                  Icon(
                    _roleOpen
                        ? Icons.expand_less_rounded
                        : Icons.expand_more_rounded,
                    size: 18,
                    color: AppColors.faint,
                  ),
                ],
              ),
            ),
          ),
          if (_roleOpen)
            Padding(
              padding: const EdgeInsets.fromLTRB(11, 0, 11, 11),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    '本任务的角色说明',
                    style: TextStyle(color: AppColors.muted, fontSize: 12),
                  ),
                  const SizedBox(height: 6),
                  TextField(
                    key: const ValueKey('air-new-task-role'),
                    controller: _roleCtrl,
                    maxLines: 4,
                    minLines: 4,
                    maxLength: _maxRoleLength,
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 13,
                      height: 1.5,
                    ),
                    decoration: _field(
                      hint: '例如：以移动端体验设计师的视角检查交互',
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _footer() => Padding(
    padding: const EdgeInsets.fromLTRB(18, 0, 18, 16),
    child: Row(
      children: [
        const Expanded(
          child: Text(
            // 说清这个对话框和输入区的分工，免得用户以为它不执行任务。
            '建好后在任务里发第一条消息。',
            style: TextStyle(color: AppColors.faint, fontSize: 11.5),
          ),
        ),
        TextButton(
          onPressed: _submitting ? null : () => Navigator.of(context).pop(),
          child: const Text(
            '取消',
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
        ),
        const SizedBox(width: 4),
        FilledButton(
          key: const ValueKey('air-new-task-submit'),
          onPressed: _submitting ? null : _submit,
          style: FilledButton.styleFrom(
            backgroundColor: AppColors.accentDark,
            foregroundColor: AppColors.onAccent,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            textStyle: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
          child: _submitting
              ? const SizedBox(
                  width: 15,
                  height: 15,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: AppColors.onAccent,
                  ),
                )
              : const Text('创建任务'),
        ),
      ],
    ),
  );
}
