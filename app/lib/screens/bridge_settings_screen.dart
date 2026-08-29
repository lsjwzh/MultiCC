import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import '../widgets/settings_navigation_drawer.dart';

class _BridgeSpec {
  final String id;
  final String name;
  final IconData icon;
  final List<(String, String, bool)> fields;

  const _BridgeSpec(this.id, this.name, this.icon, this.fields);
}

const _bridgeSpecs = [
  _BridgeSpec('feishu', 'Feishu', Icons.flight_outlined, [
    ('appId', 'App ID', false),
    ('appSecret', 'App Secret', true),
    ('domain', 'Domain（feishu / lark）', false),
  ]),
  _BridgeSpec('telegram', 'Telegram', Icons.send_outlined, [
    ('botToken', 'Bot Token', true),
  ]),
  _BridgeSpec('discord', 'Discord', Icons.forum_outlined, [
    ('botToken', 'Bot Token', true),
  ]),
  _BridgeSpec('slack', 'Slack', Icons.tag_outlined, [
    ('botToken', 'Bot Token', true),
    ('appToken', 'App Token', true),
  ]),
  _BridgeSpec('wechat', '微信', Icons.qr_code_2_rounded, []),
];

/// App counterpart of the web dashboard's Bridges panel. Token bridges are
/// fully manageable here. WeChat keeps its QR-login step on the web because
/// the server owns a short-lived QR polling flow; status/runtime/gateway remain
/// controllable from the app after login.
class BridgeSettingsScreen extends StatefulWidget {
  final SettingsService settings;
  const BridgeSettingsScreen({super.key, required this.settings});

  @override
  State<BridgeSettingsScreen> createState() => _BridgeSettingsScreenState();
}

class _BridgeSettingsScreenState extends State<BridgeSettingsScreen> {
  late final ManageService _manage = ManageService(settings: widget.settings);
  final Map<String, Map<String, TextEditingController>> _controllers = {};
  final Map<String, Map<String, dynamic>> _statuses = {};
  final Map<String, List<Map<String, dynamic>>> _logs = {};
  final Map<String, String> _gatewayCli = {};
  String _selected = _bridgeSpecs.first.id;
  bool _loading = true;
  bool _busy = false;
  String? _error;

  _BridgeSpec get _spec => _bridgeSpecs.firstWhere((s) => s.id == _selected);
  Map<String, dynamic> get _status => _statuses[_selected] ?? const {};

  @override
  void initState() {
    super.initState();
    for (final spec in _bridgeSpecs) {
      _controllers[spec.id] = {
        for (final field in spec.fields) field.$1: TextEditingController(),
      };
      _gatewayCli[spec.id] = 'claude';
    }
    _refresh();
  }

