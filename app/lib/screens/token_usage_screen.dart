import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// Token 用量统计 — 镜像网页 manage 页「全局配置」里的用量展示：按时间窗
/// （今天 / 本周 / 本月 / 全部）显示各模型累计 token 消耗。只读，可强制刷新。
class TokenUsageScreen extends StatefulWidget {
  final SettingsService settings;
  const TokenUsageScreen({super.key, required this.settings});

  @override
  State<TokenUsageScreen> createState() => _TokenUsageScreenState();
}

class _TokenUsageScreenState extends State<TokenUsageScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);

  Map<String, dynamic>? _data;
  Map<String, dynamic>? _byRoleData;
  bool _loading = true;
  bool _byRoleLoading = true;
  bool _refreshing = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _refresh(force: false);
    _loadByRole();
  }

  Future<void> _refresh({required bool force}) async {
    final isInitial = !_loading;
    if (isInitial) {
      setState(() => _loading = true);
    } else {
      setState(() => _refreshing = true);
    }
    setState(() => _error = null);
    try {
      final d = await _manage.fetchTokenUsage(force: force);
      if (!mounted) return;
      setState(() {
        _data = d;
        _loading = false;
        _refreshing = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
        _refreshing = false;
      });
    }
    _loadByRole();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Token 用量'),
        actions: [
          IconButton(
            icon: _refreshing
                ? const SizedBox(
                    width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.refresh),
            onPressed: _refreshing ? null : () => _refresh(force: true),
            tooltip: '强制刷新',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? _ErrorView(error: _error!, onRetry: () => _refresh(force: false))
              : _data == null
                  ? const _EmptyView()
                  : RefreshIndicator(
                      onRefresh: () => _refresh(force: false),
                      child: ListView(
                        padding: const EdgeInsets.all(12),
                        children: [
                          _summaryCard(),
                          const SizedBox(height: 10),
                          _saveMainModelCard(),
                          const SizedBox(height: 10),
                          ..._windowSections(),
                        ],
                      ),
                    ),
    );
  }

  Future<void> _loadByRole() async {
    try {
      final url = widget.settings.buildHttpUrl('/api/token-usage/by-role');
      final headers = <String, String>{};
      if (widget.settings.token.isNotEmpty) {
        headers['X-Access-Token'] = widget.settings.token;
      }
      final res = await http
          .get(Uri.parse(url), headers: headers)
          .timeout(const Duration(seconds: 20));
      if (res.statusCode >= 400) return;
      if (!mounted) return;
      final body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      setState(() {
        _byRoleData = body;
        _byRoleLoading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _byRoleLoading = false);
    }
  }

  String _dateKey(DateTime dt) =>
      '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';

  Widget _saveMainModelCard() {
    if (_byRoleLoading) {
      return Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.panel,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppColors.line),
        ),
        child: const Row(
          children: [
            Text('省主模型 Token',
                style: TextStyle(color: AppColors.textBright, fontSize: 13, fontWeight: FontWeight.w600)),
            SizedBox(width: 12),
            SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 1.5)),
          ],
        ),
      );
    }
    if (_byRoleData == null || _byRoleData!.isEmpty) {
      return const SizedBox.shrink();
    }

    final now = DateTime.now();
    final todayKey = _dateKey(now);
    final monday = now.subtract(Duration(days: now.weekday - 1));
    final mondayKey = _dateKey(monday);
    final monthStart = _dateKey(DateTime(now.year, now.month, 1));

    int todayTotal = 0, weekTotal = 0, monthTotal = 0, allTotal = 0;

    for (final entry in _byRoleData!.entries) {
      final dateKey = entry.key;
      final dayData = entry.value as Map<String, dynamic>?;
      if (dayData == null) continue;
      final subData = dayData['sub'] as Map<String, dynamic>?;
      if (subData == null) continue;

      int daySub = 0;
      for (final p in subData.values) {
        if (p is Map) {
          daySub += (p['inputTokens'] as num?)?.toInt() ?? 0;
          daySub += (p['outputTokens'] as num?)?.toInt() ?? 0;
          daySub += (p['cacheWrite'] as num?)?.toInt() ?? 0;
          daySub += (p['cacheRead'] as num?)?.toInt() ?? 0;
        }
      }

      allTotal += daySub;
      if (dateKey == todayKey) todayTotal += daySub;
      if (dateKey.compareTo(mondayKey) >= 0) weekTotal += daySub;
      if (dateKey.compareTo(monthStart) >= 0) monthTotal += daySub;
    }

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
          const Text('省主模型 Token',
              style: TextStyle(color: AppColors.textBright, fontSize: 13, fontWeight: FontWeight.w600)),
          const SizedBox(height: 2),
          const Text('子任务替主模型处理的 token 量（没派给子任务的话本要让主模型跑）',
              style: TextStyle(color: AppColors.faint, fontSize: 10)),
          const SizedBox(height: 10),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _stat('今天', _fmt(todayTotal), AppColors.accent),
                const SizedBox(width: 20),
                _stat('本周', _fmt(weekTotal), AppColors.accent),
                const SizedBox(width: 20),
                _stat('本月', _fmt(monthTotal), AppColors.accent),
                const SizedBox(width: 20),
                _stat('全部', _fmt(allTotal), AppColors.accent),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _summaryCard() {
    final d = _data!;
    final responses = d['responses'] ?? 0;
    final generatedAt = (d['generatedAt'] as String?)?.substring(0, 19) ?? '';
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.line),
      ),
      child: Row(
        children: [
          _stat('总响应数', '$responses', AppColors.accent),
          const SizedBox(width: 30),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('生成于',
                    style: TextStyle(color: AppColors.muted, fontSize: 11)),
                Text(generatedAt,
                    style: const TextStyle(color: AppColors.faint, fontSize: 11)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _windowSections() {
    final windows = (_data!['windows'] as Map?) ?? {};
    const labels = ['today', 'week', 'month', 'all'];
    const names = {
      'today': '今天',
      'week': '本周',
      'month': '本月',
      'all': '全部',
    };
    final out = <Widget>[];
    for (final k in labels) {
      final w = (windows[k] as Map?) ?? {};
      if (w.isEmpty) continue;
      out.add(_windowCard(names[k]!, w));
      out.add(const SizedBox(height: 10));
    }
    if (out.isEmpty) out.add(const _EmptyView());
    return out;
  }

  Widget _windowCard(String title, Map w) {
    // Sum tokens across models for a window total.
    int total = 0;
    final rows = <MapEntry<String, int>>[];
    for (final e in w.entries) {
      int v = 0;
      final val = e.value;
      if (val is num) {
        v = val.toInt();
      } else if (val is Map) {
        for (final bv in val.values) {
          if (bv is num) v += bv.toInt();
        }
      }
      rows.add(MapEntry(e.key as String, v));
      total += v;
    }
    rows.sort((a, b) => b.value.compareTo(a.value));
    final maxV = rows.isEmpty ? 1 : rows.first.value;

    return Container(
      padding: const EdgeInsets.all(12),
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
              const Spacer(),
              Text(_fmt(total),
                  style: const TextStyle(color: AppColors.accent, fontSize: 13)),
            ],
          ),
          const SizedBox(height: 8),
          ...rows.take(12).map((r) => _bar(r.key, r.value, maxV)),
        ],
      ),
    );
  }

  Widget _bar(String model, int value, int maxV) {
    final pct = maxV == 0 ? 0.0 : (value / maxV).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.only(bottom: 5),
      child: Row(
        children: [
          SizedBox(
            width: 150,
            child: Text(model,
                style: const TextStyle(color: AppColors.muted, fontSize: 11),
                maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Stack(
              children: [
                Container(
                  height: 6,
                  decoration: BoxDecoration(
                    color: AppColors.line,
                    borderRadius: BorderRadius.circular(3),
                  ),
                ),
                FractionallySizedBox(
                  widthFactor: pct,
                  child: Container(
                    height: 6,
                    decoration: BoxDecoration(
                      color: AppColors.accent.withValues(alpha: 0.7),
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 70,
            child: Text(_fmt(value),
                textAlign: TextAlign.right,
                style: const TextStyle(color: AppColors.text, fontSize: 11)),
          ),
        ],
      ),
    );
  }

  String _fmt(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k';
    return '$n';
  }

  Widget _stat(String label, String value, Color valueColor) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(color: AppColors.muted, fontSize: 11)),
        Text(value,
            style: TextStyle(
                color: valueColor, fontSize: 20, fontWeight: FontWeight.w600)),
      ],
    );
  }
}

class _EmptyView extends StatelessWidget {
  const _EmptyView();
  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('暂无用量数据',
              style: TextStyle(color: AppColors.muted, fontSize: 13)),
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
