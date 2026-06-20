import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/message.dart';
import '../providers/session_manager.dart';
import '../services/background_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import '../widgets/model_picker.dart';
import 'main_shell.dart';

/// Unified in-app settings page. Covers app-local config (server connection,
/// default model, notifications, appearance) and links out to the web
/// dashboard for server-side settings (cron, voice keys, WeChat, …).
class SettingsScreen extends StatefulWidget {
  final SettingsService settings;
  const SettingsScreen({super.key, required this.settings});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController _hostCtrl;
  late final TextEditingController _tokenCtrl;
  late final TextEditingController _sessionCtrl;

  late String _defaultModel;
  late bool _notify;
  late bool _keepAlive;
  late double _fontScale;
  bool _savingServer = false;
  String? _serverStatus;

  // Goal precheck config (server-side, read/written via /api/settings/goal)
  static const List<String> _goalDimKeys = ['objective', 'criteria', 'scope', 'executable'];
  final Map<String, bool> _goalDims = {'objective': true, 'criteria': true, 'scope': true, 'executable': true};
  late final TextEditingController _goalMinCtrl;
  bool _goalSaving = false;
  String? _goalStatus;

  @override
  void initState() {
    super.initState();
    final s = widget.settings;
    _hostCtrl = TextEditingController(text: s.host);
    _tokenCtrl = TextEditingController(text: s.token);
    _sessionCtrl = TextEditingController(text: s.session);
    _defaultModel = s.defaultModel;
    _notify = s.notificationsEnabled;
    _keepAlive = s.keepAliveEnabled;
    _fontScale = s.fontScale.value;
    _goalMinCtrl = TextEditingController(text: '60');
    _loadGoalConfig();
  }

  @override
  void dispose() {
    _hostCtrl.dispose();
    _tokenCtrl.dispose();
    _sessionCtrl.dispose();
    _goalMinCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadGoalConfig() async {
    try {
      final s = widget.settings;
      final headers = <String, String>{};
      if (s.token.isNotEmpty) headers['X-Access-Token'] = s.token;
      final res = await http
          .get(Uri.parse(s.buildHttpUrl('/api/settings/goal')), headers: headers)
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200 || !mounted) return;
      final d = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      final dims = (d['dimensions'] as Map?) ?? {};
      setState(() {
        for (final k in _goalDimKeys) {
          _goalDims[k] = dims[k] != false;
        }
        _goalMinCtrl.text = (d['minScore'] ?? 60).toString();
      });
    } catch (_) {}
  }

  Future<void> _saveGoalConfig() async {
    setState(() {
      _goalSaving = true;
      _goalStatus = null;
    });
    try {
      final s = widget.settings;
      final headers = <String, String>{'Content-Type': 'application/json'};
      if (s.token.isNotEmpty) headers['X-Access-Token'] = s.token;
      final minScore = int.tryParse(_goalMinCtrl.text.trim()) ?? 60;
      final res = await http
          .post(Uri.parse(s.buildHttpUrl('/api/settings/goal')),
              headers: headers, body: jsonEncode({'dimensions': _goalDims, 'minScore': minScore}))
          .timeout(const Duration(seconds: 15));
      if (!mounted) return;
      setState(() => _goalStatus = res.statusCode == 200 ? '已保存' : '保存失败：HTTP ${res.statusCode}');
    } catch (e) {
      if (mounted) setState(() => _goalStatus = '保存失败：$e');
    } finally {
      if (mounted) setState(() => _goalSaving = false);
    }
  }

