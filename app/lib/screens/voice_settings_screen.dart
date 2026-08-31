import 'package:flutter/material.dart';

import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';

/// 语音设置 — 镜像网页 manage 页「语音设置」面板：查看 ASR（实时语音识别）、
/// TTS（语音合成）、Whisper（离线转写）、OpenRouter 配置状态。只读——密钥类
/// 项仍需在网页管理台修改（移动端不处理敏感凭据）。
class VoiceSettingsScreen extends StatefulWidget {
  final SettingsService settings;
  const VoiceSettingsScreen({super.key, required this.settings});

  @override
  State<VoiceSettingsScreen> createState() => _VoiceSettingsScreenState();
}

class _VoiceSettingsScreenState extends State<VoiceSettingsScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);

  Map<String, dynamic>? _cfg;
  bool _loading = true;
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
      final c = await _manage.fetchVoiceSettings();
      if (!mounted) return;
      setState(() {
        _cfg = c;
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('语音设置'),
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
              : _cfg == null
                  ? const _EmptyView()
                  : RefreshIndicator(
                      onRefresh: _refresh,
                      child: ListView(
                        padding: const EdgeInsets.all(12),
                        children: [
                          _asrCard(),
                          const SizedBox(height: 12),
                          _ttsCard(),
                          const SizedBox(height: 12),
                          _whisperCard(),
                          const SizedBox(height: 12),
                          _openrouterCard(),
                          const SizedBox(height: 8),
                          const _Hint('密钥类配置请在网页管理台修改。'),
                        ],
                      ),
                    ),
    );
  }

  Widget _asrCard() {
    final asr = (_cfg!['asr'] as Map?) ?? {};
    final provider = (asr['provider'] ?? '') as String;
    final status = (asr['status'] ?? '') as String;
    return _section(
      title: '实时语音识别 (ASR)',
      icon: Icons.mic_outlined,
      children: [
        _row('Provider', provider.isEmpty ? '未设置' : provider),
        _row('状态', status.isEmpty ? '—' : status,
            valueColor: _statusColor(status)),
        if (provider == 'openai') ...[
          _row('URL', (asr['openaiUrl'] ?? '') as String),
          _row('模型', (asr['openaiModel'] ?? '') as String),
          _row('API Key', asr['hasOpenaiKey'] == true ? '已配置' : '未配置',
              valueColor: asr['hasOpenaiKey'] == true ? AppColors.accent : AppColors.muted),
        ] else if (provider == 'volc') ...[
          _row('URL', (asr['volcUrl'] ?? '') as String),
          _row('Resource ID', (asr['volcResourceId'] ?? '') as String),
          _row('App ID', asr['hasVolcAppId'] == true ? '已配置' : '未配置'),
          _row('Token', asr['hasVolcToken'] == true ? '已配置' : '未配置'),
        ] else if (provider == 'funasr') ...[
          _row('URL', (asr['funasrUrl'] ?? '') as String),
          _row('Mode', (asr['funasrMode'] ?? '') as String),
        ],
      ],
    );
  }

  Widget _ttsCard() {
    final tts = (_cfg!['tts'] as Map?) ?? {};
    final provider = (tts['provider'] ?? '') as String;
    final status = (tts['status'] ?? '') as String;
    return _section(
      title: '语音合成 (TTS)',
      icon: Icons.volume_up_outlined,
      children: [
        _row('Provider', provider.isEmpty ? '未设置' : provider),
        _row('状态', status.isEmpty ? '—' : status,
            valueColor: _statusColor(status)),
        if (provider == 'edge') ...[
          _row('Voice', (tts['edgeVoice'] ?? '') as String),
        ] else if (provider == 'openai') ...[
          _row('Voice', (tts['openaiVoice'] ?? '') as String),
          _row('API Key', tts['hasOpenaiKey'] == true ? '已配置' : '未配置',
              valueColor: tts['hasOpenaiKey'] == true ? AppColors.accent : AppColors.muted),
        ] else if (provider == 'volcano') ...[
          _row('Voice', (tts['volcanoVoice'] ?? '') as String),
          _row('App ID', tts['hasVolcanoAppId'] == true ? '已配置' : '未配置'),
          _row('Token', tts['hasVolcanoToken'] == true ? '已配置' : '未配置'),
        ],
      ],
    );
  }

  Widget _whisperCard() {
    return _section(
      title: 'Whisper 离线转写',
      icon: Icons.graphic_eq_outlined,
      children: [
        _row('Base URL', (_cfg!['whisperBaseUrl'] ?? '') as String),
        _row('模型', (_cfg!['whisperModel'] ?? '') as String),
        _row('API Key', _cfg!['hasWhisperKey'] == true ? '已配置' : '未配置',
            valueColor: _cfg!['hasWhisperKey'] == true ? AppColors.accent : AppColors.muted),
        _row('语言', (_cfg!['whisperLanguage'] ?? '') as String),
        if ((_cfg!['whisperPrompt'] as String?)?.isNotEmpty == true)
          _row('Prompt', _cfg!['whisperPrompt'] as String),
      ],
    );
  }

  Widget _openrouterCard() {
    return _section(
      title: 'OpenRouter (LLM)',
      icon: Icons.cloud_outlined,
      children: [
        _row('Base URL', (_cfg!['baseUrl'] ?? '') as String),
        _row('模型', (_cfg!['model'] ?? '') as String),
        _row('API Key', _cfg!['hasKey'] == true ? '已配置' : '未配置',
            valueColor: _cfg!['hasKey'] == true ? AppColors.accent : AppColors.muted),
      ],
    );
  }

  Color _statusColor(String status) {
    final s = status.toLowerCase();
    if (s.contains('ok') || s.contains('ready') || s.contains('running')) return AppColors.accent;
    if (s.contains('error') || s.contains('fail') || s.contains('missing')) return AppColors.danger;
    return AppColors.muted;
  }

  Widget _section({
    required String title,
    required IconData icon,
    required List<Widget> children,
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
              Icon(icon, size: 18, color: AppColors.blue),
              const SizedBox(width: 8),
              Text(title,
                  style: const TextStyle(
                      color: AppColors.textBright, fontSize: 14, fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: 10),
          ...children,
        ],
      ),
    );
  }

  Widget _row(String label, String value, {Color? valueColor}) => Padding(
        padding: const EdgeInsets.only(bottom: 5),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 90,
              child: Text(label,
                  style: const TextStyle(color: AppColors.muted, fontSize: 13)),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(value,
                  style: TextStyle(color: valueColor ?? AppColors.text, fontSize: 13),
                  maxLines: 3, overflow: TextOverflow.ellipsis),
            ),
          ],
        ),
      );
}

class _EmptyView extends StatelessWidget {
  const _EmptyView();
  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('暂无语音配置',
              style: TextStyle(color: AppColors.muted, fontSize: 13)),
        ),
      );
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Text(text,
            textAlign: TextAlign.center,
            style: const TextStyle(color: AppColors.muted, fontSize: 11)),
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
