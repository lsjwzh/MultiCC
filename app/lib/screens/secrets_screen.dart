import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../i18n.dart';
import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// 敏感信息保险箱 — 镜像网页 /manage「敏感信息」面板：
/// 列表只拿元数据；值仅在用户点「显示」时单条读取，不落日志。
/// 添加/更新走 POST /api/secrets，与聊天的 request_secret_input 安全弹框
/// 存的是同一个本地保险箱，值永不经对话与 LLM API。
class SecretsScreen extends StatefulWidget {
  final SettingsService settings;

  /// Injectable for tests (MockClient)；生产调用方不传。
  final http.Client? httpClient;
  const SecretsScreen({super.key, required this.settings, this.httpClient});

  @override
  State<SecretsScreen> createState() => _SecretsScreenState();
}

class _SecretsScreenState extends State<SecretsScreen> {
  late final ManageService _manage =
      ManageService(settings: widget.settings, httpClient: widget.httpClient);

  static final RegExp _nameRe = RegExp(r'^[A-Za-z0-9_.-]{1,64}$');

  List<Map<String, dynamic>> _entries = [];
  bool _loading = true;
  String? _error;

  late final TextEditingController _nameCtrl;
  late final TextEditingController _valueCtrl;
  late final TextEditingController _descCtrl;
  bool _obscureValue = true;
  bool _saving = false;
  String? _saveStatus;

  // name → 单条显示的值（点「显示」才填入，再点「隐藏」即丢弃）。
  final Map<String, String> _revealed = {};

  @override
  void initState() {
    super.initState();
    _nameCtrl = TextEditingController();
    _valueCtrl = TextEditingController();
    _descCtrl = TextEditingController();
    _refresh();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _valueCtrl.dispose();
    _descCtrl.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final entries = await _manage.fetchSecrets();
      if (!mounted) return;
      // 条目可能已被别处删除：丢弃已失效的单条显示值。
      _revealed.removeWhere((name, _) =>
          !entries.any((e) => e['name'] == name));
      setState(() {
        _entries = entries;
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

  Future<void> _save() async {
    final name = _nameCtrl.text.trim();
    final value = _valueCtrl.text;
    if (!_nameRe.hasMatch(name)) {
      setState(() => _saveStatus = t('secretsNameInvalid'));
      return;
    }
    if (value.isEmpty) {
      setState(() => _saveStatus = t('secretsValueRequired'));
      return;
    }
    setState(() {
      _saving = true;
      _saveStatus = null;
    });
    try {
      await _manage.saveSecret(
        name,
        value,
        description: _descCtrl.text,
      );
      if (!mounted) return;
      setState(() {
        _saveStatus = t('saved');
        _nameCtrl.clear();
        _valueCtrl.clear();
        _descCtrl.clear();
        _obscureValue = true;
      });
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() => _saveStatus = t('saveFailed', {'error': '$e'}));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _delete(Map<String, dynamic> entry) async {
    final name = entry['name'] as String;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.panel,
        title: Text(
          t('secretsDeleteTitle', {'name': name}),
          style: const TextStyle(color: AppColors.text, fontSize: 16),
        ),
        content: Text(
          t('secretsDeleteBody'),
          style: const TextStyle(color: AppColors.muted, fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(
              t('cancel'),
              style: const TextStyle(color: AppColors.muted),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(
              t('delete'),
              style: const TextStyle(color: AppColors.danger),
            ),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _manage.deleteSecret(name);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(t('saveFailed', {'error': '$e'}))),
        );
      }
    }
    await _refresh();
  }

  Future<void> _toggleReveal(Map<String, dynamic> entry) async {
    final name = entry['name'] as String;
    if (_revealed.containsKey(name)) {
      setState(() => _revealed.remove(name));
      return;
    }
    try {
      final value = await _manage.revealSecret(name);
      if (!mounted) return;
      setState(() => _revealed[name] = value);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(t('saveFailed', {'error': '$e'}))),
        );
      }
    }
  }

