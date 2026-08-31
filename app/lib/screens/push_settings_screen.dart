import 'package:flutter/material.dart';

import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// 推送通知通道 — 镜像网页 manage 页「推送通知」面板：查看 Bark / Webhook 配置
/// 状态、编辑通道 URL、发送测试通知。移动端只读 + 可改 URL（不涉及密钥）。
class PushSettingsScreen extends StatefulWidget {
  final SettingsService settings;
  const PushSettingsScreen({super.key, required this.settings});

  @override
  State<PushSettingsScreen> createState() => _PushSettingsScreenState();
}

class _PushSettingsScreenState extends State<PushSettingsScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);

  Map<String, dynamic>? _cfg;
  Map<String, dynamic>? _health;
  bool _loading = true;
  String? _error;
  late final TextEditingController _barkCtrl;
  late final TextEditingController _webhookCtrl;
  String? _barkStatus;
  String? _webhookStatus;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _barkCtrl = TextEditingController();
    _webhookCtrl = TextEditingController();
    _refresh();
  }

  @override
  void dispose() {
    _barkCtrl.dispose();
    _webhookCtrl.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        _manage.fetchNotifyConfig(),
        _manage.fetchPushHealth(),
      ]);
      if (!mounted) return;
      setState(() {
        _cfg = results[0];
        _health = results[1];
        _barkCtrl.text = (_cfg!['barkUrl'] ?? '') as String;
        _webhookCtrl.text = (_cfg!['webhookUrl'] ?? '') as String;
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

  Future<void> _saveBark() async {
    setState(() {
      _saving = true;
      _barkStatus = '保存中…';
    });
    try {
      await _manage.saveNotifyConfig(barkUrl: _barkCtrl.text.trim());
      if (!mounted) return;
      setState(() => _barkStatus = '已保存');
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() => _barkStatus = '保存失败：$e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _saveWebhook() async {
    setState(() {
      _saving = true;
      _webhookStatus = '保存中…';
    });
    try {
      await _manage.saveNotifyConfig(webhookUrl: _webhookCtrl.text.trim());
      if (!mounted) return;
      setState(() => _webhookStatus = '已保存');
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() => _webhookStatus = '保存失败：$e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _testAll() async {
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(const SnackBar(content: Text('正在发送测试通知…')));
    try {
      final r = await _manage.testPush();
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(
          content: Text('已发送（${r['subscribers'] ?? 0} 个订阅）')));
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text('发送失败：$e')));
    }
  }

  Future<void> _testBark() async => _testChannel(_manage.testBark, 'Bark');
  Future<void> _testWebhook() async =>
      _testChannel(_manage.testWebhook, 'Webhook');

  Future<void> _testChannel(
      Future<Map<String, dynamic>> Function() fn, String name) async {
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(SnackBar(content: Text('正在测试 $name…')));
    try {
      await fn();
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text('$name 测试已发送')));
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text('$name 测试失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('推送通知'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _refresh,
            tooltip: '刷新',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? _ErrorView(error: _error!, onRetry: _refresh)
              : RefreshIndicator(
                  onRefresh: _refresh,
                  child: ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      _healthCard(),
                      const SizedBox(height: 12),
                      _channelCard(
                        title: 'Bark',
                        hint: 'iOS Bark App 推送。填 Bark 的完整 URL（含 key）。',
                        controller: _barkCtrl,
                        status: _barkStatus,
                        onSave: _saveBark,
                        onTest: _testBark,
                        configured: _cfg?['hasBark'] == true,
                      ),
                      const SizedBox(height: 12),
                      _channelCard(
                        title: 'Webhook',
                        hint: '自定义 HTTP webhook（接收 JSON POST）。',
                        controller: _webhookCtrl,
                        status: _webhookStatus,
                        onSave: _saveWebhook,
                        onTest: _testWebhook,
                        configured: _cfg?['hasWebhook'] == true,
                      ),
                      const SizedBox(height: 16),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          onPressed: _testAll,
                          icon: const Icon(Icons.notifications_active, size: 18),
                          label: const Text('向所有通道发送测试'),
                        ),
                      ),
                    ],
                  ),
                ),
    );
  }

  Widget _healthCard() {
    final h = _health ?? {};
    final subCount = h['subscriptionCount'] ?? 0;
    final bark = (h['bark'] as Map?) ?? {};
    final webhook = (h['webhook'] as Map?) ?? {};
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('通道状态',
              style: TextStyle(
                  color: AppColors.textBright, fontSize: 14, fontWeight: FontWeight.w600)),
          const SizedBox(height: 10),
          _healthRow('浏览器订阅', '$subCount 个', AppColors.blue),
          _healthRow('Bark',
              bark['configured'] == true ? '已配置' : '未配置',
              bark['configured'] == true ? AppColors.accent : AppColors.muted),
          _healthRow('Webhook',
              webhook['configured'] == true ? '已配置' : '未配置',
              webhook['configured'] == true ? AppColors.accent : AppColors.muted),
        ],
      ),
    );
  }

  Widget _healthRow(String label, String value, Color c) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Row(
          children: [
            Text(label, style: const TextStyle(color: AppColors.muted, fontSize: 13)),
            const Spacer(),
            Text(value, style: TextStyle(color: c, fontSize: 13)),
          ],
        ),
      );

  Widget _channelCard({
    required String title,
    required String hint,
    required TextEditingController controller,
    required String? status,
    required VoidCallback onSave,
    required VoidCallback onTest,
    required bool configured,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(title,
                  style: const TextStyle(
                      color: AppColors.textBright, fontSize: 14, fontWeight: FontWeight.w600)),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: (configured ? AppColors.accent : AppColors.muted).withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(configured ? '已配置' : '未配置',
                    style: TextStyle(
                        color: configured ? AppColors.accent : AppColors.muted, fontSize: 10)),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(hint, style: const TextStyle(color: AppColors.muted, fontSize: 11)),
          const SizedBox(height: 10),
          TextField(
            controller: controller,
            style: const TextStyle(color: AppColors.text, fontSize: 13),
            decoration: const InputDecoration(
              isDense: true,
              hintText: '输入 URL',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              FilledButton(
                onPressed: _saving ? null : onSave,
                child: const Text('保存'),
              ),
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: configured ? onTest : null,
                child: const Text('测试'),
              ),
            ],
          ),
          if (status != null) ...[
            const SizedBox(height: 6),
            Text(status, style: const TextStyle(color: AppColors.accent, fontSize: 12)),
          ],
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  final String error;
  final VoidCallback onRetry;
  const _ErrorView({required this.error, required this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.danger, size: 40),
              const SizedBox(height: 12),
              Text('加载失败：$error',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: AppColors.muted, fontSize: 13)),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('重试'),
              ),
            ],
          ),
        ),
      );
}
