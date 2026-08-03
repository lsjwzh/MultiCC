// AI 配置底部面板（provider/model/effort/agent/subagent + 角色提示词编辑）。自 chat_screen.dart 抽出。
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../models/agent_preset.dart';
import '../models/message.dart';
import '../providers/session_manager.dart';
import 'agent_preset_picker_sheet.dart';
import '../services/agent_preset_service.dart';
import '../services/manage_service.dart';
import '../services/qoder_models_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

class AIConfigResult {
  final String provider;
  final String model;
  final String effort;
  final String providerLabel;
  final String modelLabel;
  final String effortLabel;
  final SessionSubagent? subagent;
  final String? agent;
  const AIConfigResult({
    required this.provider,
    required this.model,
    required this.effort,
    required this.providerLabel,
    required this.modelLabel,
    required this.effortLabel,
    this.subagent,
    this.agent,
  });
}

class AIConfigSheet extends StatefulWidget {
  final SessionCli cli;
  final List<Map<String, dynamic>> providers;
  final String provider;
  final String model;
  final String effort;
  final String? subProviderId;
  final String? subModel;
  final String? agent;
  const AIConfigSheet({
    super.key,
    required this.cli,
    required this.providers,
    required this.provider,
    required this.model,
    required this.effort,
    this.subProviderId,
    this.subModel,
    this.agent,
  });

  @override
  State<AIConfigSheet> createState() => AIConfigSheetState();
}

class AIConfigSheetState extends State<AIConfigSheet> {
  late String _provider;
  late String _model;
  late String _effort;
  bool _customModel = false;
  late final TextEditingController _customCtrl;
  late final TextEditingController _agentCtrl;
  // Sub-task (subagent) cascade — same shape as the main provider/model.
  late String _subProvider;
  late String _subModel;
  bool _customSubModel = false;
  late final TextEditingController _subCustomCtrl;

  bool get _isClaude => widget.cli == SessionCli.claude;
  bool get _isCodex => widget.cli == SessionCli.codex;
  bool get _isQoder => widget.cli == SessionCli.qoder;
  String get _defaultEffort => widget.cli.defaultEffort;

  @override
  void initState() {
    super.initState();
    _provider = widget.cli.supportsProvider ? widget.provider : '';
    _model = _normalizeModel(_provider, widget.model);
    _effort = _validEfforts.contains(widget.effort)
        ? widget.effort
        : _defaultEffort;
    final known = _modelChoices(_provider).contains(_model);
    _customModel = _model.isNotEmpty && !known;
    _customCtrl = TextEditingController(text: _customModel ? _model : '');
    _agentCtrl = TextEditingController(text: widget.agent ?? '');
    // Sub-task seeding.
    _subProvider = widget.subProviderId ?? '';
    _subModel = _normalizeModel(_subProvider, widget.subModel ?? '');
    final subKnown =
        _subProvider.isNotEmpty &&
        _modelChoices(_subProvider).contains(_subModel);
    _customSubModel =
        _subProvider.isNotEmpty && _subModel.isNotEmpty && !subKnown;
    _subCustomCtrl = TextEditingController(
      text: _customSubModel ? _subModel : '',
    );
  }

  @override
  void dispose() {
    _customCtrl.dispose();
    _agentCtrl.dispose();
    _subCustomCtrl.dispose();
    super.dispose();
  }

  List<String> get _validEfforts => widget.cli.effortOptions;

  Map<String, dynamic>? _providerMap(String id) {
    for (final p in widget.providers) {
      if (p['id'] == id) return p;
    }
    return null;
  }

  String _providerName(String id) {
    if (_isQoder) return 'Qoder CN';
    if (id.isEmpty) return '默认登录';
    final p = _providerMap(id);
    return p?['name']?.toString() ?? id;
  }

  // Ordered alias tiers (opus/sonnet/haiku/fable) with their {model, name} for an
  // alias-mapped relay, or empty when the provider declares no aliasMap. Each tier
  // is a real, selectable wire model on these relays (the server honors
  // session.model === 'opus' | 'sonnet' | 'haiku' | 'fable' directly).
  List<MapEntry<String, Map>> _aliasTiers(String provider) {
    final map = _providerMap(provider)?['aliasMap'];
    if (map is! Map) return const [];
    const order = ['opus', 'sonnet', 'haiku', 'fable'];
    final tiers = <MapEntry<String, Map>>[];
    for (final t in order) {
      final v = map[t];
      if (v is Map && v['model'] != null) tiers.add(MapEntry(t, v));
    }
    return tiers;
  }