  String _fmtTime(dynamic iso) {
    final s = iso == null ? '' : iso.toString();
    if (s.length < 16) return s;
    // 截原串展示本地写法（服务端是 UTC ISO 串；DateTime.tryParse 会把带
    // 偏移的串解析成 UTC 值，直接取字段会差 8 小时）。
    return s.substring(0, 16).replaceAll('T', ' ');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(title: Text(t('secretsVaultTitle'))),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 40),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              t('secretsVaultHint'),
              style: const TextStyle(
                color: AppColors.muted,
                fontSize: 12,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 14),
            // ── 添加 / 更新 ──
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.panel,
                border: Border.all(color: AppColors.line),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    t('secretsAddTitle'),
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    key: const Key('secrets-add-name'),
                    controller: _nameCtrl,
                    autocorrect: false,
                    enableSuggestions: false,
                    style: const TextStyle(color: AppColors.text, fontSize: 14),
                    decoration: InputDecoration(
                      isDense: true,
                      labelText: t('secretsFieldName'),
                      labelStyle: const TextStyle(color: AppColors.muted),
                      hintText: 'OPENAI_API_KEY',
                      hintStyle: const TextStyle(color: AppColors.faint),
                      filled: true,
                      fillColor: AppColors.bgSoft,
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    key: const Key('secrets-add-value'),
                    controller: _valueCtrl,
                    obscureText: _obscureValue,
                    autocorrect: false,
                    enableSuggestions: false,
                    style: const TextStyle(color: AppColors.text, fontSize: 14),
                    decoration: InputDecoration(
                      isDense: true,
                      labelText: t('secretsFieldValue'),
                      labelStyle: const TextStyle(color: AppColors.muted),
                      filled: true,
                      fillColor: AppColors.bgSoft,
                      border: const OutlineInputBorder(),
                      suffixIcon: IconButton(
                        key: const Key('secrets-add-value-toggle'),
                        icon: Icon(
                          _obscureValue
                              ? Icons.visibility_outlined
                              : Icons.visibility_off_outlined,
                          size: 18,
                          color: AppColors.faint,
                        ),
                        onPressed: () => setState(
                          () => _obscureValue = !_obscureValue,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    key: const Key('secrets-add-desc'),
                    controller: _descCtrl,
                    style: const TextStyle(color: AppColors.text, fontSize: 14),
                    decoration: InputDecoration(
                      isDense: true,
                      labelText: t('secretsFieldDesc'),
                      labelStyle: const TextStyle(color: AppColors.muted),
                      filled: true,
                      fillColor: AppColors.bgSoft,
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  if (_saveStatus != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      _saveStatus!,
                      style: const TextStyle(
                        color: AppColors.accent,
                        fontSize: 13,
                      ),
                    ),
                  ],
                  const SizedBox(height: 14),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      key: const Key('secrets-add-save'),
                      onPressed: _saving ? null : _save,
                      child: _saving
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Color(0xFFffffff),
                              ),
                            )
                          : Text(
                              t('save'),
                              style: const TextStyle(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            // ── 条目列表 ──
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(
                  child: SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              )
            else if (_error != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(
                  _error!,
                  style: const TextStyle(color: AppColors.danger, fontSize: 13),
                ),
              )
            else if (_entries.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(
                  t('secretsEmpty'),
                  style: const TextStyle(color: AppColors.faint, fontSize: 13),
                ),
              )
            else
              for (final entry in _entries) _row(entry),
          ],
        ),
      ),
    );
  }

  Widget _row(Map<String, dynamic> entry) {
    final name = entry['name'] as String;
    final description = (entry['description'] ?? '') as String;
    final source = (entry['source'] ?? 'user') as String;
    final revealed = _revealed[name];
    return Container(
      key: Key('secrets-row-$name'),
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.key_rounded,
            size: 18,
            color: AppColors.accent,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  style: const TextStyle(
                    color: AppColors.text,
                    fontSize: 13,
                    fontFamily: 'monospace',
                  ),
                ),
                if (revealed != null)
                  Text(
                    revealed,
                    key: Key('secrets-revealed-$name'),
                    style: const TextStyle(
                      color: AppColors.accent,
                      fontSize: 12,
                      fontFamily: 'monospace',
                    ),
                  ),
                if (description.isNotEmpty)
                  Text(
                    description,
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 12,
                    ),
                  ),
                const SizedBox(height: 2),
                Text(
                  '${source == 'agent' ? t('secretsSourceAgent') : t('secretsSourceUser')} · ${_fmtTime(entry['updatedAt'])}',
                  style: const TextStyle(color: AppColors.faint, fontSize: 11),
                ),
              ],
            ),
          ),
          IconButton(
            key: Key('secrets-reveal-$name'),
            tooltip: revealed == null ? t('secretsShow') : t('secretsHide'),
            icon: Icon(
              revealed == null
                  ? Icons.visibility_outlined
                  : Icons.visibility_off_outlined,
              size: 18,
              color: AppColors.faint,
            ),
            onPressed: () => _toggleReveal(entry),
          ),
          IconButton(
            key: Key('secrets-delete-$name'),
            tooltip: t('delete'),
            icon: const Icon(
              Icons.delete_outline,
              size: 18,
              color: AppColors.danger,
            ),
            onPressed: () => _delete(entry),
          ),
        ],
      ),
    );
  }
}