  @override
  void dispose() {
    for (final group in _controllers.values) {
      for (final controller in group.values) {
        controller.dispose();
      }
    }
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await Future.wait(
        _bridgeSpecs.map((spec) async {
          final results = await Future.wait([
            _manage.fetchBridgeStatus(spec.id),
            _manage.fetchBridgeConfig(spec.id),
            _manage.fetchBridgeLog(spec.id),
          ]);
          final status = results[0] as Map<String, dynamic>;
          final config = results[1] as Map<String, dynamic>;
          _statuses[spec.id] = status;
          _logs[spec.id] = results[2] as List<Map<String, dynamic>>;
          final gateway = status['gateway'];
          if (gateway is Map && gateway['cli'] != null) {
            _gatewayCli[spec.id] = gateway['cli'].toString();
          }
          // The API intentionally masks secrets. Only populate non-secret values;
          // leaving a secret blank means "keep the existing value" on save.
          for (final field in spec.fields.where((f) => !f.$3)) {
            final value = config[field.$1]?.toString() ?? '';
            if (value.isNotEmpty) {
              _controllers[spec.id]![field.$1]!.text = value;
            }
          }
        }),
      );
      if (mounted) setState(() => _loading = false);
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = '$e';
        });
      }
    }
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _act(String label, Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
      _snack('$label成功');
      await _refresh();
    } catch (e) {
      _snack('$label失败：$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _saveConfig() async {
    final body = <String, dynamic>{};
    for (final field in _spec.fields) {
      final value = _controllers[_selected]![field.$1]!.text.trim();
      if (value.isNotEmpty) body[field.$1] = value;
    }
    if (body.isEmpty) {
      _snack('没有需要保存的内容');
      return;
    }
    await _act('保存', () => _manage.saveBridgeConfig(_selected, body));
    for (final field in _spec.fields.where((f) => f.$3)) {
      _controllers[_selected]![field.$1]!.clear();
    }
  }

  Future<void> _openWechatLogin() async {
    final token = widget.settings.token.trim();
    final uri = Uri.parse(
      widget.settings.buildHttpUrl('/manage'),
    ).replace(queryParameters: token.isEmpty ? null : {'token': token});
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      _snack('无法打开网页管理台');
    }
  }

  Future<bool> _confirm(String title, String body) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text(
                '确认',
                style: TextStyle(color: AppColors.danger),
              ),
            ),
          ],
        ),
      ) ??
      false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      drawer: SettingsNavigationDrawer(
        selected: SettingsDestination.bridges,
        serverLabel: widget.settings.host,
      ),
      appBar: AppBar(
        title: const Text('消息桥接'),
        actions: [
          IconButton(
            onPressed: _loading || _busy ? null : _refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: AppColors.accent),
            )
          : _error != null
          ? _errorView()
          : RefreshIndicator(
              onRefresh: _refresh,
              color: AppColors.accent,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 36),
                children: [
                  _platformPicker(),
                  const SizedBox(height: 14),
                  _statusCard(),
                  if (_spec.fields.isNotEmpty) ...[
                    const SizedBox(height: 14),
                    _configCard(),
                  ],
                  if (_selected == 'wechat') ...[
                    const SizedBox(height: 14),
                    _wechatCard(),
                  ],
                  const SizedBox(height: 14),
                  _gatewayCard(),
                  const SizedBox(height: 14),
                  _logCard(),
                  if (_busy) ...[
                    const SizedBox(height: 18),
                    const Center(
                      child: CircularProgressIndicator(color: AppColors.accent),
                    ),
                  ],
                ],
              ),
            ),
    );
  }

  Widget _platformPicker() => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      children: _bridgeSpecs.map((spec) {
        final selected = spec.id == _selected;
        final configured =
            _statuses[spec.id]?['configured'] == true ||
            _statuses[spec.id]?['loggedIn'] == true;
        return Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            selected: selected,
            avatar: Icon(
              spec.icon,
              size: 16,
              color: selected ? const Color(0xFF04110f) : AppColors.muted,
            ),
            label: Text('${spec.name}${configured ? ' · ✓' : ''}'),
            onSelected: (_) => setState(() => _selected = spec.id),
            selectedColor: AppColors.accent,
            backgroundColor: AppColors.panel,
            side: const BorderSide(color: AppColors.line),
          ),
        );
      }).toList(),
    ),
  );

  Widget _statusCard() {
    final configured =
        _status['configured'] == true || _status['loggedIn'] == true;
    final running = _status['running'] == true;
    final chatConnected = _status['chatConnected'] == true;
    return _Panel(
      title: '${_spec.name} 状态',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _StatusChip(configured ? '已配置' : '未配置', configured),
              _StatusChip(running ? '运行中' : '已停止', running),
              _StatusChip(
                chatConnected ? 'Gateway 已连接' : 'Gateway 未连接',
                chatConnected,
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: _busy || running
                      ? null
                      : () => _act(
                          '启动',
                          () => _manage.setBridgeRunning(_selected, true),
                        ),
                  icon: const Icon(Icons.play_arrow_rounded),
                  label: const Text('启动'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _busy || !running
                      ? null
                      : () => _act(
                          '停止',
                          () => _manage.setBridgeRunning(_selected, false),
                        ),
                  icon: const Icon(Icons.stop_rounded),
                  label: const Text('停止'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _configCard() => _Panel(
    title: '凭证配置',
    child: Column(
      children: [
        for (final field in _spec.fields) ...[
          TextField(
            controller: _controllers[_selected]![field.$1],
            obscureText: field.$3,
            style: const TextStyle(color: AppColors.text),
            decoration: InputDecoration(
              labelText: field.$2,
              hintText: field.$3 ? '留空保留现有值' : null,
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
        ],
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _busy ? null : _saveConfig,
            child: const Text('保存凭证'),
          ),
        ),
      ],
    ),
  );

  Widget _wechatCard() => _Panel(
    title: '微信登录',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          '微信 iLink 使用短时二维码轮询。App 可查看状态、启停桥接和管理 Gateway；首次登录或换号请打开网页扫码。',
          style: TextStyle(color: AppColors.muted, fontSize: 12.5, height: 1.5),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: _openWechatLogin,
          icon: const Icon(Icons.open_in_new_rounded),
          label: const Text('打开网页扫码登录'),
        ),
      ],
    ),
  );

  Widget _gatewayCard() {
    final gateway = _status['gateway'];
    final exists = gateway is Map;
    return _Panel(
      title: 'Gateway 会话',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            exists ? '已创建 · ${gateway['id'] ?? ''}' : '尚未创建',
            style: const TextStyle(color: AppColors.muted, fontSize: 12.5),
          ),
          const SizedBox(height: 10),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'claude', label: Text('Claude')),
              ButtonSegment(value: 'codex', label: Text('Codex')),
            ],
            selected: {_gatewayCli[_selected] ?? 'claude'},
            onSelectionChanged: _busy
                ? null
                : (values) async {
                    final cli = values.first;
                    setState(() => _gatewayCli[_selected] = cli);
                    if (exists) {
                      await _act(
                        '切换 CLI',
                        () async => _manage.setBridgeGateway(_selected, cli),
                      );
                    }
                  },
          ),
          const SizedBox(height: 12),
          if (!exists)
            FilledButton.icon(
              onPressed: _busy
                  ? null
                  : () => _act(
                      '创建 Gateway',
                      () async => _manage.setBridgeGateway(
                        _selected,
                        _gatewayCli[_selected] ?? 'claude',
                      ),
                    ),
              icon: const Icon(Icons.add_comment_outlined),
              label: const Text('创建 Gateway'),
            )
          else
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy
                        ? null
                        : () async {
                            if (await _confirm(
                              '清空对话历史',
                              '清空 ${_spec.name} Gateway 的对话历史？',
                            )) {
                              await _act(
                                '清空',
                                () => _manage.resetBridgeGateway(_selected),
                              );
                            }
                          },
                    child: const Text('清空历史'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy
                        ? null
                        : () async {
                            if (await _confirm(
                              '销毁 Gateway',
                              '销毁 Gateway 会话？此操作不会删除桥接凭证。',
                            )) {
                              await _act(
                                '销毁',
                                () => _manage.deleteBridgeGateway(_selected),
                              );
                            }
                          },
                    style: OutlinedButton.styleFrom(
                      foregroundColor: AppColors.danger,
                    ),
                    child: const Text('销毁'),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _logCard() {
    final log = _logs[_selected] ?? const [];
    return _Panel(
      title: '最近日志',
      child: log.isEmpty
          ? const Text(
              '暂无日志',
              style: TextStyle(color: AppColors.faint, fontSize: 12),
            )
          : Column(
              children: log.reversed.take(30).map((entry) {
                final type = (entry['type'] ?? 'system').toString();
                final color = switch (type) {
                  'in' => AppColors.blue,
                  'out' => AppColors.codex,
                  'error' => AppColors.danger,
                  _ => AppColors.amber,
                };
                return Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        type.toUpperCase(),
                        style: TextStyle(
                          color: color,
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          (entry['text'] ?? '').toString(),
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 11.5,
                            height: 1.35,
                          ),
                        ),
                      ),
                    ],
                  ),
                );
              }).toList(),
            ),
    );
  }

  Widget _errorView() => Center(
    child: Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            _error!,
            textAlign: TextAlign.center,
            style: const TextStyle(color: AppColors.danger),
          ),
          const SizedBox(height: 14),
          OutlinedButton(onPressed: _refresh, child: const Text('重试')),
        ],
      ),
    ),
  );
}

class _Panel extends StatelessWidget {
  final String title;
  final Widget child;
  const _Panel({required this.title, required this.child});

  @override
  Widget build(BuildContext context) => Container(
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
          title,
          style: const TextStyle(
            color: AppColors.textBright,
            fontSize: 15,
            fontWeight: FontWeight.w700,
          ),
        ),
        const Divider(height: 22, color: AppColors.line),
        child,
      ],
    ),
  );
}

class _StatusChip extends StatelessWidget {
  final String label;
  final bool ok;
  const _StatusChip(this.label, this.ok);

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
    decoration: BoxDecoration(
      color: (ok ? AppColors.codex : AppColors.faint).withValues(alpha: .14),
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      label,
      style: TextStyle(
        color: ok ? AppColors.codex : AppColors.muted,
        fontSize: 11.5,
      ),
    ),
  );
}
