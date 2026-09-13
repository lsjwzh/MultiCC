import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../services/air_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';

/// 工作区分享的两个对话框 —— Web 侧是 `public/manage-fleet-sharing.js` 里那对
/// `#fleet-share-modal` / `#fleet-import-modal`。
///
/// 这里管的是**工作区范围**的分享（`/api/fleets/:id/share`）：把整个工作目录
/// 签发成一份带密码、有期限、限次数的操作授权。它和会话级分享
/// （`/api/sessions/:id/shares`，在 `chat_screen.dart` 里）不是一回事 ——
/// 那个分享的是一段对话，这个分享的是一整台机器上的一个工作区。
///
/// 接收方在自己的实例上导入后，这个工作区会以「共享工作区」的样子出现在工作区
/// 列表里。本文件只负责签发与导入这两步；远端工作区在列表里怎么显示、怎么刷新
/// 和移除，在 `air_panels.dart` 的目录卡片上。

/// 分享工作区。成功签发后对话框不关（要让人把链接复制走），返回时给调用方
/// 一个「有没有签发过」的信号，好去刷新列表。
Future<bool?> showFleetShareDialog(
  BuildContext context, {
  required AirDirectory directory,
  required SettingsService settings,
  AirService? service,
}) {
  return showDialog<bool>(
    context: context,
    builder: (_) => _FleetShareDialog(
      directory: directory,
      settings: settings,
      service: service,
    ),
  );
}

/// 导入共享工作区。[existing] 非空时是「刷新共享工作区」那一档：链接与别名用
/// 现有的填好，密码仍要重输（服务端只留换回来的授权，不留密码）。
Future<ExternalFleet?> showFleetImportDialog(
  BuildContext context, {
  required SettingsService settings,
  AirService? service,
  ExternalFleet? existing,
}) {
  return showDialog<ExternalFleet>(
    context: context,
    builder: (_) => _FleetImportDialog(
      settings: settings,
      service: service,
      existing: existing,
    ),
  );
}

/// Web 的 `displayDate`：`toLocaleString()`，认不出来的时间给一个破折号。
///
/// 服务端给的是带偏移的 ISO 串，`DateTime.tryParse` 之后取字段拿到的是 UTC 值，
/// 所以必须 `toLocal()` —— 少了这一步，分享的截止时间会平白早/晚几个小时。
String _displayDate(DateTime? value) {
  if (value == null) return '—';
  final local = value.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} '
      '${two(local.hour)}:${two(local.minute)}';
}

/// 对话框里那行「已生成的链接 + 复制」。与会话级分享弹窗里那张卡同一个样子。
class _UrlCard extends StatelessWidget {
  const _UrlCard({required this.url, required this.copyLabel});

  final String url;
  final String copyLabel;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: const Color(0xFFf8fbff),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: const Color(0xFFdce6f1)),
    ),
    child: Row(
      children: [
        Expanded(
          child: SelectableText(
            url,
            style: const TextStyle(color: Color(0xFF005cc5), fontSize: 12),
          ),
        ),
        const SizedBox(width: 8),
        Tooltip(
          message: copyLabel,
          child: IconButton(
            key: const ValueKey('fleet-share-copy'),
            iconSize: 18,
            visualDensity: VisualDensity.compact,
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: url));
              if (!context.mounted) return;
              ScaffoldMessenger.of(
                context,
              ).showSnackBar(const SnackBar(content: Text('分享链接已复制')));
            },
            icon: const Icon(Icons.copy_rounded, color: Color(0xFF6f8096)),
          ),
        ),
      ],
    ),
  );
}

/// 对话框里那种「一行标签 + 一个输入框」。
Widget _field(TextEditingController ctrl, String label, {Widget? child}) =>
    Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(color: AppColors.muted, fontSize: 12),
          ),
          const SizedBox(height: 5),
          child ?? _input(ctrl),
        ],
      ),
    );