  List<String> _modelChoices(String provider) {
    if (_isQoder) {
      // Live catalog when openAIConfigSheet warmed it, built-in tiers otherwise.
      return QoderModelsService.options().map((option) => option.key).toList();
    }
    // Alias-mapped relays: offer the tiers directly (opus/sonnet/haiku/fable) so
    // each option can read "alias → wire model (display name)".
    final tiers = _aliasTiers(provider);
    if (tiers.isNotEmpty) return ['', ...tiers.map((e) => e.key)];
    final opts = _providerMap(provider)?['modelOptions'];
    if (opts is List && opts.isNotEmpty) {
      return [
        '',
        ...opts.map((e) => e.toString()).where((e) => e.trim().isNotEmpty),
      ];
    }
    return _isClaude ? kClaudeModelOptions.map((e) => e.key).toList() : [''];
  }

  // Map a stored wire model id (e.g. claude-opus-4-8) back to its alias tier so
  // the tier dropdown pre-selects instead of dropping into the custom-id field.
  String _normalizeModel(String provider, String model) {
    if (model.isEmpty) return model;
    for (final e in _aliasTiers(provider)) {
      if (e.key == model) return model;
      if (e.value['model']?.toString() == model) return e.key;
    }
    return model;
  }

  String _modelLabel(String model) {
    if (model.isEmpty) {
      return _isQoder ? '默认 / 跟随 Qoder CN 设置' : '默认 / 跟随 Provider';
    }
    return modelShortNameForCli(widget.cli, model);
  }

  // Rich dropdown option label. For alias tiers: "opus → claude-opus-4-8 (GLM5.2)".
  String _modelOptionLabel(String provider, String value) {
    if (value.isEmpty) return _modelLabel('');
    for (final e in _aliasTiers(provider)) {
      if (e.key != value) continue;
      final m = e.value['model']?.toString() ?? '';
      final name = e.value['name']?.toString();
      return '${e.key} → $m${(name != null && name.isNotEmpty) ? ' ($name)' : ''}';
    }
    return _modelLabel(value);
  }

  // Compact label for the saved config (chip / SnackBar): the provider's real
  // model name (e.g. GLM5.2) for an alias tier, otherwise the plain model label.
  String _modelResultLabel(String provider, String model) {
    if (model.isEmpty) return '默认';
    for (final e in _aliasTiers(provider)) {
      if (e.key != model) continue;
      final name = e.value['name']?.toString();
      if (name != null && name.isNotEmpty) return name;
      return e.value['model']?.toString() ?? model;
    }
    return _modelLabel(model);
  }

  String _effortDescription(String value) {
    if (value.isEmpty) {
      return _isQoder
          ? 'Default — Follow Qoder CN settings'
          : 'Default — Follow the selected model/provider';
    }
    if (!_isClaude) {
      switch (value) {
        case 'minimal':
          return 'Minimal — Minimal reasoning where supported';
        case 'low':
          return 'Low — Fast responses with lighter reasoning';
        case 'medium':
          return 'Medium — Balances speed and reasoning depth for everyday tasks';
        case 'high':
          return 'High — Greater reasoning depth for complex problems';
        case 'xhigh':
          return 'Extra high — Extra high reasoning depth for complex problems';
      }
    }
    return value;
  }

  void _onProviderChanged(String? value) {
    final next = value ?? '';
    final choices = _modelChoices(next);
    setState(() {
      _provider = next;
      if (_isCodex && next.isEmpty) {
        _subProvider = '';
        _subModel = '';
        _customSubModel = false;
        _subCustomCtrl.clear();
      }
      if (!choices.contains(_model)) {
        _model = '';
        _customModel = false;
        _customCtrl.clear();
      }
    });
  }

  void _onSubProviderChanged(String? value) {
    final next = value ?? '';
    final choices = _modelChoices(next);
    setState(() {
      _subProvider = next;
      if (!choices.contains(_subModel)) {
        _subModel = '';
        _customSubModel = false;
        _subCustomCtrl.clear();
      }
    });
  }

