import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/message.dart';
import '../providers/session_manager.dart';
import '../services/background_service.dart';
import '../services/settings_service.dart';
import '../services/update_service.dart';
import '../theme.dart';
import '../widgets/model_picker.dart';
import 'agent_resources_screen.dart';
import 'cron_screen.dart';
import 'dashboard_screen.dart';
import 'events_screen.dart';
import 'main_shell.dart';
import 'provider_screen.dart';
import 'push_settings_screen.dart';
import 'token_usage_screen.dart';
import 'tunnel_settings_screen.dart';
import 'voice_settings_screen.dart';

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

  late List<ServerHistoryEntry> _serverHistory;

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

  // Claude proxy global toggle (server-side; POST is localhost-only → read-only after 403).
  bool _proxyEnabled = false;
  bool _proxyReadOnly = false;
  String? _proxyStatus;

  // Route claude-official (OAuth subscription) through the proxy — localhost-only POST.
  bool _officialOauthEnabled = false;
  bool _officialOauthReadOnly = false;
  String? _officialOauthStatus;

  // Access-token (remote-login password). Masked preview; editable only from localhost.
  String _accessTokenMasked = '';
  bool _hasAccessToken = false;
  bool _accessTokenReadOnly = false;
  String? _accessTokenStatus;
  late final TextEditingController _accessTokenCtrl;

  bool _checkingUpdate = false;
  String _appVersion = '…';

  @override
  void initState() {
    super.initState();
    final s = widget.settings;
    _hostCtrl = TextEditingController(text: s.host);
    _tokenCtrl = TextEditingController(text: s.token);
    _serverHistory = s.serverHistory;
    _defaultModel = s.defaultModel;
    _notify = s.notificationsEnabled;
    _keepAlive = s.keepAliveEnabled;
    _fontScale = s.fontScale.value;
    _goalMinCtrl = TextEditingController(text: '60');
    _accessTokenCtrl = TextEditingController();
    _loadGoalConfig();
    _loadProxyConfig();
    _loadOfficialOauth();
    _loadAccessToken();
    _loadVersion();
  }

  @override
  void dispose() {
    _hostCtrl.dispose();
    _tokenCtrl.dispose();
    _goalMinCtrl.dispose();
    _accessTokenCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadProxyConfig() async {
    try {
      final s = widget.settings;
      final headers = <String, String>{};
      if (s.token.isNotEmpty) headers['X-Access-Token'] = s.token;
      final res = await http
          .get(Uri.parse(s.buildHttpUrl('/api/settings/proxy')), headers: headers)
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200 || !mounted) return;
      final d = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      setState(() => _proxyEnabled = d['enabled'] == true);
    } catch (_) {}
  }

  Future<void> _toggleProxy(bool v) async {
    final prev = _proxyEnabled;
    setState(() {
      _proxyEnabled = v;
      _proxyStatus = null;
    });
    try {
      final s = widget.settings;
      final headers = <String, String>{'Content-Type': 'application/json'};
      if (s.token.isNotEmpty) headers['X-Access-Token'] = s.token;
      final res = await http
          .post(Uri.parse(s.buildHttpUrl('/api/settings/proxy')),
              headers: headers, body: jsonEncode({'enabled': v}))
          .timeout(const Duration(seconds: 15));
      if (!mounted) return;
      if (res.statusCode == 403) {
        // POST is localhost-only (isLocalRequest guard). Phone/remote clients
        // can read but not flip — revert and disable the switch.
        setState(() {
          _proxyEnabled = prev;
          _proxyReadOnly = true;
          _proxyStatus = '仅可在服务器本机切换，已禁用';
        });
      } else {
        setState(() => _proxyStatus =
            res.statusCode == 200 ? '已保存（下一轮 spawn 生效）' : '保存失败：HTTP ${res.statusCode}');
      }
    } catch (e) {
      if (mounted) setState(() => _proxyEnabled = prev);
      if (mounted) setState(() => _proxyStatus = '保存失败：$e');
    }
  }

  Future<void> _loadOfficialOauth() async {
    try {
      final s = widget.settings;
      final headers = <String, String>{};
      if (s.token.isNotEmpty) headers['X-Access-Token'] = s.token;
      final res = await http
          .get(Uri.parse(s.buildHttpUrl('/api/settings/official-oauth')), headers: headers)
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200 || !mounted) return;
      final d = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      setState(() => _officialOauthEnabled = d['enabled'] == true);
    } catch (_) {}
  }

  Future<void> _toggleOfficialOauth(bool v) async {
    final prev = _officialOauthEnabled;
    setState(() {
      _officialOauthEnabled = v;
      _officialOauthStatus = null;
    });
    try {
      final s = widget.settings;
      final headers = <String, String>{'Content-Type': 'application/json'};
      if (s.token.isNotEmpty) headers['X-Access-Token'] = s.token;
      final res = await http
          .post(Uri.parse(s.buildHttpUrl('/api/settings/official-oauth')),
              headers: headers, body: jsonEncode({'enabled': v}))
          .timeout(const Duration(seconds: 15));
      if (!mounted) return;
      if (res.statusCode == 403) {
        setState(() {
          _officialOauthEnabled = prev;
          _officialOauthReadOnly = true;
          _officialOauthStatus = '仅可在服务器本机切换，已禁用';
        });
      } else {
        setState(() => _officialOauthStatus =
            res.statusCode == 200 ? '已保存' : '保存失败：HTTP ${res.statusCode}');
      }
    } catch (e) {
      if (mounted) setState(() => _officialOauthEnabled = prev);
      if (mounted) setState(() => _officialOauthStatus = '保存失败：$e');
    }
  }

  Future<void> _loadAccessToken() async {
    try {
      final s = widget.settings;
      final headers = <String, String>{};
      if (s.token.isNotEmpty) headers['X-Access-Token'] = s.token;
      final res = await http
          .get(Uri.parse(s.buildHttpUrl('/api/settings/access-token')), headers: headers)
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200 || !mounted) return;
      final d = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      setState(() {
        _hasAccessToken = d['hasToken'] == true;
        _accessTokenMasked = (d['masked'] ?? '') as String;
        _accessTokenReadOnly = d['canEdit'] != true;
        _accessTokenCtrl.text = _accessTokenMasked;
      });
    } catch (_) {}
  }

  Future<void> _saveAccessToken() async {
    final raw = _accessTokenCtrl.text.trim();
    // The server rejects payloads that still contain the masked placeholder
    // (no real change). Detect that and treat as a no-op.
    if (raw == _accessTokenMasked || raw.contains('****')) {
      if (mounted) setState(() => _accessTokenStatus = '未改动');
      return;
    }
    setState(() => _accessTokenStatus = '保存中…');
    try {
      final s = widget.settings;
      final headers = <String, String>{'Content-Type': 'application/json'};
      if (s.token.isNotEmpty) headers['X-Access-Token'] = s.token;
      final res = await http
          .post(Uri.parse(s.buildHttpUrl('/api/settings/access-token')),
              headers: headers, body: jsonEncode({'token': raw}))
          .timeout(const Duration(seconds: 15));
      if (!mounted) return;
      if (res.statusCode == 403) {
        setState(() {
          _accessTokenReadOnly = true;
          _accessTokenStatus = '仅可在服务器本机修改';
        });
      } else if (res.statusCode == 400) {
        final d = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
        setState(() => _accessTokenStatus = d['error'] ?? '无有效改动');
      } else if (res.statusCode == 200) {
        setState(() => _accessTokenStatus = '已保存');
        await _loadAccessToken(); // refresh the masked preview
      } else {
        setState(() => _accessTokenStatus = '保存失败：HTTP ${res.statusCode}');
      }
    } catch (e) {
      if (mounted) setState(() => _accessTokenStatus = '保存失败：$e');
    }
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
    final token = _tokenCtrl.text.trim();
    await widget.settings.save(host: host, token: token);
    await widget.settings.rememberServer(host, token);
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

  void _applyHistory(ServerHistoryEntry e) {
    setState(() {
      _hostCtrl.text = e.host;
      _tokenCtrl.text = e.token;
      _serverStatus = null;
    });
  }

  Future<void> _clearHistory() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.panel,
        title: const Text('清除连接记录', style: TextStyle(color: AppColors.text, fontSize: 16)),
        content: const Text(
          '将删除所有已记住的服务器地址和 Token。当前正在使用的连接不受影响。',
          style: TextStyle(color: AppColors.muted, fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消', style: TextStyle(color: AppColors.muted)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('清除', style: TextStyle(color: AppColors.danger)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await widget.settings.clearServerHistory();
    if (!mounted) return;
    setState(() => _serverHistory = []);
    _snack('已清除连接记录');
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

  Future<void> _loadVersion() async {
    final v = await UpdateService.currentVersion();
    if (mounted) setState(() => _appVersion = v);
  }

  Future<void> _checkUpdate() async {
    setState(() => _checkingUpdate = true);
    try {
      await UpdateService.checkUpdateManually(context, widget.settings);
    } finally {
      if (mounted) setState(() => _checkingUpdate = false);
    }
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
              if (_serverHistory.isNotEmpty) ...[
                Row(
                  children: [
                    Expanded(child: _Label('历史记录')),
                    InkWell(
                      onTap: _clearHistory,
                      borderRadius: BorderRadius.circular(6),
                      child: const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.delete_outline, size: 15, color: AppColors.danger),
                            SizedBox(width: 4),
                            Text('清除记录', style: TextStyle(color: AppColors.danger, fontSize: 12)),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
                _HistoryDropdown(
                  entries: _serverHistory,
                  currentHost: _hostCtrl.text.trim(),
                  onSelected: _applyHistory,
                ),
                const SizedBox(height: 14),
              ],
              _Label('服务器地址'),
              _Input(controller: _hostCtrl, hint: 'http://192.168.1.100:3456', keyboardType: TextInputType.url),
              const SizedBox(height: 14),
              _Label('Access Token'),
              _Input(controller: _tokenCtrl, hint: '未设置可留空', obscure: true),
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
            title: 'Claude 代理路由',
            children: [
              const _Hint(
                  '把 Claude Code 的请求按 provider 路由到不同端点（主进程 vs 子任务 subagent）。全局开关，仅可在服务器本机切换；手机/远程只能查看当前状态（切换会被服务器拒绝并自动转为只读）。'),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('启用 Claude Code 代理路由',
                    style: TextStyle(color: AppColors.text, fontSize: 14)),
                value: _proxyEnabled,
                activeColor: const Color(0xFF04110f),
                activeTrackColor: AppColors.accent,
                onChanged: _proxyReadOnly ? null : _toggleProxy,
              ),
              if (_proxyStatus != null) ...[
                const SizedBox(height: 6),
                Text(_proxyStatus!,
                    style: const TextStyle(color: AppColors.accent, fontSize: 13)),
              ],
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
            title: '管理',
            children: [
              _NavTile(
                icon: Icons.alarm_rounded,
                title: '定时任务',
                subtitle: '到点自动唤起会话执行指令（cron）',
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => CronScreen(settings: widget.settings),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              _NavTile(
                icon: Icons.swap_horiz_rounded,
                title: 'Provider 配置',
                subtitle: '从 cc-switch 导入、增删改、设默认；会话可单独切换',
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => ProviderScreen(settings: widget.settings),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              _NavTile(
                icon: Icons.dataset_outlined,
                title: 'Agent 资源 / 缓存',
                subtitle: 'Skills、Claude 历史会话清理、临时上传缓存',
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => AgentResourcesScreen(settings: widget.settings),
                  ),
                ),
              ),
            ],
          ),
          _Section(
            title: '服务端设置',
            children: [
              const _Hint('以下设置读写服务器全局配置。带密钥的项（语音密钥、推送通道、WeChat 桥接等）仍需在网页管理台配置；密码类项仅服务器本机可改。'),
              const SizedBox(height: 10),
              // Access token (remote-login password) — masked preview + edit.
              const Text('访问密码 (Access Token)',
                  style: TextStyle(color: AppColors.text, fontSize: 14)),
              const SizedBox(height: 2),
              Text(
                _hasAccessToken ? '当前: $_accessTokenMasked' : '未设置（远程访问无密码保护）',
                style: const TextStyle(color: AppColors.muted, fontSize: 12),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _accessTokenCtrl,
                      obscureText: true,
                      enabled: !_accessTokenReadOnly,
                      style: const TextStyle(color: AppColors.text, fontSize: 13),
                      decoration: const InputDecoration(
                        isDense: true,
                        hintText: '留空清除；仅本机可改',
                        border: OutlineInputBorder(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _accessTokenReadOnly ? null : _saveAccessToken,
                    child: const Text('保存'),
                  ),
                ],
              ),
              if (_accessTokenStatus != null) ...[
                const SizedBox(height: 6),
                Text(_accessTokenStatus!,
                    style: const TextStyle(color: AppColors.accent, fontSize: 13)),
              ],
              if (_accessTokenReadOnly) ...[
                const SizedBox(height: 4),
                const _Hint('远程访问只读：在服务器本机打开 App 方可修改密码'),
              ],
              const Divider(height: 24),
              // Route claude-official (OAuth subscription) through the proxy.
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Official OAuth 走代理',
                    style: TextStyle(color: AppColors.text, fontSize: 14)),
                subtitle: const Text('让官方订阅会话的 OAuth token 经代理路由到便宜 provider（⚠️ ToS 风险）',
                    style: TextStyle(color: AppColors.muted, fontSize: 11)),
                value: _officialOauthEnabled,
                activeColor: const Color(0xFF04110f),
                activeTrackColor: AppColors.accent,
                onChanged: _officialOauthReadOnly ? null : _toggleOfficialOauth,
              ),
              if (_officialOauthStatus != null) ...[
                const SizedBox(height: 6),
                Text(_officialOauthStatus!,
                    style: const TextStyle(color: AppColors.accent, fontSize: 13)),
              ],
              const Divider(height: 24),
              _NavTile(
                icon: Icons.bar_chart_outlined,
                title: '状态看板',
                subtitle: '全会话一览（活跃 / 闲置）+ 聚合统计',
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => DashboardScreen(settings: widget.settings),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              _NavTile(
                icon: Icons.history,
                title: '活动记录',
                subtitle: '查看Fleet级事件流（完成 / 合并 / 推送 等）',
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => EventsScreen(settings: widget.settings),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              _NavTile(
                icon: Icons.token_outlined,
                title: 'Token 用量',
                subtitle: '按时间窗查看各模型 token 消耗',
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => TokenUsageScreen(settings: widget.settings),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              _NavTile(
                icon: Icons.notifications_active_outlined,
                title: '推送通知',
                subtitle: 'Bark / Webhook 通道配置与测试',
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => PushSettingsScreen(settings: widget.settings),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              _NavTile(
                icon: Icons.vpn_lock_outlined,
                title: '外网穿透',
                subtitle: '花生壳 / Tailscale 状态与重启',
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => TunnelSettingsScreen(settings: widget.settings),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              _NavTile(
                icon: Icons.record_voice_over_outlined,
                title: '语音设置',
                subtitle: 'ASR / TTS / Whisper 配置状态（只读）',
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => VoiceSettingsScreen(settings: widget.settings),
                  ),
                ),
              ),
              const Divider(height: 24),
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
          _Section(
            title: '关于',
            children: [
              Row(
                children: [
                  const Text('当前版本', style: TextStyle(color: AppColors.text, fontSize: 14)),
                  const Spacer(),
                  Text(
                    _appVersion,
                    style: const TextStyle(
                        color: AppColors.accent, fontSize: 13, fontFamily: 'monospace'),
                  ),
                ],
              ),
              const _Hint('版本号格式为「版本名 (构建号)」，更新时按构建号判断是否有新版。'),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _checkingUpdate ? null : _checkUpdate,
                  icon: _checkingUpdate
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.accent),
                        )
                      : const Icon(Icons.system_update_alt, size: 18, color: AppColors.accent),
                  label: Text(_checkingUpdate ? '检查中…' : '检查更新',
                      style: const TextStyle(color: AppColors.accent)),
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

class _NavTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  const _NavTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });
  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Icon(icon, size: 20, color: AppColors.accent),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(
                          color: AppColors.text, fontSize: 14, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text(subtitle,
                      style: const TextStyle(color: AppColors.faint, fontSize: 12)),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded, color: AppColors.faint, size: 20),
          ],
        ),
      ),
    );
  }
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

class _HistoryDropdown extends StatelessWidget {
  final List<ServerHistoryEntry> entries;
  final String currentHost;
  final ValueChanged<ServerHistoryEntry> onSelected;
  const _HistoryDropdown({
    required this.entries,
    required this.currentHost,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    String norm(String v) => v.trim().replaceAll(RegExp(r'/+$'), '').toLowerCase();
    ServerHistoryEntry? selected;
    for (final e in entries) {
      if (norm(e.host) == norm(currentHost)) {
        selected = e;
        break;
      }
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: AppColors.bgSoft,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(10),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<ServerHistoryEntry>(
          value: selected,
          isExpanded: true,
          dropdownColor: AppColors.panel,
          icon: const Icon(Icons.history, color: AppColors.faint, size: 18),
          hint: const Text('从历史记录中选择…',
              style: TextStyle(color: AppColors.faint, fontSize: 14)),
          style: const TextStyle(color: AppColors.text, fontSize: 14),
          items: entries
              .map((e) => DropdownMenuItem<ServerHistoryEntry>(
                    value: e,
                    child: Text(
                      e.token.isEmpty ? e.host : '${e.host}  ·  token 已存',
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: AppColors.text, fontSize: 14),
                    ),
                  ))
              .toList(),
          onChanged: (e) {
            if (e != null) onSelected(e);
          },
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