Widget _input(
  TextEditingController ctrl, {
  String? hint,
  bool obscure = false,
  int maxLines = 1,
  TextInputType? keyboard,
}) => TextField(
  controller: ctrl,
  obscureText: obscure,
  maxLines: maxLines,
  keyboardType: keyboard,
  style: const TextStyle(color: AppColors.text, fontSize: 13.5),
  decoration: InputDecoration(
    hintText: hint,
    isDense: true,
    filled: true,
    fillColor: AppColors.well,
    contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 11),
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(8),
      borderSide: const BorderSide(color: AppColors.line),
    ),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(8),
      borderSide: const BorderSide(color: AppColors.line),
    ),
  ),
);

/// 对话框骨架：标题 + 一颗 × + 内容。两个弹窗共用。
class _Shell extends StatelessWidget {
  const _Shell({
    required this.title,
    required this.subtitle,
    required this.body,
    required this.actions,
  });

  final String title;
  final String subtitle;
  final Widget body;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) => Dialog(
    backgroundColor: AppColors.panel,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
    ),
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 460, maxHeight: 620),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 16, 8, 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    title,
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                IconButton(
                  key: const ValueKey('fleet-dialog-close'),
                  iconSize: 19,
                  visualDensity: VisualDensity.compact,
                  tooltip: '关闭',
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close_rounded, color: AppColors.faint),
                ),
              ],
            ),
          ),
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    subtitle,
                    style: const TextStyle(
                      color: AppColors.faint,
                      fontSize: 12,
                      height: 1.5,
                    ),
                  ),
                  const SizedBox(height: 14),
                  body,
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 6, 18, 16),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: actions,
            ),
          ),
        ],
      ),
    ),
  );
}

class _FleetShareDialog extends StatefulWidget {
  const _FleetShareDialog({
    required this.directory,
    required this.settings,
    required this.service,
  });

  final AirDirectory directory;
  final SettingsService settings;
  final AirService? service;

  @override
  State<_FleetShareDialog> createState() => _FleetShareDialogState();
}

class _FleetShareDialogState extends State<_FleetShareDialog> {
  /// 服务端的下限就是 6 位（`fleet-sharing.js` 里那条），这里先拦一道，免得
  /// 白发一次请求才被拒。
  static const _minPasswordLength = 6;

  final _passwordCtrl = TextEditingController();
  final _daysCtrl = TextEditingController(text: '7');
  final _accessesCtrl = TextEditingController(text: '10');
  final _descriptionCtrl = TextEditingController();

  AirService? _owned;
  List<FleetShare> _shares = const [];
  bool _loadingShares = true;
  bool _submitting = false;
  String _error = '';
  String? _url;
  bool _issued = false;

  AirService get _service =>
      widget.service ?? (_owned ??= AirService(settings: widget.settings));

  @override
  void initState() {
    super.initState();
    _loadShares();
  }

  @override
  void dispose() {
    _passwordCtrl.dispose();
    _daysCtrl.dispose();
    _accessesCtrl.dispose();
    _descriptionCtrl.dispose();
    if (_owned != null && widget.service == null) _owned!.close();
    super.dispose();
  }

  Future<void> _loadShares() async {
    try {
      final shares = await _service.listFleetShares(widget.directory.id);
      if (!mounted) return;
      setState(() {
        _shares = shares;
        _loadingShares = false;
      });
    } catch (_) {
      // 列不出来不该挡住签发 —— 那多半是这条路由还没落地（旧版服务），而
      // 「生成分享链接」会给出比这里更具体的一句话。
      if (!mounted) return;
      setState(() => _loadingShares = false);
    }
  }