  void _submit() {
    final model = _customModel ? _customCtrl.text.trim() : _model;
    final subModel = _subProvider.isEmpty
        ? null
        : (_customSubModel ? _subCustomCtrl.text.trim() : _subModel);
    final subagent = (subModel != null && subModel.isNotEmpty)
        ? SessionSubagent(providerId: _subProvider, model: subModel)
        : null;
    Navigator.pop(
      context,
      AIConfigResult(
        provider: _provider,
        model: model,
        effort: _effort,
        providerLabel: _providerName(_provider),
        modelLabel: _modelResultLabel(_provider, model),
        effortLabel: effortShortNameForCli(widget.cli, _effort),
        subagent: subagent,
        agent: widget.cli.supportsAgent ? _agentCtrl.text.trim() : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final modelChoices = _modelChoices(_provider);
    final providerIds = widget.providers
        .map((p) => p['id']?.toString() ?? '')
        .toSet();
    final includeCurrentProvider =
        _provider.isNotEmpty && !providerIds.contains(_provider);
    final modelValue = _customModel
        ? '__custom__'
        : (modelChoices.contains(_model) ? _model : '');
    // Sub-task (subagent) cascade state for the view.
    final subModelChoices = _modelChoices(_subProvider);
    final subModelValue = _customSubModel
        ? '__custom__'
        : (subModelChoices.contains(_subModel)
              ? _subModel
              : (subModelChoices.isNotEmpty ? subModelChoices.first : ''));
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.only(
          left: 18,
          right: 18,
          top: 16,
          bottom: 18 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'AI 配置（${widget.cli.supportsProvider ? 'Provider / ' : ''}Model${widget.cli.supportsEffort ? ' / ${widget.cli.effortFieldLabel}' : ''}）',
              style: const TextStyle(
                color: AppColors.text,
                fontSize: 15,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 14),
            if (widget.cli.supportsProvider) ...[
              const Text(
                'Provider',
                style: TextStyle(color: AppColors.faint, fontSize: 12),
              ),
              const SizedBox(height: 5),
              DropdownButtonFormField<String>(
                value: _provider,
                dropdownColor: AppColors.panel,
                decoration: _sheetInputDecoration(),
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                items: [
                  const DropdownMenuItem(value: '', child: Text('默认登录 / 订阅')),
                  if (includeCurrentProvider)
                    DropdownMenuItem(value: _provider, child: Text(_provider)),
                  ...widget.providers.map(
                    (p) => DropdownMenuItem(
                      value: p['id']?.toString() ?? '',
                      child: Text(
                        '${p['name'] ?? p['id']}${p['model'] != null && p['model'].toString().isNotEmpty ? ' · ${p['model']}' : ''}',
                      ),
                    ),
                  ),
                ],
                onChanged: _onProviderChanged,
              ),
              const SizedBox(height: 12),
            ] else ...[
              const Text(
                'Qoder CN 使用自身账号 / BYOK 配置',
                style: TextStyle(color: AppColors.faint, fontSize: 12),
              ),
              const SizedBox(height: 12),
            ],
            const Text(
              'Model',
              style: TextStyle(color: AppColors.faint, fontSize: 12),
            ),
            const SizedBox(height: 5),
            DropdownButtonFormField<String>(
              value: modelValue,
              dropdownColor: AppColors.panel,
              decoration: _sheetInputDecoration(),
              style: const TextStyle(color: AppColors.text, fontSize: 13),
              items: [
                ...modelChoices.map(
                  (m) => DropdownMenuItem(
                    value: m,
                    child: Text(_modelOptionLabel(_provider, m)),
                  ),
                ),
                const DropdownMenuItem(
                  value: '__custom__',
                  child: Text('自定义…'),
                ),
              ],
              onChanged: (v) {
                setState(() {
                  _customModel = v == '__custom__';
                  if (!_customModel) _model = v ?? '';
                });
              },
            ),
            if (_customModel) ...[
              const SizedBox(height: 8),
              TextField(
                controller: _customCtrl,
                autofocus: true,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 13,
                  fontFamily: 'monospace',
                ),
                decoration: _sheetInputDecoration(
                  hint: _isClaude ? 'claude-opus-4-8' : '模型 ID',
                ),
              ),
            ],
            if (widget.cli.supportsEffort) ...[
              const SizedBox(height: 12),
              Text(
                widget.cli.effortFieldLabel,
                style: const TextStyle(color: AppColors.faint, fontSize: 12),
              ),
              const SizedBox(height: 5),
              DropdownButtonFormField<String>(
                value: _effort,
                isExpanded: true,
                dropdownColor: AppColors.panel,
                decoration: _sheetInputDecoration(),
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                items: _validEfforts
                    .map(
                      (e) => DropdownMenuItem(
                        value: e,
                        child: Text(
                          _effortDescription(e),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    )
                    .toList(),
                onChanged: (v) => setState(() => _effort = v ?? _defaultEffort),
              ),
            ],
            if (widget.cli.supportsAgent) ...[
              const Divider(height: 32),
              Text(
                '${widget.cli.displayName} Agent',
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 5),
              TextField(
                controller: _agentCtrl,
                maxLength: 80,
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                decoration: _sheetInputDecoration(
                  hint: widget.cli == SessionCli.opencode
                      ? '例如 build；留空使用默认 agent'
                      : '已定义的 agent 名称；留空使用默认 agent',
                ).copyWith(counterText: ''),
              ),
            ],
            if (widget.cli.supportsSubagent) ...[
              const Divider(height: 32),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  const Text(
                    '子任务 (subagent)',
                    style: TextStyle(
                      color: AppColors.text,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '派生子 agent 使用独立的 provider+model，留空 = 随主（经本地协议代理路由）',
                      style: TextStyle(color: AppColors.faint, fontSize: 11),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              const Text(
                '子任务 Provider',
                style: TextStyle(color: AppColors.faint, fontSize: 12),
              ),
              const SizedBox(height: 5),
              DropdownButtonFormField<String>(
                value: _subProvider,
                dropdownColor: AppColors.panel,
                decoration: _sheetInputDecoration(),
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                items: [
                  const DropdownMenuItem(value: '', child: Text('默认（随主）')),
                  ...widget.providers
                      .where((p) => !(_isCodex && p['isOfficial'] == true))
                      .map(
                        (p) => DropdownMenuItem(
                          value: p['id']?.toString() ?? '',
                          child: Text(
                            '${p['name'] ?? p['id']}${p['model'] != null && p['model'].toString().isNotEmpty ? ' · ${p['model']}' : ''}',
                          ),
                        ),
                      ),
                ],
                onChanged: _onSubProviderChanged,
              ),
              if (_subProvider.isNotEmpty) ...[
                const SizedBox(height: 12),
                const Text(
                  '子任务 Model',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
                const SizedBox(height: 5),
                DropdownButtonFormField<String>(
                  value: subModelValue,
                  dropdownColor: AppColors.panel,
                  decoration: _sheetInputDecoration(),
                  style: const TextStyle(color: AppColors.text, fontSize: 13),
                  items: [
                    ...subModelChoices.map(
                      (m) => DropdownMenuItem(
                        value: m,
                        child: Text(_modelOptionLabel(_subProvider, m)),
                      ),
                    ),
                    const DropdownMenuItem(
                      value: '__custom__',
                      child: Text('自定义…'),
                    ),
                  ],
                  onChanged: (v) {
                    setState(() {
                      _customSubModel = v == '__custom__';
                      if (!_customSubModel) _subModel = v ?? '';
                    });
                  },
                ),
                if (_customSubModel) ...[
                  const SizedBox(height: 8),
                  TextField(
                    controller: _subCustomCtrl,
                    autofocus: true,
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 13,
                      fontFamily: 'monospace',
                    ),
                    decoration: _sheetInputDecoration(hint: '模型 ID'),
                  ),
                ],
              ],
            ],
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('取消'),
                ),
                const SizedBox(width: 8),
                ElevatedButton(onPressed: _submit, child: const Text('保存')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Open the per-session AI-config sheet for [sessionId] (used by both the
/// header ModelChip and the InputBar subagent pill). Fetches the provider list
/// fresh, seeds the sheet from the current session (incl. subagent override),
/// and PATCHes provider+model+effort+subagent on save.
Future<void> openAIConfigSheet(
  BuildContext context, {
  required SettingsService settings,
  required String sessionId,
}) async {
  final mgr = context.read<SessionManager>();
  Session? found;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) {
      found = x;
      break;
    }
  }
  if (found == null) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(t('sessionNotLoaded'))));
    return;
  }
  final sess = found;
  var runtime = SessionCliConfig(
    cli: sess.cli,
    provider: sess.provider,
    model: sess.model,
    effectiveModel: sess.effectiveModel,
    effort: sess.effort,
    effectiveEffort: sess.effectiveEffort,
    agent: sess.agent,
    subagent: sess.subagent,
  );
  try {
    runtime = await mgr.fetchSessionCliConfig(sess.id);
  } catch (_) {}
  // Qoder owns no provider pool; its model list comes from the host CLI's
  // catalog instead. Warm it before the sheet builds so the dropdown opens on
  // the real models rather than the routing-tier fallback.
  if (runtime.cli == SessionCli.qoder) {
    try {
      await QoderModelsService(settings: settings).load();
    } catch (_) {}
  }
  List<Map<String, dynamic>> providers = const [];
  try {
    if (runtime.cli.supportsProvider) {
      final appType = runtime.cli.appType;
      final d = await ManageService(settings: settings).fetchProviders(appType);
      providers = (d['providers'] as List? ?? [])
          .map((e) => (e as Map).cast<String, dynamic>())
          .toList();
    }
  } catch (_) {}
  if (!context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  final picked = await showModalBottomSheet<AIConfigResult>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => AIConfigSheet(
      cli: runtime.cli,
      providers: providers,
      provider: runtime.provider ?? '',
      model: runtime.model ?? '',
      effort:
          runtime.effectiveEffort ??
          runtime.effort ??
          runtime.cli.defaultEffort,
      subProviderId: runtime.subagent?.providerId,
      subModel: runtime.subagent?.model,
      agent: runtime.agent,
    ),
  );
  if (picked == null) return;
  try {
    await mgr.updateSessionAIConfig(
      sess.id,
      provider: picked.provider,
      model: picked.model,
      effort: picked.effort,
      subagent: picked.subagent,
      agent: picked.agent,
      clearSubagent: picked.subagent == null,
    );
    final summary = [picked.providerLabel, picked.modelLabel];
    if (picked.effortLabel.isNotEmpty) summary.add(picked.effortLabel);
    messenger.showSnackBar(
      SnackBar(content: Text('✓ AI 配置已保存：${summary.join(' | ')}，下一轮对话生效')),
    );
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('AI 配置保存失败：$e')));
  }
}

InputDecoration _sheetInputDecoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    hintStyle: const TextStyle(color: AppColors.faint),
    filled: true,
    fillColor: const Color(0xFF070809),
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(6),
      borderSide: const BorderSide(color: Color(0xFF20242b)),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(6),
      borderSide: const BorderSide(color: AppColors.accent),
    ),
  );
}

