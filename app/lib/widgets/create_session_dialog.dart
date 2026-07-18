// 新建会话对话框（角色预设 + provider→model 联动）。自 main_shell.dart 抽出。

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/message.dart';
import '../models/agent_preset.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import '../services/agent_preset_service.dart';
import '../widgets/agent_preset_picker_sheet.dart';


// ── New-session dialog with role presets + provider→model linkage ───────────

class CreateSessionResult {
  final String? label;
  final String? rolePrompt;
  final String? provider;
  final String? model;
  final String? effort;
  final String? agent;
  CreateSessionResult({
    this.label,
    this.rolePrompt,
    this.provider,
    this.model,
    this.effort,
    this.agent,
  });
}

class CreateSessionDialog extends StatefulWidget {
  final SessionCli cli;
  final SessionKind kind;
  final List<Map<String, dynamic>> providers;
  final String? defaultProviderId;
  final SettingsService settings;

  const CreateSessionDialog({
    super.key,
    required this.cli,
    required this.kind,
    required this.providers,
    this.defaultProviderId,
    required this.settings,
  });

  @override
  State<CreateSessionDialog> createState() => CreateSessionDialogState();
}

class CreateSessionDialogState extends State<CreateSessionDialog> {
  late final TextEditingController _nameCtrl;
  late final TextEditingController _roleCtrl;
  late final TextEditingController _agentCtrl;
  late final AgentPresetService _presetSvc;
  AgentPresetIndex? _presetIndex;
  bool _loadingPresets = false;

  String? _pickedProvider; // null or '' = default; id = that provider
  String? _pickedModel;
  late String _pickedEffort;
  bool _customModel = false;
  final _customModelCtrl = TextEditingController();

  bool get _isClaude => widget.cli == SessionCli.claude;
  String get _defaultEffort => widget.cli.defaultEffort;
  bool get _hasConcreteDefaultProvider =>
      widget.defaultProviderId != null &&
      widget.defaultProviderId!.isNotEmpty &&
      widget.providers.any((p) => p['id'] == widget.defaultProviderId);
  String get _effectiveProviderId {
    final picked = _pickedProvider;
    if (picked != null && picked.isNotEmpty) return picked;
    return widget.defaultProviderId ?? '';
  }