  Future<void> _saveServer() async {
    final host = _hostCtrl.text.trim();
    if (host.isEmpty) {
      setState(() => _serverStatus = '服务器地址不能为空');
      return;
    }
    setState(() {
      _savingServer = true;
      _serverStatus = null;
    });
    await widget.settings.save(
      host: host,
      token: _tokenCtrl.text.trim(),
      session: _sessionCtrl.text.trim(),
    );
    if (!mounted) return;
    // Reconnect with a fresh SessionManager / MainShell, same as first setup.
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(
        builder: (_) => ChangeNotifierProvider(
          create: (_) => SessionManager(settings: widget.settings),
          child: MainShell(settings: widget.settings),
        ),
      ),
      (route) => false,
    );
  }

  Future<void> _pickModel() async {
    final picked = await showClaudeModelPicker(context, current: _defaultModel);
    if (picked == null || !mounted) return;
    setState(() => _defaultModel = picked);
    await widget.settings.save(defaultModel: picked);
  }

  Future<void> _openWebDashboard() async {
    var h = widget.settings.host.trim().replaceAll(RegExp(r'/$'), '');
    if (h.isEmpty) {
      _snack('请先配置服务器地址');
      return;
    }
    if (!h.startsWith('http')) h = 'http://$h';
    final tok = widget.settings.token.trim();
    final uri = Uri.parse('$h/manage${tok.isNotEmpty ? '?token=$tok' : ''}');
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (mounted) _snack('无法打开浏览器');
    }
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 40),
        children: [
          _Section(
            title: '服务器连接',
            children: [
              _Label('服务器地址'),
              _Input(controller: _hostCtrl, hint: 'http://192.168.1.100:3456', keyboardType: TextInputType.url),
              const SizedBox(height: 14),
              _Label('Access Token'),
              _Input(controller: _tokenCtrl, hint: '未设置可留空', obscure: true),
              const SizedBox(height: 14),
              _Label('默认会话名（可选）'),
              _Input(controller: _sessionCtrl, hint: 'e.g. my-project'),
              if (_serverStatus != null) ...[
                const SizedBox(height: 10),
                Text(_serverStatus!, style: const TextStyle(color: AppColors.danger, fontSize: 13)),
              ],
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _savingServer ? null : _saveServer,
                  child: _savingServer
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF04110f)))
                      : const Text('保存并重连', style: TextStyle(fontWeight: FontWeight.w700)),
                ),
              ),
            ],
          ),
          _Section(
            title: '新建会话',
            children: [
              _Tile(
                label: '默认 Claude 模型',
                value: claudeModelShortName(_defaultModel),
                onTap: _pickModel,
              ),
              const _Hint('新建 Claude 聊天时预选此模型，仍可在选择器里临时更改。'),
            ],
          ),
          _Section(
            title: '通知',
            children: [
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('任务完成通知', style: TextStyle(color: AppColors.text, fontSize: 14)),
                subtitle: const Text('会话在后台完成时发送本地通知', style: TextStyle(color: AppColors.muted, fontSize: 12)),
                value: _notify,
                activeColor: const Color(0xFF04110f),
                activeTrackColor: AppColors.accent,
                onChanged: (v) async {
                  setState(() => _notify = v);
                  await widget.settings.save(notificationsEnabled: v);
                },
              ),
              if (BackgroundKeepAlive.isSupported)
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('后台保持连接', style: TextStyle(color: AppColors.text, fontSize: 14)),
                  subtitle: const Text(
                    '退到后台时用前台服务保持会话连接在线，回到应用即时可用、不重新加载。'
                    '会有一条常驻通知并增加耗电。',
                    style: TextStyle(color: AppColors.muted, fontSize: 12),
                  ),
                  value: _keepAlive,
                  activeColor: const Color(0xFF04110f),
                  activeTrackColor: AppColors.accent,
                  onChanged: (v) async {
                    setState(() => _keepAlive = v);
                    await widget.settings.save(keepAliveEnabled: v);
                  },
                ),
            ],
          ),
          _Section(
            title: 'Goal 预检',
            children: [
              const _Hint('以 Goal 模式发送任务前，辅助 AI 按下面启用的维度检查任务是否合格；不合格会给改写建议。聊天的 🎯 弹窗可临时调整本次维度。'),
              ..._goalDimKeys.map((k) => SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(_goalDimLabels[k]![0], style: const TextStyle(color: AppColors.text, fontSize: 14)),
                    subtitle: Text(_goalDimLabels[k]![1], style: const TextStyle(color: AppColors.muted, fontSize: 12)),
                    value: _goalDims[k] ?? true,
                    activeColor: const Color(0xFF04110f),
                    activeTrackColor: AppColors.accent,
                    onChanged: (v) => setState(() => _goalDims[k] = v),
                  )),
              const SizedBox(height: 10),
              _Label('通过分数阈值（0-100，0 = 不强制）'),
              _Input(controller: _goalMinCtrl, hint: '60', keyboardType: TextInputType.number),
              if (_goalStatus != null) ...[
                const SizedBox(height: 10),
                Text(_goalStatus!, style: const TextStyle(color: AppColors.accent, fontSize: 13)),
              ],
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _goalSaving ? null : _saveGoalConfig,
                  child: _goalSaving
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF04110f)))
                      : const Text('保存 Goal 预检设置', style: TextStyle(fontWeight: FontWeight.w700)),
                ),
              ),
            ],
          ),
          _Section(
            title: '外观',
            children: [
              Row(
                children: [
                  const Text('字体大小', style: TextStyle(color: AppColors.text, fontSize: 14)),
                  const Spacer(),
                  Text('${(_fontScale * 100).round()}%', style: const TextStyle(color: AppColors.accent, fontSize: 13, fontFamily: 'monospace')),
                ],
              ),
              Slider(
                value: _fontScale,
                min: 0.85,
                max: 1.4,
                divisions: 11,
                activeColor: AppColors.accent,
                inactiveColor: AppColors.line,
                label: '${(_fontScale * 100).round()}%',
                onChanged: (v) {
                  setState(() => _fontScale = v);
                  widget.settings.fontScale.value = v; // live preview
                },
                onChangeEnd: (v) => widget.settings.save(fontScale: v),
              ),
              const _Hint('预览：这段文字会随滑块即时缩放。'),
            ],
          ),
          _Section(
            title: '服务端设置',
            children: [
              const _Hint('定时任务、语音密钥、推送通道、WeChat 桥接等属于服务器全局设置，请在网页管理台配置。'),
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _openWebDashboard,
                  icon: const Icon(Icons.open_in_new, size: 18, color: AppColors.accent),
                  label: const Text('在浏览器打开网页管理台', style: TextStyle(color: AppColors.accent)),
                  style: OutlinedButton.styleFrom(
                    side: const BorderSide(color: AppColors.lineStrong),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// Goal precheck dimension labels: key → [title, subtitle].
const Map<String, List<String>> _goalDimLabels = {
  'objective': ['目标明确', '清楚要达成什么结果，而非含糊方向'],
  'criteria': ['完成标准明确', '有可判断「做完了」的验收标准或可观察产出'],
  'scope': ['范围清晰', '边界明确，不至于无限发散'],
  'executable': ['可独立执行', '无需追问关键信息即可开工，或缺失能合理默认'],
};

// ── Small building blocks ──

class _Section extends StatelessWidget {
  final String title;
  final List<Widget> children;
  const _Section({required this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 8),
            child: Text(
              title.toUpperCase(),
              style: const TextStyle(color: AppColors.faint, fontSize: 11, fontWeight: FontWeight.w600, letterSpacing: 1.2),
            ),
          ),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: AppColors.panel,
              border: Border.all(color: AppColors.line),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
          ),
        ],
      ),
    );
  }
}