// Multi-line role-prompt editor dialog. Returns the new text, or null on cancel.
// [settings] enables the preset picker (small chip strip + full browser). When
// omitted the editor degrades to a plain text field.
Future<String?> showRolePromptEditor(
  BuildContext context, {
  required String current,
  SettingsService? settings,
}) {
  return showDialog<String>(
    context: context,
    builder: (ctx) =>
        RolePromptEditorDialog(current: current, settings: settings),
  );
}

// Stateful editor dialog: a preset area sits above the free-text field. The
// preset area lazily loads the index, renders the featured presets as a
// horizontally scrollable chip strip, and exposes a "browse all" entry that
// opens [AgentPresetPickerSheet]. Picking a preset fetches its prompt and fills
// the text field (confirming first when the field is non-empty).
class RolePromptEditorDialog extends StatefulWidget {
  final String current;
  final SettingsService? settings;
  const RolePromptEditorDialog({
    super.key,
    required this.current,
    this.settings,
  });

  @override
  State<RolePromptEditorDialog> createState() => RolePromptEditorDialogState();
}

class RolePromptEditorDialogState extends State<RolePromptEditorDialog> {
  late final TextEditingController _controller;
  AgentPresetService? _svc;
  AgentPresetIndex? _index;
  bool _loadingIndex = false;
  String? _indexError;
  bool _applying = false; // fetching a prompt to fill the field

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.current);
    if (widget.settings != null) {
      _svc = AgentPresetService(settings: widget.settings!);
      _loadIndex();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _loadIndex({bool forceRefresh = false}) async {
    if (_svc == null) return;
    setState(() {
      _loadingIndex = true;
      _indexError = null;
    });
    try {
      final idx = await _svc!.fetchIndex(forceRefresh: forceRefresh);
      if (!mounted) return;
      setState(() {
        _index = idx;
        _loadingIndex = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _indexError = '$e';
        _loadingIndex = false;
      });
    }
  }

  // Fetch the prompt for [id] and put it in the field. If the field already has
  // content, confirm a replace first.
  Future<void> _applyPreset(String id) async {
    if (_svc == null || _applying) return;
    if (_controller.text.trim().isNotEmpty) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          backgroundColor: AppColors.panel2,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: AppColors.line),
          ),
          title: const Text(
            '替换当前内容?',
            style: TextStyle(color: AppColors.text, fontSize: 15),
          ),
          content: const Text(
            '文本框已有内容，使用该模板会覆盖现有文字。',
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c, false),
              child: const Text('取消', style: TextStyle(color: AppColors.muted)),
            ),
            TextButton(
              onPressed: () => Navigator.pop(c, true),
              child: const Text(
                '替换',
                style: TextStyle(color: AppColors.danger),
              ),
            ),
          ],
        ),
      );
      if (ok != true) return;
    }
    setState(() => _applying = true);
    try {
      final prompt = await _svc!.fetchPrompt(id);
      if (!mounted) return;
      setState(() {
        _controller.text = prompt;
        _applying = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _applying = false);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('模板加载失败：$e')));
    }
  }

  Future<void> _browseAll() async {
    if (_svc == null) return;
    final id = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => AgentPresetPickerSheet(service: _svc!, index: _index),
    );
    if (id != null && id.isNotEmpty) {
      await _applyPreset(id);
    }
  }

  Widget _presetArea() {
    if (_svc == null) return const SizedBox.shrink();
    Widget body;
    if (_loadingIndex && _index == null) {
      body = const Padding(
        padding: EdgeInsets.symmetric(vertical: 10),
        child: SizedBox(
          height: 16,
          width: 16,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: AppColors.accent,
          ),
        ),
      );
    } else if (_indexError != null && _index == null) {
      body = Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            const Expanded(
              child: Text(
                '模板加载失败',
                style: TextStyle(color: AppColors.danger, fontSize: 12),
              ),
            ),
            TextButton(
              onPressed: () => _loadIndex(forceRefresh: true),
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 28),
                padding: const EdgeInsets.symmetric(horizontal: 8),
              ),
              child: const Text(
                '重试',
                style: TextStyle(color: AppColors.accent, fontSize: 12),
              ),
            ),
          ],
        ),
      );
    } else {
      final featured = _index?.featuredPresets ?? const <AgentPreset>[];
      body = SizedBox(
        height: 34,
        child: featured.isEmpty
            ? const Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '暂无推荐模板',
                  style: TextStyle(color: AppColors.faint, fontSize: 12),
                ),
              )
            : ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: featured.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, i) {
                  final p = featured[i];
                  return PresetChip(
                    preset: p,
                    onTap: _applying ? null : () => _applyPreset(p.id),
                  );
                },
              ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Text(
              '预设角色',
              style: TextStyle(color: AppColors.muted, fontSize: 12),
            ),
            const Spacer(),
            TextButton(
              onPressed: _browseAll,
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 28),
                padding: const EdgeInsets.symmetric(horizontal: 6),
              ),
              child: const Text(
                '浏览全部模板 →',
                style: TextStyle(color: AppColors.accent, fontSize: 12),
              ),
            ),
          ],
        ),
        body,
        const SizedBox(height: 8),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.panel2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: AppColors.line),
      ),
      title: Row(
        children: [
          const Text(
            '角色提示词',
            style: TextStyle(color: AppColors.text, fontSize: 16),
          ),
          if (_applying) ...[
            const SizedBox(width: 10),
            const SizedBox(
              height: 14,
              width: 14,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: AppColors.accent,
              ),
            ),
          ],
        ],
      ),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _presetArea(),
            TextField(
              controller: _controller,
              maxLines: 9,
              minLines: 5,
              maxLength: 40000,
              autofocus: false,
              style: const TextStyle(color: AppColors.text, fontSize: 13),
              decoration: const InputDecoration(
                hintText:
                    '例如：你是开发保姆，被触发时用 multicc-trigger skill 检查 git 改动并提醒提交和测试，不要擅自改代码。',
                hintStyle: TextStyle(color: Color(0xFF6b7280), fontSize: 12),
                enabledBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: AppColors.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: AppColors.accentDark),
                ),
              ),
            ),
            const Text(
              '留空＝清除（会话将继承Fleet默认角色）',
              style: TextStyle(color: AppColors.muted, fontSize: 11),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消', style: TextStyle(color: AppColors.muted)),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, _controller.text),
          child: const Text('保存', style: TextStyle(color: Color(0xFF3fb950))),
        ),
      ],
    );
  }
}

// A compact featured-preset chip: emoji + name, outlined with the category
// color. Used in the small preset strip inside the editor.
class PresetChip extends StatelessWidget {
  final AgentPreset preset;
  final VoidCallback? onTap;
  const PresetChip({super.key, required this.preset, this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = preset.accentColor;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: c.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: c.withValues(alpha: 0.55)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (preset.emoji.isNotEmpty) ...[
                Text(preset.emoji, style: const TextStyle(fontSize: 13)),
                const SizedBox(width: 6),
              ],
              Text(
                preset.name,
                style: TextStyle(
                  color: AppColors.text,
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