  @override
  void initState() {
    super.initState();
    _nameCtrl = TextEditingController();
    _roleCtrl = TextEditingController();
    _agentCtrl = TextEditingController();
    _presetSvc = AgentPresetService(settings: widget.settings);
    if (_hasConcreteDefaultProvider) _pickedProvider = widget.defaultProviderId;
    _pickedEffort = _defaultEffort;
    _loadPresets();
    final opts = _currentModelOptions;
    _pickedModel = opts.isNotEmpty ? opts.first.key : null;
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _roleCtrl.dispose();
    _agentCtrl.dispose();
    _customModelCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadPresets() async {
    setState(() => _loadingPresets = true);
    try {
      _presetIndex = await _presetSvc.fetchIndex();
    } catch (_) {}
    if (!mounted) return;
    setState(() => _loadingPresets = false);
  }

  /// Build the model options for the current provider selection.
  /// Mirrors web rebuildModelOptions(): provider modelOptions if available,
  /// else CLAUDE_MODEL_OPTIONS for Claude only (empty list for Codex).
  List<MapEntry<String, String>> get _currentModelOptions {
    Map<String, dynamic>? prov;
    final providerId = _effectiveProviderId;
    for (final p in widget.providers) {
      if (p['id'] == providerId) {
        prov = p;
        break;
      }
    }
    // Alias-mapped relays (e.g. iFlytek): expose the tiers directly, each option
    // reading "opus → claude-opus-4-8 (GLM5.2)". The tier key is the value — the
    // server honors session.model === opus/sonnet/haiku/fable as a wire model.
    final map = prov?['aliasMap'];
    if (map is Map) {
      const order = ['opus', 'sonnet', 'haiku', 'fable'];
      final tiers = <MapEntry<String, String>>[];
      for (final t in order) {
        final v = map[t];
        if (v is Map && v['model'] != null) {
          final m = v['model'].toString();
          final name = v['name']?.toString();
          tiers.add(
            MapEntry(
              t,
              '$t → $m${(name != null && name.isNotEmpty) ? ' ($name)' : ''}',
            ),
          );
        }
      }
      if (tiers.isNotEmpty) return tiers;
    }
    final opts = prov?['modelOptions'];
    if (opts is List && opts.isNotEmpty) {
      return opts
          .map((m) => m.toString())
          .map((s) => MapEntry<String, String>(s, s))
          .toList();
    }
    // Empty provider follows the configured default provider for this CLI:
    // Codex should still show GPT / XF model choices instead of a Claude list.
    // No provider (or provider without modelOptions):
    //  - Claude: fall back to standard model list
    //  - Codex: empty list (custom model entry only), matching web behavior
    return _isClaude ? kClaudeModelOptions : const [];
  }


  String _providerIdForPresetDefault(AgentPreset preset) {
    final declared = preset.defaultProviderId ?? '';
    if (declared.isNotEmpty &&
        widget.providers.any((p) => p['id'] == declared)) {
      return declared;
    }
    final key = preset.defaultProviderKey.toLowerCase();
    final model = preset.defaultModel;
    if (key == 'xf-maas-coding') {
      for (final p in widget.providers) {
        final opts = (p['modelOptions'] as List? ?? [])
            .map((e) => e.toString())
            .toList();
        if (model.isNotEmpty && opts.contains(model)) return p['id'] as String;
      }
      for (final p in widget.providers) {
        final name = (p['name'] ?? '').toString().toLowerCase();
        if (name.contains('讯飞') || name.contains('xf') || name.contains('maas')) {
          return p['id'] as String;
        }
      }
    }
    if (key == 'openai-codex') {
      for (final p in widget.providers) {
        final name = (p['name'] ?? '').toString().toLowerCase();
        if (name.contains('openai') || name.contains('codex 官方') || name.contains('官方')) {
          return p['id'] as String;
        }
      }
      for (final p in widget.providers) {
        final opts = (p['modelOptions'] as List? ?? [])
            .map((e) => e.toString())
            .toList();
        if (opts.any((m) => m.startsWith('gpt-'))) return p['id'] as String;
      }
    }
    return '';
  }

  void _applyPresetDefaults(AgentPreset preset) {
    final presetCli = parseCli(preset.defaultCli.trim().toLowerCase());
    if (presetCli != widget.cli) return;

    final providerId = _providerIdForPresetDefault(preset);
    if (providerId.isNotEmpty) _pickedProvider = providerId;

    final opts = _currentModelOptions;
    final model = preset.defaultModel;
    if (model.isNotEmpty) {
      if (opts.any((e) => e.key == model)) {
        _pickedModel = model;
        _customModel = false;
        _customModelCtrl.clear();
      } else {
        _pickedModel = null;
        _customModel = true;
        _customModelCtrl.text = model;
      }
    }

    final effort = preset.defaultEffort;
    final validEfforts = widget.cli.effortOptions;
    if (validEfforts.contains(effort)) _pickedEffort = effort;
  }

  Future<void> _pickPreset() async {
    final id = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) =>
          AgentPresetPickerSheet(service: _presetSvc, index: _presetIndex),
    );
    if (id == null || !mounted) return;
    try {
      final preset = await _presetSvc.fetchPreset(id);
      final prompt = preset.prompt ?? '';
      if (!mounted) return;
      if (_roleCtrl.text.trim().isNotEmpty) {
        final ok = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            backgroundColor: const Color(0xFF14171c),
            title: Text(
              t('roleReplaceTitle'),
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 15),
            ),
            content: Text(
              t('roleReplaceBody'),
              style: const TextStyle(color: Color(0xFF8a909b), fontSize: 13),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c, false),
                child: Text(
                  t('cancel'),
                  style: const TextStyle(color: Color(0xFF8a909b)),
                ),
              ),
              TextButton(
                onPressed: () => Navigator.pop(c, true),
                child: Text(
                  t('roleReplaceBtn'),
                  style: const TextStyle(color: Color(0xFFff6b63)),
                ),
              ),
            ],
          ),
        );
        if (ok != true) return;
      }
      setState(() {
        _roleCtrl.text = prompt;
        _applyPresetDefaults(preset);
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(t('roleLoadFailed', {'error': '$e'}))));
    }
  }

  void _onProviderChanged(String? v) {
    setState(() {
      _pickedProvider = v;
      // Try to preserve the current model selection across provider switches
      // (matching web rebuildModelOptions behavior). If the current model
      // isn't in the new list, fall back to the first option or custom.
      final opts = _currentModelOptions;
      final prevModel = _customModel ? null : _pickedModel;
      if (prevModel != null && opts.any((e) => e.key == prevModel)) {
        // Current model exists in new provider's list — keep it
        _customModel = false;
      } else if (opts.isNotEmpty && opts.first.key.isNotEmpty) {
        _pickedModel = opts.first.key;
        _customModel = false;
      } else {
        _pickedModel = null;
        _customModel = false;
      }
    });
  }

  void _submit() {
    String? model;
    if (_customModel) {
      model = _customModelCtrl.text.trim().isNotEmpty
          ? _customModelCtrl.text.trim()
          : null;
    } else {
      model = (_pickedModel != null && _pickedModel!.isNotEmpty)
          ? _pickedModel
          : null;
    }
    final result = CreateSessionResult(
      label: _nameCtrl.text.trim().isNotEmpty ? _nameCtrl.text.trim() : null,
      rolePrompt: _roleCtrl.text.trim().isNotEmpty
          ? _roleCtrl.text.trim()
          : null,
      provider: (_pickedProvider != null && _pickedProvider!.isNotEmpty)
          ? _pickedProvider
          : null,
      model: model,
      effort: _pickedEffort,
      agent: widget.cli.supportsAgent && _agentCtrl.text.trim().isNotEmpty
          ? _agentCtrl.text.trim()
          : null,
    );
    Navigator.of(context).pop(result);
  }

  @override
  Widget build(BuildContext context) {
    final modelOptions = _currentModelOptions;
    return AlertDialog(
      backgroundColor: const Color(0xFF0f1115),
      title: Text(
        t('createSessionTitle', {
          'cli': widget.cli.displayName,
          'kind': widget.kind == SessionKind.chat ? 'Chat' : 'Terminal',
        }),
        style: const TextStyle(color: Color(0xFFf2f4f7), fontSize: 16),
      ),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Name ──
            Text(
              t('sessionName'),
              style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
            ),
            const SizedBox(height: 4),
            TextField(
              controller: _nameCtrl,
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
              decoration: sheetInputDecoration(hint: t('optionalAutoName')),
            ),
            const SizedBox(height: 12),
            // ── Role prompt with preset picker ──
            Row(
              children: [
                Text(
                  t('rolePrompt'),
                  style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
                ),
                const Spacer(),
                TextButton.icon(
                  icon: const Icon(Icons.auto_awesome, size: 14),
                  label: Text(
                    _loadingPresets ? t('loading') : t('selectRolePreset'),
                    style: const TextStyle(fontSize: 12),
                  ),
                  style: TextButton.styleFrom(
                    foregroundColor: const Color(0xFF6aa3ff),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    minimumSize: const Size(0, 28),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  onPressed: _loadingPresets ? null : _pickPreset,
                ),
              ],
            ),
            const SizedBox(height: 4),
            TextField(
              controller: _roleCtrl,
              maxLines: 3,
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
              decoration: sheetInputDecoration(
                hint: t('optionalInheritFleetRole'),
              ),
            ),
            const SizedBox(height: 12),
            // ── Provider ──
            const Text(
              'Provider',
              style: TextStyle(color: Color(0xFF8a909b), fontSize: 11),
            ),
            const SizedBox(height: 4),
            DropdownButtonFormField<String>(
              value: _pickedProvider ?? '',
              dropdownColor: const Color(0xFF0f1115),
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
              decoration: sheetInputDecoration(),
              items: [
                if (!_hasConcreteDefaultProvider)
                  DropdownMenuItem(
                    value: '',
                    child: Text(
                      t('defaultLogin'),
                      style: const TextStyle(color: Color(0xFFe7eaee)),
                    ),
                  ),
                ...widget.providers.map(
                  (p) => DropdownMenuItem(
                    value: p['id'] as String,
                    child: Text(
                      '${p['id'] == widget.defaultProviderId ? t('defaultProviderPrefix') : ''}${p['name']}'
                      '${p['isOfficial'] == true ? t('subscriptionSuffix') : ''}'
                      '${(p['model'] as String? ?? '').isNotEmpty ? ' · ${p['model']}' : ''}',
                      style: const TextStyle(color: Color(0xFFe7eaee)),
                    ),
                  ),
                ),
              ],
              onChanged: _onProviderChanged,
            ),
            // ── Model (linked to provider) ──
            const SizedBox(height: 12),
            Text(
              t('model'),
              style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
            ),
            const SizedBox(height: 4),
            DropdownButtonFormField<String>(
              value: _customModel ? '__custom__' : _pickedModel,
              dropdownColor: const Color(0xFF0f1115),
              style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
              decoration: sheetInputDecoration(),
              items: [
                ...modelOptions.map(
                  (e) => DropdownMenuItem(
                    value: e.key,
                    child: Text(
                      e.value,
                      style: const TextStyle(color: Color(0xFFe7eaee)),
                    ),
                  ),
                ),
                DropdownMenuItem(
                  value: '__custom__',
                  child: Text(
                    t('customOption'),
                    style: const TextStyle(color: Color(0xFF8a909b)),
                  ),
                ),
              ],
              onChanged: (v) {
                setState(() {
                  if (v == '__custom__') {
                    _customModel = true;
                    _pickedModel = null;
                  } else {
                    _customModel = false;
                    _pickedModel = v;
                  }
                });
              },
            ),
            if (_customModel) ...[
              const SizedBox(height: 6),
              TextField(
                controller: _customModelCtrl,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                decoration: sheetInputDecoration(
                  hint: _isClaude
                      ? t('claudeModelIdHint')
                      : t('codexModelIdHint'),
                ),
                autofocus: true,
              ),
            ],
            if (widget.cli.supportsEffort) ...[
              const SizedBox(height: 12),
              Text(
                widget.cli.effortFieldLabel,
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 4),
              DropdownButtonFormField<String>(
                value: _pickedEffort,
                dropdownColor: const Color(0xFF0f1115),
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                decoration: sheetInputDecoration(),
                items: widget.cli.effortOptions
                    .map((e) => DropdownMenuItem(
                          value: e,
                          child: Text(
                            _isClaude ? e : effortShortNameForCli(widget.cli, e),
                            style: const TextStyle(color: Color(0xFFe7eaee)),
                          ),
                        ))
                    .toList(),
                onChanged: (v) => setState(() => _pickedEffort = v ?? _defaultEffort),
              ),
            ],
            if (widget.cli.supportsAgent) ...[
              const SizedBox(height: 12),
              Text(
                '${widget.cli.displayName} Agent',
                style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11),
              ),
              const SizedBox(height: 4),
              TextField(
                controller: _agentCtrl,
                maxLength: 80,
                style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 13),
                decoration: sheetInputDecoration(
                  hint: widget.cli == SessionCli.opencode
                      ? t('agentBuildHint')
                      : t('agentNameHint'),
                ).copyWith(counterText: ''),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: Text(
            t('cancel'),
            style: const TextStyle(color: Color(0xFF8a909b)),
          ),
        ),
        ElevatedButton(
          style: ElevatedButton.styleFrom(
            backgroundColor: const Color(0xFF22ab9c),
            foregroundColor: Colors.white,
          ),
          onPressed: _submit,
          child: Text(t('create')),
        ),
      ],
    );
  }
}
