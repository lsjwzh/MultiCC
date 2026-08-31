import 'package:flutter/material.dart';

import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// 外网穿透监控 — 镜像网页 manage 页「外网穿透监控」面板：查看花生壳 / Tailscale
/// 两个 provider 的可用性、健康状态、最近动作，并支持立即重启某个 provider。只读 + 重启。
class TunnelSettingsScreen extends StatefulWidget {
  final SettingsService settings;
  const TunnelSettingsScreen({super.key, required this.settings});

  @override
  State<TunnelSettingsScreen> createState() => _TunnelSettingsScreenState();
}

class _TunnelSettingsScreenState extends State<TunnelSettingsScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);

  Map<String, dynamic>? _status;
  bool _loading = true;
  String? _error;
  String? _restartingProvider;

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
      final s = await _manage.fetchTunnelStatus();
      if (!mounted) return;
      setState(() {
        _status = s;
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

  Future<void> _restart(String provider) async {
    setState(() => _restartingProvider = provider);
    final verb = provider == 'tailscale' ? '重连' : '重启';
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(SnackBar(content: Text('正在$verb $provider…')));
    try {
      final r = await _manage.restartTunnel(provider);
      final successMessage = r['message'] ?? '$provider 已$verb';
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            r['ok'] == true
                ? '✓ $successMessage'
                : '$provider $verb失败：${r['error'] ?? ''}',
          ),
        ),
      );
      await _refresh();
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text('$provider $verb失败：$e')));
    } finally {
      if (mounted) setState(() => _restartingProvider = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('外网穿透'),
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
                  _monitorCard(),
                  const SizedBox(height: 12),
                  _providerCard('花生壳 (phddns)', 'phddns', Icons.dns_outlined),
                  const SizedBox(height: 12),
                  _providerCard(
                    'Tailscale',
                    'tailscale',
                    Icons.vpn_lock_outlined,
                  ),
                  const SizedBox(height: 12),
                  _providerCard('natapp', 'natapp', Icons.cloud_outlined),
                  const SizedBox(height: 12),
                  _providerCard('cpolar', 'cpolar', Icons.cloud_queue_outlined),
                  const SizedBox(height: 12),
                  _providerCard('樱花frp', 'sakurafrp', Icons.vpn_key_outlined),
                ],
              ),
            ),
    );
  }

  Widget _monitorCard() {
    final s = _status ?? {};
    final running = s['monitorRunning'] == true;
    final avail = (s['availability'] as Map?) ?? {};
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
              const Text(
                '监控状态',
                style: TextStyle(
                  color: AppColors.textBright,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: (running ? AppColors.accent : AppColors.muted)
                      .withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  running ? '运行中' : '未运行',
                  style: TextStyle(
                    color: running ? AppColors.accent : AppColors.muted,
                    fontSize: 11,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          _row('花生壳已安装', avail['phddns'] == true ? '是' : '否'),
          _row('Tailscale 已安装', avail['tailscale'] == true ? '是' : '否'),
          _row('natapp 已安装', avail['natapp'] == true ? '是' : '否'),
          _row('cpolar 已安装', avail['cpolar'] == true ? '是' : '否'),
          _row('樱花frp 已安装', avail['sakurafrp'] == true ? '是' : '否'),
        ],
      ),
    );
  }

  Widget _providerCard(String title, String key, IconData icon) {
    final providers = (_status?['providers'] as Map?) ?? {};
    final p = (providers[key] as Map?) ?? {};
    final healthy = p['healthy'];
    final lastAction = (p['lastAction'] ?? '') as String;
    final fails = p['consecutiveFails'] ?? 0;
    final isFunnelProbe =
        key == 'tailscale' && p['probeMode'] == 'tailscale_funnel_public';
    final publicUrl = (p['publicUrl'] ?? '') as String;
    final probeError = (p['probeError'] ?? '') as String;
    final probeVerdict = (p['probeVerdict'] ?? '') as String;
    final edgeCount = p['resolvedAddressCount'] ?? 0;
    final edgeSuccess = p['edgeSuccessCount'] ?? 0;
    final lastCheck = p['lastCheckAt'] as num?;
    final checkTime = lastCheck == null || lastCheck == 0
        ? '—'
        : DateTime.fromMillisecondsSinceEpoch(
            lastCheck.toInt(),
          ).toLocal().toString().substring(5, 19);

    final healthColor = probeVerdict == 'degraded'
        ? Colors.orange
        : (healthy == true
              ? AppColors.accent
              : (healthy == false ? AppColors.danger : AppColors.muted));
    final healthText = probeVerdict == 'degraded'
        ? '部分边缘可用（不自动修复）'
        : (probeVerdict == 'indeterminate'
              ? '探针不确定'
              : (healthy == true
                    ? '健康'
                    : (healthy == false ? '异常（连续 $fails 次失败）' : '未检测')));

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
              Icon(icon, size: 18, color: AppColors.blue),
              const SizedBox(width: 8),
              Text(
                title,
                style: const TextStyle(
                  color: AppColors.textBright,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          _row('状态', healthText, valueColor: healthColor),
          _row('最近检测', checkTime),
          if (isFunnelProbe && publicUrl.isNotEmpty) _row('公网地址', publicUrl),
          if (isFunnelProbe && edgeCount is num && edgeCount > 0)
            _row('公网边缘', '$edgeSuccess/$edgeCount'),
          if (isFunnelProbe && probeError.isNotEmpty) _row('探针分类', probeError),
          if (lastAction.isNotEmpty) ...[
            const SizedBox(height: 4),
            const Text(
              '最近动作',
              style: TextStyle(color: AppColors.muted, fontSize: 11),
            ),
            const SizedBox(height: 2),
            Text(
              lastAction,
              style: const TextStyle(color: AppColors.text, fontSize: 12),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
          ],
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _restartingProvider == key
                  ? null
                  : () => _restart(key),
              icon: _restartingProvider == key
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.restart_alt, size: 18),
              label: Text(key == 'tailscale' ? '重连控制面' : '立即重启'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _row(String label, String value, {Color? valueColor}) => Padding(
    padding: const EdgeInsets.only(bottom: 5),
    child: Row(
      children: [
        Text(
          label,
          style: const TextStyle(color: AppColors.muted, fontSize: 13),
        ),
        const Spacer(),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.right,
            style: TextStyle(color: valueColor ?? AppColors.text, fontSize: 13),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    ),
  );
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
          Text(
            '加载失败：$error',
            textAlign: TextAlign.center,
            style: const TextStyle(color: AppColors.muted, fontSize: 13),
          ),
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