class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(text, style: const TextStyle(color: AppColors.muted, fontSize: 12, fontWeight: FontWeight.w500)),
      );
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(text, style: const TextStyle(color: AppColors.faint, fontSize: 12, height: 1.5)),
      );
}

class _Tile extends StatelessWidget {
  final String label;
  final String value;
  final VoidCallback onTap;
  const _Tile({required this.label, required this.value, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            Text(label, style: const TextStyle(color: AppColors.text, fontSize: 14)),
            const Spacer(),
            Flexible(
              child: Text(value,
                  textAlign: TextAlign.right,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: AppColors.accent, fontSize: 13)),
            ),
            const Icon(Icons.chevron_right, color: AppColors.faint, size: 20),
          ],
        ),
      ),
    );
  }
}

class _Input extends StatelessWidget {
  final TextEditingController controller;
  final String hint;
  final bool obscure;
  final TextInputType? keyboardType;
  const _Input({required this.controller, required this.hint, this.obscure = false, this.keyboardType});

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      keyboardType: keyboardType,
      autocorrect: false,
      style: const TextStyle(color: AppColors.text, fontSize: 14),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: AppColors.faint),
        filled: true,
        fillColor: AppColors.bgSoft,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: AppColors.line)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: AppColors.line)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: AppColors.accent)),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      ),
    );
  }
}