  Future<void> _create() async {
    final password = _passwordCtrl.text;
    if (password.length < _minPasswordLength) {
      setState(() => _error = '访问密码至少 $_minPasswordLength 位。');
      return;
    }
    setState(() {
      _submitting = true;
      _error = '';
    });
    try {
      final share = await _service.createFleetShare(
        widget.directory.id,
        password: password,
        // 填了非数字就当默认值，不把 NaN 发给服务端 —— 服务端收到的
        // `expiresInDays` 不合法时会整条拒掉，而使用者只是手滑多打了个字。
        expiresInDays: int.tryParse(_daysCtrl.text.trim()) ?? 7,
        maxAccesses: int.tryParse(_accessesCtrl.text.trim()) ?? 10,
        description: _descriptionCtrl.text,
      );
      if (!mounted) return;
      setState(() {
        _url = share.url;
        _issued = true;
        _submitting = false;
      });
      await _loadShares();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _submitting = false;
      });
    }
  }

  Future<void> _revoke(FleetShare share) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.panel,
        content: const Text('撤销这个工作区分享？已发出的链接会立即失效。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            key: const ValueKey('fleet-share-revoke-confirm'),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('撤销', style: TextStyle(color: AppColors.danger)),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await _service.revokeFleetShare(widget.directory.id, share.token);
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('工作区分享已撤销')));
      await _loadShares();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('撤销失败：$e')));
    }
  }

  Widget _shareRow(FleetShare share) => Container(
    key: ValueKey('fleet-share-row-${share.token}'),
    margin: const EdgeInsets.only(bottom: 8),
    padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
    decoration: BoxDecoration(
      color: AppColors.well,
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: AppColors.line),
    ),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                share.url,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 12,
                  fontFamily: 'monospace',
                ),
              ),
              const SizedBox(height: 3),
              Text(
                // Web：`已过期` 或 `剩余 N/M 次`，后面统一缀上截止时间。
                '${share.expired ? '已过期' : '剩余 ${share.remainingAccesses}/${share.maxAccesses} 次'}'
                ' · 截止 ${_displayDate(share.expiresAt)}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.faint, fontSize: 11),
              ),
            ],
          ),
        ),
        TextButton(
          key: ValueKey('fleet-share-revoke-${share.token}'),
          onPressed: () => _revoke(share),
          style: TextButton.styleFrom(foregroundColor: AppColors.danger),
          child: const Text('撤销', style: TextStyle(fontSize: 12.5)),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        Navigator.of(context).pop(_issued);
      },
      child: _Shell(
        title: '分享工作区',
        subtitle:
            '为「${widget.directory.name}」创建跨实例、工作区范围的操作授权。',
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(_issued),
            child: const Text('取消'),
          ),
          const SizedBox(width: 6),
          FilledButton(
            key: const ValueKey('fleet-share-create'),
            onPressed: _submitting ? null : _create,
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF2ba67a),
              foregroundColor: Colors.white,
            ),
            child: _submitting
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Text('生成分享链接'),
          ),
        ],
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _field(
              _passwordCtrl,
              '访问密码（至少 $_minPasswordLength 位）',
              child: _input(_passwordCtrl, obscure: true),
            ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: _field(
                    _daysCtrl,
                    '有效天数',
                    child: _input(_daysCtrl, keyboard: TextInputType.number),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: _field(
                    _accessesCtrl,
                    '最多导入次数',
                    child: _input(
                      _accessesCtrl,
                      keyboard: TextInputType.number,
                    ),
                  ),
                ),
              ],
            ),
            _field(
              _descriptionCtrl,
              '给接收方的说明（可选）',
              child: _input(_descriptionCtrl, maxLines: 3),
            ),
            const Text(
              '接收方可查看并操作此工作区的会话和代码变更；不会获得 Provider 凭据或其他工作区的管理权限。',
              style: TextStyle(
                color: AppColors.faint,
                fontSize: 11.5,
                height: 1.5,
              ),
            ),
            if (_error.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(
                _error,
                key: const ValueKey('fleet-share-error'),
                style: const TextStyle(color: AppColors.danger, fontSize: 12),
              ),
            ],
            if (_url != null) ...[
              const SizedBox(height: 14),
              const Text(
                '分享链接已生成',
                style: TextStyle(
                  color: AppColors.text,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 6),
              _UrlCard(url: _url!, copyLabel: '复制'),
              const Text(
                '请把密码通过单独渠道发给接收方。',
                style: TextStyle(color: AppColors.faint, fontSize: 11.5),
              ),
            ],
            const SizedBox(height: 18),
            const Text(
              '现有分享',
              style: TextStyle(
                color: AppColors.muted,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            if (_loadingShares)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Center(
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Color(0xFF6f8096),
                    ),
                  ),
                ),
              )
            else if (_shares.isEmpty)
              const Text(
                '还没有有效分享。',
                key: ValueKey('fleet-share-empty'),
                style: TextStyle(color: AppColors.faint, fontSize: 12.5),
              )
            else
              ..._shares.map(_shareRow),
          ],
        ),
      ),
    );
  }
}

