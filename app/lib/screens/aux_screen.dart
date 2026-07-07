import 'package:flutter/material.dart';

import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import 'aux_history_screen.dart';

/// AI 助手 (aux) 面板。聚合 aux 的配置、健康状态、重跑操作和任务历史入口——
/// 镜像网页管理台 manage.html 里的 aux-section + aux-modal 那一整套。
///
/// • 配置：选 cli / provider / model / effort（POST /api/aux/config）
/// • 健康：显示 aux 是否可用、连续失败次数（GET /api/aux/health）
/// • 重跑所有会话：用当前 aux 模型重新判定每个会话的目标·阶段
/// • 任务历史：跳到 AuxHistoryScreen 看每次 aux 任务的输入输出
class AuxScreen extends StatefulWidget {
  final SettingsService settings;
  const AuxScreen({super.key, required this.settings});

  @override
  State<AuxScreen> createState() => _AuxScreenState();
}

class _AuxScreenState extends State<AuxScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);
  Map<String, dynamic>? _config;
  Map<String, dynamic>? _health;
  bool _loading = true;
  bool _saving = false;
  bool _reclassifying = false;
  String? _error;

  // editor state
  String _cli = 'claude';
  String _providerId = '';
  String _model = '';
  String _effort = 'medium';

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
      final results = await Future.wait([
        _manage.fetchAuxConfig(),
        _manage.fetchAuxHealth(),
      ]);
      final cfg = results[0];
      final hlt = results[1];
      if (!mounted) return;
      setState(() {
        _config = cfg;
        _health = hlt;
        _cli = (cfg['cli']?.toString() ?? 'claude') == 'codex' ? 'codex' : 'claude';
        _providerId = cfg['providerId']?.toString() ?? '';
        _model = cfg['model']?.toString() ?? '';
        _effort = cfg['effort']?.toString() ?? (_cli == 'codex' ? 'xhigh' : 'medium');
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

  List<Map<String, dynamic>> _providersFor(String cli) {
    if (_config == null) return [];
    final key = cli == 'codex' ? 'codexProviders' : 'claudeProviders';
    final list = _config![key] ?? _config!['providers'];
    if (list is! List) return [];
    return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  List<String> _modelsFor(String cli, String providerId) {
    final provs = _providersFor(cli);
    final p = provs.firstWhere((p) => p['id'] == providerId, orElse: () => {});
    final opts = p['modelOptions'];
    if (opts is List) {
      return opts.map((e) => e.toString()).where((e) => e.trim().isNotEmpty).toList();
    }
    // No provider or no model list → claude falls back to tier aliases; codex has none.
    return cli == 'claude' ? const ['haiku', 'sonnet', 'opus', 'fable'] : const [];
  }

  List<String> _effortOptsFor(String cli) {
    return cli == 'codex'
        ? const ['low', 'medium', 'high', 'xhigh']
        : const ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await _manage.saveAuxConfig(
        cli: _cli,
        providerId: _providerId,
        model: _model,
        effort: _effort,
      );
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('AI 助手配置已保存 ✓')));
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _saving = false;
      });
    }
  }

  Future<void> _reclassifyAll() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('重跑所有会话'),
        content: const Text('用当前 AI 助手模型，重新判定所有会话的目标与阶段。'
            'aux 服务不可用时会被拒绝。确认继续？'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消', style: TextStyle(color: AppColors.muted))),
          TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('重跑', style: TextStyle(color: AppColors.danger))),
        ],
      ),
    );
    if (ok != true) return;
    setState(() {
      _reclassifying = true;
      _error = null;
    });
    try {
      final r = await _manage.reclassifyAll(onlyJunk: false);
      if (!mounted) return;
      final count = r['count'] ?? 0;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('已重跑 $count 个会话')));
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _reclassifying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        title: const Text('AI 助手'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, color: AppColors.muted),
            onPressed: _loading ? null : _refresh,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.accent))
          : _error != null && _config == null
              ? _ErrorView(message: _error!, onRetry: _refresh)
              : RefreshIndicator(
                  color: AppColors.accent,
                  backgroundColor: AppColors.panel,
                  onRefresh: _refresh,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(12, 12, 12, 32),
                    children: [
                      _healthCard(),
                      const SizedBox(height: 14),
                      _configCard(),
                      const SizedBox(height: 14),
                      _actionsCard(),
                    ],
                  ),
                ),
    );
  }

  Widget _healthCard() {
    final h = (_health?['health'] as Map?)?.cast<String, dynamic>() ?? {};
    final unhealthy = h['unhealthy'] == true;
    final fails = (h['consecutiveFails'] as num?)?.toInt() ?? 0;
    final sinceAt = h['sinceAt']?.toString();
    final lastFail = h['lastFailMsg']?.toString() ?? '';
    final Color dotColor = unhealthy ? AppColors.danger : const Color(0xFF56d364);
    final statusText = unhealthy ? '不可用' : '正常';
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
              Container(width: 8, height: 8, decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle)),
              const SizedBox(width: 8),
              Text('aux 服务：$statusText',
                  style: const TextStyle(color: AppColors.textBright, fontSize: 14, fontWeight: FontWeight.w700)),
              const Spacer(),
              if (unhealthy) Text('连续失败 $fails 次', style: const TextStyle(color: AppColors.danger, fontSize: 11)),
            ],
          ),
          if (unhealthy && lastFail.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(lastFail,
                style: const TextStyle(color: AppColors.muted, fontSize: 11.5, fontFamily: 'monospace'),
                maxLines: 2, overflow: TextOverflow.ellipsis),
          ],
          if (unhealthy && sinceAt != null && sinceAt.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text('自 $sinceAt 起',
                style: const TextStyle(color: AppColors.faint, fontSize: 10)),
          ],
        ],
      ),
    );
  }

  Widget _configCard() {
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
          const Text('助手模型',
              style: TextStyle(color: AppColors.textBright, fontSize: 14, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text('辅助 AI 用来判定会话目标·阶段、goal 预检等。选默认登录走本机订阅。',
              style: TextStyle(color: AppColors.faint, fontSize: 12, height: 1.4)),
          const SizedBox(height: 14),
          // cli
          const _Label('CLI'),
          Row(children: [
            _typeChoice('claude', 'Claude'),
            const SizedBox(width: 8),
            _typeChoice('codex', 'Codex'),
          ]),
          const SizedBox(height: 14),
          // provider
          const _Label('Provider'),
          _dropdown(
            value: _providerId,
            hint: '默认登录 / 订阅',
            items: _providersFor(_cli)
                .map((p) => DropdownMenuItem(value: p['id'] as String, child: Text(p['name']?.toString() ?? '')))
                .toList(),
            onChanged: (v) => setState(() {
              _providerId = v ?? '';
              // reset model if it's no longer valid for the new provider
              final models = _modelsFor(_cli, _providerId);
              if (models.isNotEmpty && !models.contains(_model)) _model = '';
            }),
          ),
          const SizedBox(height: 14),
          // model
          const _Label('Model（留空=默认）'),
          _dropdown(
            value: _model.isEmpty ? null : _model,
            hint: '默认',
            items: _modelsFor(_cli, _providerId)
                .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                .toList(),
            onChanged: (v) => setState(() => _model = v ?? ''),
          ),
          const SizedBox(height: 14),
          // effort
          const _Label('推理强度（仅 CLI 回退模式生效）'),
          _dropdown(
            value: _effort,
            hint: 'effort',
            items: _effortOptsFor(_cli)
                .map((e) => DropdownMenuItem(value: e, child: Text(e)))
                .toList(),
            onChanged: (v) => setState(() => _effort = v ?? _effort),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: AppColors.danger, fontSize: 12.5)),
          ],
          const SizedBox(height: 16),
          SizedBox(
            height: 46,
            child: ElevatedButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF04110f)))
                  : const Text('保存配置'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _actionsCard() {
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
          const Text('操作',
              style: TextStyle(color: AppColors.textBright, fontSize: 14, fontWeight: FontWeight.w700)),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: _reclassifying ? null : _reclassifyAll,
            icon: _reclassifying
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.accent))
                : const Icon(Icons.replay_rounded, size: 18, color: AppColors.accent),
            label: Text(_reclassifying ? '重跑中…' : '重跑所有会话',
                style: const TextStyle(color: AppColors.accent, fontSize: 13.5)),
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: AppColors.lineStrong),
              minimumSize: const Size.fromHeight(44),
            ),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute<void>(builder: (_) => AuxHistoryScreen(settings: widget.settings)),
            ),
            icon: const Icon(Icons.history_rounded, size: 18, color: AppColors.blue),
            label: const Text('任务历史', style: TextStyle(color: AppColors.blue, fontSize: 13.5)),
            style: OutlinedButton.styleFrom(
              side: const BorderSide(color: AppColors.lineStrong),
              minimumSize: const Size.fromHeight(44),
            ),
          ),
        ],
      ),
    );
  }

  Widget _typeChoice(String value, String label) {
    final sel = _cli == value;
    return Expanded(
      child: GestureDetector(
        onTap: () => setState(() {
          _cli = value;
          // provider/model may not exist for the other cli → reset
          _providerId = '';
          _model = '';
          _effort = value == 'codex' ? 'xhigh' : 'medium';
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
                  color: sel ? AppColors.accent : AppColors.muted, fontWeight: FontWeight.w600, fontSize: 13.5)),
        ),
      ),
    );
  }

  Widget _dropdown({
    required String? value,
    required String hint,
    required List<DropdownMenuItem<String>> items,
    required ValueChanged<String?> onChanged,
  }) {
    // Only offer a value the dropdown actually has, else null (placeholder).
    final has = value == null || items.any((i) => i.value == value);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: AppColors.panel2,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.line),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String?>(
          value: has ? value : null,
          isExpanded: true,
          hint: Text(hint, style: const TextStyle(color: AppColors.faint, fontSize: 12.5)),
          dropdownColor: AppColors.panel2,
          style: const TextStyle(color: AppColors.text, fontSize: 13.5),
          items: items,
          onChanged: onChanged,
        ),
      ),
    );
  }
}

class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6, left: 2),
        child: Text(text, style: const TextStyle(color: AppColors.muted, fontSize: 12.5, fontWeight: FontWeight.w500)),
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
