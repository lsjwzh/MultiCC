import 'package:flutter/material.dart';

import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// Provider 配置。镜像网页管理台的「Provider」页：从 cc-switch 导入/同步，
/// 在 multicc 自己的存储里增删改，设全局默认（claude / codex 各一个）。
/// 每个会话可在聊天页单独切换 provider，互相独立。
class ProviderScreen extends StatefulWidget {
  final SettingsService settings;
  const ProviderScreen({super.key, required this.settings});

  @override
  State<ProviderScreen> createState() => _ProviderScreenState();
}

class _ProviderScreenState extends State<ProviderScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);

  List<Map<String, dynamic>> _providers = [];
  Map<String, dynamic> _defaults = {'claude': null, 'codex': null};
  bool _ccSwitchAvailable = false;
  bool _loading = true;
  bool _importing = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final d = await _manage.fetchProviders();
      if (!mounted) return;
      setState(() {
        _providers = (d['providers'] as List? ?? [])
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList();
        _defaults = (d['defaults'] as Map?)?.cast<String, dynamic>() ?? {'claude': null, 'codex': null};
        _ccSwitchAvailable = d['ccSwitchAvailable'] == true;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  List<Map<String, dynamic>> _byType(String t) =>
      _providers.where((p) => p['appType'] == t).toList();

  Future<void> _import() async {
    setState(() => _importing = true);
    try {
      final r = await _manage.importProviders();
      _snack('从 cc-switch 同步：新增 ${r['imported']}、刷新 ${r['updated']}（共 ${r['total']}）');
      await _refresh();
    } catch (e) {
      _snack('导入失败：$e');
    } finally {
      if (mounted) setState(() => _importing = false);
    }
  }

  Future<void> _setDefault(String cli, String? id) async {
    try {
      await _manage.setProviderDefaults(
        claude: cli == 'claude' ? (id ?? '') : null,
        codex: cli == 'codex' ? (id ?? '') : null,
      );
      setState(() => _defaults[cli] = id);
      _snack('已设置 $cli 默认 provider');
    } catch (e) {
      _snack('设置失败：$e');
    }
  }

  Future<void> _delete(Map<String, dynamic> p) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('删除 Provider'),
        content: Text('确定删除「${p['name']}」？（只从 multicc 移除，不影响 cc-switch）'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消', style: TextStyle(color: AppColors.muted))),
          TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('删除', style: TextStyle(color: AppColors.danger))),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _manage.deleteProvider(p['appType'] as String, p['id'] as String);
      await _refresh();
    } catch (e) {
      _snack('删除失败：$e');
    }
  }

  Future<void> _openEditor({Map<String, dynamic>? provider}) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (_) => _ProviderEditor(manage: _manage, provider: provider),
    );
    if (saved == true) await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: const Text('Provider'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: AppColors.muted),
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openEditor(),
        backgroundColor: AppColors.accentDark,
        foregroundColor: const Color(0xFF04110f),
        icon: const Icon(Icons.add_rounded),
        label: const Text('新建'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.accent))
          : _error != null
              ? _ErrorView(message: _error!, onRetry: _refresh)
              : RefreshIndicator(
                  color: AppColors.accent,
                  backgroundColor: AppColors.panel,
                  onRefresh: _refresh,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(12, 12, 12, 96),
                    children: [
                      _importCard(),
                      const SizedBox(height: 16),
                      _defaultsCard(),
                      const SizedBox(height: 16),
                      if (_providers.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 24),
                          child: Text('还没有 provider。点上方「从 cc-switch 导入」或右下角「新建」。',
                              textAlign: TextAlign.center,
                              style: TextStyle(color: AppColors.faint, fontSize: 13)),
                        )
                      else ...[
                        _providerGroup('🤖 Claude', _byType('claude')),
                        const SizedBox(height: 16),
                        _providerGroup('⚡ Codex', _byType('codex')),
                      ],
                    ],
                  ),
                ),
    );
  }

  Widget _providerGroup(String label, List<Map<String, dynamic>> providers) {
    if (providers.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(left: 4, bottom: 4),
        child: Text('$label（无）',
            style: const TextStyle(color: AppColors.faint, fontSize: 12, fontWeight: FontWeight.w600)),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 8),
          child: Text('$label（${providers.length}）',
              style: const TextStyle(color: AppColors.faint, fontSize: 12, fontWeight: FontWeight.w600)),
        ),
        ...providers.map((p) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _ProviderCard(
                p: p,
                onEdit: () => _openEditor(provider: p),
                onDelete: () => _delete(p),
              ),
            )),
      ],
    );
  }

  Widget _importCard() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('从 cc-switch 导入 / 同步',
              style: TextStyle(color: AppColors.textBright, fontSize: 14, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          Text(
            _ccSwitchAvailable
                ? '把 cc-switch 里的 provider 同步进 multicc 自己的存储（按来源去重，可重复同步）。导入后可自由编辑/删除，不影响 cc-switch。'
                : '未检测到 cc-switch 数据库（~/.cc-switch/cc-switch.db），无法导入。仍可手动新建。',
            style: const TextStyle(color: AppColors.faint, fontSize: 12, height: 1.5),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 42,
            child: OutlinedButton.icon(
              onPressed: (_importing || !_ccSwitchAvailable) ? null : _import,
              icon: _importing
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.accent))
                  : const Icon(Icons.download_rounded, size: 18, color: AppColors.accent),
              label: Text(_importing ? '导入中…' : '从 cc-switch 导入', style: const TextStyle(color: AppColors.accent)),
              style: OutlinedButton.styleFrom(side: const BorderSide(color: AppColors.lineStrong)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _defaultsCard() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('全局默认 Provider',
              style: TextStyle(color: AppColors.textBright, fontSize: 14, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text('新建会话自动套用。「默认登录」= 走本机订阅 / OAuth。',
              style: TextStyle(color: AppColors.faint, fontSize: 12)),
          const SizedBox(height: 12),
          _defaultRow('claude', 'Claude'),
          const SizedBox(height: 10),
          _defaultRow('codex', 'Codex'),
        ],
      ),
    );
  }

  Widget _defaultRow(String cli, String label) {
    final list = _byType(cli);
    final cur = _defaults[cli] as String?;
    // Guard: only offer a value the dropdown actually has.
    final value = list.any((p) => p['id'] == cur) ? cur : null;
    return Row(
      children: [
        SizedBox(width: 64, child: Text(label, style: const TextStyle(color: AppColors.text, fontSize: 14))),
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: AppColors.panel2,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AppColors.line),
            ),
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String?>(
                value: value,
                isExpanded: true,
                dropdownColor: AppColors.panel2,
                style: const TextStyle(color: AppColors.text, fontSize: 13.5),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('默认登录 / 订阅')),
                  ...list.map((p) => DropdownMenuItem<String?>(
                        value: p['id'] as String,
                        child: Text(_providerLabel(p), overflow: TextOverflow.ellipsis),
                      )),
                ],
                onChanged: (v) => _setDefault(cli, v),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

String _providerLabel(Map<String, dynamic> p) {
  final bits = <String>[p['name'] as String? ?? ''];
  if (p['isOfficial'] == true) {
    bits.add('· 订阅');
  } else if ((p['baseUrl'] as String? ?? '').isNotEmpty) {
    bits.add('· ${(p['baseUrl'] as String).replaceFirst(RegExp(r'^https?://'), '')}');
  }
  return bits.join(' ');
}

// ── Provider card ────────────────────────────────────────────────────────────

class _ProviderCard extends StatelessWidget {
  final Map<String, dynamic> p;
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  const _ProviderCard({required this.p, required this.onEdit, required this.onDelete});

  @override
  Widget build(BuildContext context) {
    final official = p['isOfficial'] == true;
    final baseUrl = p['baseUrl'] as String? ?? '';
    final model = p['model'] as String? ?? '';
    final models = (p['modelOptions'] as List? ?? [])
        .map((e) => e.toString())
        .where((e) => e.trim().isNotEmpty)
        .toList();
    final tokenMask = p['tokenMask'] as String? ?? '';
    final source = p['source'] as String? ?? 'local';
    final proxied = p['useChatResponsesProxy'] == true;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(p['name'] as String? ?? '',
                    style: const TextStyle(color: AppColors.textBright, fontWeight: FontWeight.w700, fontSize: 15),
                    overflow: TextOverflow.ellipsis),
              ),
              Text(source == 'ccswitch' ? '来自 cc-switch' : '本地',
                  style: const TextStyle(color: AppColors.faint, fontSize: 11)),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            official ? '默认登录 / 订阅' : baseUrl,
            style: const TextStyle(color: AppColors.muted, fontSize: 12.5),
            overflow: TextOverflow.ellipsis,
          ),
          if (model.isNotEmpty || models.length > 1 || tokenMask.isNotEmpty || proxied) ...[
            const SizedBox(height: 4),
            Text(
              [
                if (models.length > 1) '${models.length} models' else if (model.isNotEmpty) model,
                if (proxied) 'chat→responses',
                if (tokenMask.isNotEmpty) tokenMask,
              ].join(' · '),
              style: const TextStyle(color: AppColors.faint, fontSize: 11.5, fontFamily: 'monospace'),
              overflow: TextOverflow.ellipsis,
            ),
          ],
          const Divider(height: 18, color: AppColors.line),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton.icon(
                onPressed: onEdit,
                icon: const Icon(Icons.edit_outlined, size: 17, color: AppColors.blue),
                label: const Text('编辑', style: TextStyle(color: AppColors.blue, fontSize: 13)),
              ),
              IconButton(
                onPressed: onDelete,
                icon: const Icon(Icons.delete_outline_rounded, size: 19, color: AppColors.danger),
                tooltip: '删除',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ── Editor bottom sheet ──────────────────────────────────────────────────────

class _ProviderEditor extends StatefulWidget {
  final ManageService manage;
  final Map<String, dynamic>? provider;
  const _ProviderEditor({required this.manage, this.provider});

  @override
  State<_ProviderEditor> createState() => _ProviderEditorState();
}

class _ProviderEditorState extends State<_ProviderEditor> {
  late final TextEditingController _name;
  late final TextEditingController _baseUrl;
  late final TextEditingController _token;
  late final TextEditingController _model;
  late final TextEditingController _models;
  late String _appType;
  late bool _useChatResponsesProxy;
  bool _obscureKey = true;
  bool _saving = false;
  String? _err;

  bool get _isEdit => widget.provider != null;

  @override
  void initState() {
    super.initState();
    final p = widget.provider;
    _appType = (p?['appType'] as String?) ?? 'claude';
    _name = TextEditingController(text: p?['name'] as String? ?? '');
    _baseUrl = TextEditingController(text: p?['baseUrl'] as String? ?? '');
    _token = TextEditingController();
    _model = TextEditingController(text: p?['model'] as String? ?? '');
    final modelOptions = (p?['modelOptions'] as List? ?? [])
        .map((e) => e.toString())
        .where((e) => e.trim().isNotEmpty)
        .toList();
    _models = TextEditingController(text: modelOptions.join('\n'));
    _useChatResponsesProxy = p?['useChatResponsesProxy'] == true;
  }

  @override
  void dispose() {
    _name.dispose();
    _baseUrl.dispose();
    _token.dispose();
    _model.dispose();
    _models.dispose();
    super.dispose();
  }

  List<String> _modelList() {
    final values = <String>[_model.text.trim()];
    values.addAll(_models.text.split(RegExp(r'[\n,]')).map((e) => e.trim()));
    final seen = <String>{};
    return values.where((e) => e.isNotEmpty && seen.add(e)).toList();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) return setState(() => _err = '名称不能为空');
    setState(() {
      _saving = true;
      _err = null;
    });
    try {
      if (_isEdit) {
        await widget.manage.updateProvider(
          widget.provider!['appType'] as String,
          widget.provider!['id'] as String,
          name: name,
          baseUrl: _baseUrl.text.trim(),
          authToken: _token.text.trim(),
          model: _model.text.trim(),
          models: _modelList(),
          useChatResponsesProxy: _useChatResponsesProxy,
        );
      } else {
        await widget.manage.createProvider(
          appType: _appType,
          name: name,
          baseUrl: _baseUrl.text.trim(),
          authToken: _token.text.trim(),
          model: _model.text.trim(),
          models: _modelList(),
          useChatResponsesProxy: _useChatResponsesProxy,
        );
      }
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _err = '$e';
          _saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    final hasToken = widget.provider?['hasToken'] == true;
    final mask = widget.provider?['tokenMask'] as String? ?? '';
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 14, 16, 16 + bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 38,
                height: 4,
                margin: const EdgeInsets.only(bottom: 14),
                decoration: BoxDecoration(color: AppColors.line, borderRadius: BorderRadius.circular(2)),
              ),
            ),
            Text(_isEdit ? '编辑 Provider' : '新建 Provider',
                style: const TextStyle(color: AppColors.textBright, fontSize: 16, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            if (!_isEdit) ...[
              const _FieldLabel('类型'),
              Row(children: [
                _typeChoice('claude', 'Claude'),
                const SizedBox(width: 8),
                _typeChoice('codex', 'Codex'),
              ]),
              const SizedBox(height: 14),
            ],
            const _FieldLabel('名称'),
            _input(_name, hint: '如 DeepSeek / OpenRouter'),
            const SizedBox(height: 14),
            const _FieldLabel('Base URL'),
            _input(_baseUrl, hint: 'https://api.deepseek.com/anthropic（留空=官方/订阅）', mono: true),
            const SizedBox(height: 14),
            const _FieldLabel('API Key'),
            _input(_token,
                hint: hasToken ? '留空 = 保留原 key（$mask）' : 'sk-...',
                obscure: _obscureKey,
                suffix: IconButton(
                  icon: Icon(_obscureKey ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                      size: 18, color: AppColors.muted),
                  onPressed: () => setState(() => _obscureKey = !_obscureKey),
                  tooltip: _obscureKey ? '显示 Key' : '隐藏 Key',
                  splashRadius: 16,
                )),
            const SizedBox(height: 14),
            const _FieldLabel('Model（可选）'),
            _input(_model, hint: '如 deepseek-chat', mono: true),
            const SizedBox(height: 14),
            const _FieldLabel('可用模型列表（每行一个，可选）'),
            _input(_models, hint: 'deepseek-chat\ndeepseek-reasoner', mono: true, maxLines: 3),
            if (_appType == 'codex') ...[
              const SizedBox(height: 10),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                value: _useChatResponsesProxy,
                activeColor: AppColors.accent,
                title: const Text('OpenAI chat 协议转 response 协议',
                    style: TextStyle(color: AppColors.text, fontSize: 13.5)),
                subtitle: const Text('勾选后运行时使用本地代理；列表中仍显示你填写的 Base URL。',
                    style: TextStyle(color: AppColors.faint, fontSize: 12)),
                onChanged: (v) => setState(() => _useChatResponsesProxy = v),
              ),
            ],
            if (_err != null) ...[
              const SizedBox(height: 10),
              Text(_err!, style: const TextStyle(color: AppColors.danger, fontSize: 12.5)),
            ],
            const SizedBox(height: 18),
            SizedBox(
              height: 48,
              child: ElevatedButton(
                onPressed: _saving ? null : _save,
                child: _saving
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF04110f)))
                    : Text(_isEdit ? '保存' : '创建'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _typeChoice(String value, String label) {
    final sel = _appType == value;
    return Expanded(
      child: GestureDetector(
        onTap: () => setState(() {
          _appType = value;
          if (value != 'codex') _useChatResponsesProxy = false;
        }),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 11),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: sel ? AppColors.accentDark.withValues(alpha: 0.18) : AppColors.panel2,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: sel ? AppColors.accent : AppColors.line),
          ),
          child: Text(label,
              style: TextStyle(
                  color: sel ? AppColors.accent : AppColors.muted,
                  fontWeight: FontWeight.w600,
                  fontSize: 13.5)),
        ),
      ),
    );
  }

  Widget _input(TextEditingController c,
      {String? hint, bool mono = false, bool obscure = false, int maxLines = 1, Widget? suffix}) {
    return TextField(
      controller: c,
      obscureText: obscure,
      maxLines: obscure ? 1 : maxLines,
      autocorrect: false,
      enableSuggestions: false,
      style: TextStyle(color: AppColors.text, fontSize: 14, fontFamily: mono ? 'monospace' : null),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: AppColors.faint, fontSize: 12.5),
        filled: true,
        fillColor: AppColors.panel2,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        suffixIcon: suffix,
        enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: AppColors.line)),
        focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: AppColors.accent)),
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  final String text;
  const _FieldLabel(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6, left: 2),
        child: Text(text,
            style: const TextStyle(color: AppColors.muted, fontSize: 12.5, fontWeight: FontWeight.w500)),
      );
}

class _ErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorView({required this.message, required this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off_rounded, size: 42, color: AppColors.faint),
              const SizedBox(height: 14),
              Text('加载失败\n$message',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: AppColors.muted, fontSize: 13, height: 1.5)),
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: onRetry,
                style: OutlinedButton.styleFrom(side: const BorderSide(color: AppColors.lineStrong)),
                child: const Text('重试', style: TextStyle(color: AppColors.accent)),
              ),
            ],
          ),
        ),
      );
}