class _FleetImportDialog extends StatefulWidget {
  const _FleetImportDialog({
    required this.settings,
    required this.service,
    this.existing,
  });

  final SettingsService settings;
  final AirService? service;
  final ExternalFleet? existing;

  @override
  State<_FleetImportDialog> createState() => _FleetImportDialogState();
}

class _FleetImportDialogState extends State<_FleetImportDialog> {
  final _urlCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _aliasCtrl = TextEditingController();

  AirService? _owned;
  bool _submitting = false;
  String _error = '';

  AirService get _service =>
      widget.service ?? (_owned ??= AirService(settings: widget.settings));

  bool get _isRefresh => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    if (existing != null) {
      _urlCtrl.text = existing.shareUrl;
      _aliasCtrl.text = existing.alias;
    }
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    _passwordCtrl.dispose();
    _aliasCtrl.dispose();
    if (_owned != null && widget.service == null) _owned!.close();
    super.dispose();
  }

  Future<void> _submit() async {
    final shareUrl = _urlCtrl.text.trim();
    if (shareUrl.isEmpty) {
      setState(() => _error = '请先粘贴分享链接。');
      return;
    }
    if (_passwordCtrl.text.isEmpty) {
      setState(() => _error = '请填写分享密码。');
      return;
    }
    setState(() {
      _submitting = true;
      _error = '';
    });
    try {
      final fleet = await _service.importExternalFleet(
        shareUrl: shareUrl,
        password: _passwordCtrl.text,
        alias: _aliasCtrl.text.trim(),
      );
      if (!mounted) return;
      Navigator.of(context).pop(fleet);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _submitting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) => _Shell(
    title: _isRefresh ? '刷新共享工作区' : '导入共享工作区',
    subtitle: '粘贴另一台 MultiCC 生成的工作区分享链接。导入后会出现在工作区列表中，操作仍在来源实例执行。',
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('取消'),
      ),
      const SizedBox(width: 6),
      FilledButton(
        key: const ValueKey('fleet-import-submit'),
        onPressed: _submitting ? null : _submit,
        style: FilledButton.styleFrom(
          backgroundColor: const Color(0xFF2ba67a),
          foregroundColor: Colors.white,
        ),
        child: _submitting
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white,
                ),
              )
            : const Text('导入'),
      ),
    ],
    body: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _field(
          _urlCtrl,
          '分享链接',
          child: _input(
            _urlCtrl,
            hint: 'https://host/fleet-share/fleet_share_…',
            keyboard: TextInputType.url,
          ),
        ),
        _field(
          _passwordCtrl,
          '分享密码',
          child: _input(_passwordCtrl, obscure: true),
        ),
        _field(
          _aliasCtrl,
          '本地别名（可选）',
          child: _input(_aliasCtrl, hint: '例如：远程开发机'),
        ),
        const Text(
          '密码只用于本次导入，不会保存到本机；本机仅保存随机的工作区范围授权。',
          style: TextStyle(color: AppColors.faint, fontSize: 11.5, height: 1.5),
        ),
        if (_error.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text(
            _error,
            key: const ValueKey('fleet-import-error'),
            style: const TextStyle(color: AppColors.danger, fontSize: 12),
          ),
        ],
      ],
    ),
  );
}
