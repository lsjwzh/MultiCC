import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/air_ops_service.dart';
import '../../services/qr_encoder.dart';
import '../../theme.dart';
import 'air_ops_store.dart';

// ── 版本行 ────────────────────────────────────────────────────────────────
// 这一行本身就是那只读数表：🆕/📦 说有没有新版，点它才是更新入口。Web 那边
// 同一个行兼任两职（`paintVersion` + `#air-ver-row` 的 click）。

String opsVersionIcon(AirVersionInfo? info, {required bool checking}) {
  if (checking || info == null) return '⏳';
  return info.updateAvailable ? '🆕' : '📦';
}

String opsVersionHint(AirVersionInfo? info, {required bool checking}) {
  if (checking) return '检查中…';
  if (info == null) return '检查失败';
  if (info.updateAvailable) return '有新版';
  // 问不到远端和「已经最新」是两件事，不能糊成一句。
  return info.apiError ? '已是最新（离线）' : '已是最新';
}

/// 有新版时挂的那个版本号。远端没说是哪个版本时照样挂一个 `v`——Web 就是这么
/// 写的，读者看到的是一个「点我」的提示，不是一串精确到补丁号的版本。
String? opsVersionBadge(AirVersionInfo? info) {
  if (info == null || !info.updateAvailable) return null;
  return 'v${info.latestVersion ?? ''}';
}

// ── 开机时间 ──────────────────────────────────────────────────────────────

String _pad(int value) => value.toString().padLeft(2, '0');

String opsClockLabel(DateTime time) =>
    '${_pad(time.month)}-${_pad(time.day)} ${_pad(time.hour)}:${_pad(time.minute)}';

/// 粗到只留两个单位：没人从侧栏上读「2h 15m 6s」，而多一个秒字段就得每秒重画。
String opsUptimeLabel(int ms) {
  final minutes = ms ~/ 60000;
  if (minutes < 1) return '<1m';
  final days = minutes ~/ 1440;
  final hours = (minutes % 1440) ~/ 60;
  if (days > 0) return hours > 0 ? '${days}d ${hours}h' : '${days}d';
  if (hours > 0) return '${hours}h ${minutes % 60}m';
  return '${minutes}m';
}

/// 开始时刻是从本地的「现在」往回推的，不是读主机的钟：主机的表要是偏了几小时，
/// 屏幕上就会写一个还没到的启动时间。
({String started, String uptime}) opsBootLabels({
  required int uptimeMs,
  required DateTime now,
}) {
  final started = now.subtract(Duration(milliseconds: uptimeMs));
  return (started: opsClockLabel(started), uptime: '已运行 ${opsUptimeLabel(uptimeMs)}');
}

// ── 安装包 ────────────────────────────────────────────────────────────────

String opsPackageSize(int bytes) {
  if (bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).round()} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

String opsPackageMtime(int ms) {
  if (ms <= 0) return '—';
  return opsClockLabel(DateTime.fromMillisecondsSinceEpoch(ms));
}

// ── 更新 ──────────────────────────────────────────────────────────────────

String opsUpdateDialogTitle(AirVersionInfo info) =>
    info.updateAvailable ? '发现新版本' : '更新 MultiCC';

String opsUpdateDialogBody(AirVersionInfo info) {
  final current = 'v${info.current.isEmpty ? '—' : info.current}';
  final channel = info.channel.isEmpty ? 'dev' : info.channel;
  final latest = info.latest ?? '';
  final latestLine = info.updateAvailable
      ? '最新版本：$latest'
      : info.apiError
      ? '最新版本：无法连接检查服务（离线）'
      : '最新版本：${latest.isEmpty ? '未知' : latest} — 当前已是最新';
  return [
    '当前版本：$current（通道：$channel）',
    latestLine,
    '',
    '更新会拉取最新代码、必要时重装依赖，并在完成后自动重启服务。',
    '重启会短暂断开所有会话；正在输出的会话会被中断，其在途内容会先保存。',
  ].join('\n');
}

const String opsForceLabel =
    '强制更新：工作区有改动或历史分叉时也更新。本地改动会先备份到 git stash'
    '（不会自动恢复），代码将重置到远端最新。';

/// 更新过程中侧栏版本行上那句话。服务掉线那一段也算过程的一部分，不能报成失败。
String opsUpdateHint(AirUpdateRun run, {required bool sawUnreachable}) {
  if (run.unreachable) return '服务重启中…';
  if (run.finished) return '更新完成，正在重载…';
  if (run.broken) return run.state == 'failed' ? '更新失败' : '更新无响应';
  if (run.state == 'timeout') return '更新超时';
  if (run.state == 'running') {
    final last = run.tail.trim().split('\n').last;
    if (last.isEmpty) return '正在更新…';
    return last.length > 40 ? last.substring(0, 40) : last;
  }
  return '正在更新…';
}

// ── 版本行 ────────────────────────────────────────────────────────────────

/// 折叠区外的那一行：它是更新提示唯一的落点，藏进折叠里就没人知道有新版本。
class AirVersionRow extends StatelessWidget {
  const AirVersionRow({
    super.key,
    required this.store,
    this.language,
    this.onLanguage,
  });

  final AirOpsStore store;
  final String? language;
  final VoidCallback? onLanguage;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final info = store.version;
        final current = info?.current ?? '';
        final badge = opsVersionBadge(info);
        final hint = opsUpdateHintFor(store) ?? opsVersionHint(info, checking: store.versionPending);
        final version = Semantics(
          button: true,
          label: '版本 $hint，点击检查并安装更新',
          child: Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(AppColors.radiusChip),
            child: InkWell(
              key: const ValueKey('air-ver-row'),
              onTap: () => unawaited(openAirUpdateFlow(context, store)),
              borderRadius: BorderRadius.circular(AppColors.radiusChip),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                child: Row(
                  children: [
                    Text(
                      opsVersionIcon(info, checking: store.versionPending),
                      style: const TextStyle(fontSize: 14),
                    ),
                    const SizedBox(width: 9),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            'v${current.isEmpty ? '—' : current}',
                            key: const ValueKey('air-ver-current'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: AppColors.text,
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          Text(
                            hint,
                            key: const ValueKey('air-ver-hint'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: store.updating ? AppColors.blue : AppColors.faint,
                              fontSize: 10.5,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (badge != null)
                      Container(
                        key: const ValueKey('air-ver-badge'),
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                        decoration: BoxDecoration(
                          color: AppColors.blueSoft,
                          borderRadius: BorderRadius.circular(AppColors.radiusPill),
                          border: Border.all(color: AppColors.blue.withValues(alpha: 0.35)),
                        ),
                        child: Text(
                          badge,
                          style: const TextStyle(
                            color: AppColors.blue,
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
        if (onLanguage == null) return version;
        final english = language == 'en';
        return Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(child: version),
            const SizedBox(width: 5),
            Tooltip(
              message: english
                  ? 'Switch language: 中文 / English'
                  : '切换语言：中文 / English',
              child: OutlinedButton(
                key: const ValueKey('air-sidebar-language'),
                onPressed: onLanguage,
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.blue,
                  minimumSize: const Size(50, 44),
                  padding: const EdgeInsets.symmetric(horizontal: 7),
                  side: const BorderSide(color: AppColors.line),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(AppColors.radiusChip),
                  ),
                ),
                child: Text(
                  english ? 'EN/中' : '中/EN',
                  style: const TextStyle(fontSize: 11),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// 正在跟一次更新时，版本行让位给进度；不在更新就返回 null。
String? opsUpdateHintFor(AirOpsStore store) {
  final run = store.updateRun;
  if (run == null) return null;
  if (run.finished || run.broken || run.state == 'timeout') return opsUpdateHint(run, sawUnreachable: false);
  return opsUpdateHint(run, sawUnreachable: run.unreachable);
}

// ── 折叠区里那一块 ────────────────────────────────────────────────────────

/// 「更多与系统」里的运维区：最近启动 + 一排主机动作。
///
/// 推送通知这一项在原生侧不是浏览器订阅（Web 是 pwa.js 的 web-push），而是这台
/// 机器自己的通知通道，所以它只报「开着没有」，开关本身在设置中心。
class AirOpsPanel extends StatelessWidget {
  const AirOpsPanel({
    super.key,
    required this.store,
    required this.onOpenPush,
    required this.onLogout,
  });

  final AirOpsStore store;
  final VoidCallback onOpenPush;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final boot = opsBootLabels(
          uptimeMs: store.uptimeMs,
          now: store.now(),
        );
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // 和上面那行版本分开：那行点下去会发请求，读一眼时间不该触发调用。
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 2, 10, 0),
              child: Row(
                children: [
                  const Expanded(
                    child: Text(
                      '最近启动',
                      style: TextStyle(color: AppColors.muted, fontSize: 12.5),
                    ),
                  ),
                  Text(
                    store.hasBootReading ? boot.started : '—',
                    key: const ValueKey('air-boot-time'),
                    style: const TextStyle(color: AppColors.muted, fontSize: 12.5),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 1, 10, 6),
              child: Text(
                store.hasBootReading ? boot.uptime : '',
                key: const ValueKey('air-boot-uptime'),
                style: const TextStyle(color: AppColors.faint, fontSize: 10.5),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  _OpsButton(
                    semanticKey: 'air-apk-btn',
                    label: '安装包',
                    onTap: () => unawaited(openAirPackages(context, store)),
                  ),
                  _OpsButton(
                    semanticKey: 'air-qr-btn',
                    label: '二维码',
                    onTap: () => unawaited(openAirQr(context, store)),
                  ),
                  _OpsButton(
                    semanticKey: 'air-push-btn',
                    label: '推送通知',
                    on: store.pushEnabled,
                    onTap: onOpenPush,
                  ),
                  _OpsButton(
                    semanticKey: 'air-restart-btn',
                    label: '🔄 重启',
                    onTap: () => unawaited(confirmAirRestart(context, store)),
                  ),
                  _OpsButton(
                    semanticKey: 'air-logout-btn',
                    label: '退出登录',
                    onTap: onLogout,
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

class _OpsButton extends StatelessWidget {
  const _OpsButton({
    required this.semanticKey,
    required this.label,
    required this.onTap,
    this.on = false,
  });

  final String semanticKey;
  final String label;
  final VoidCallback onTap;
  final bool on;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      key: ValueKey(semanticKey),
      onPressed: onTap,
      style: OutlinedButton.styleFrom(
        foregroundColor: on ? AppColors.accentDark : AppColors.muted,
        backgroundColor: on ? AppColors.blueSoft : Colors.transparent,
        side: BorderSide(color: on ? AppColors.accent : AppColors.lineStrong),
        padding: const EdgeInsets.symmetric(horizontal: 10),
        minimumSize: const Size(0, 32),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppColors.radiusButton),
        ),
      ),
      child: Text(label, style: const TextStyle(fontSize: 12)),
    );
  }
}

/// 折叠区外的回执行：运维动作的结果要看得见，折起来会连回执一起藏掉。
class AirOpsReceipt extends StatelessWidget {
  const AirOpsReceipt({super.key, required this.store});

  final AirOpsStore store;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) => Padding(
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 4),
        child: Text(
          store.receipt,
          key: const ValueKey('air-ops-status'),
          style: TextStyle(
            color: switch (store.receiptTone) {
              'err' => AppColors.danger,
              'warn' => AppColors.amber,
              _ => AppColors.muted,
            },
            fontSize: 11,
            height: 1.35,
          ),
        ),
      ),
    );
  }
}

// ── 更新问答 ──────────────────────────────────────────────────────────────

/// 点版本行之后的整条路：已经在跑就接管进度，否则先查版本、再让人确认。
Future<void> openAirUpdateFlow(BuildContext context, AirOpsStore store) async {
  if (!context.mounted) return;
  final running = await store.updateStatus();
  if (!context.mounted) return;
  if (running.running) {
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _AirUpdateDialog(store: store, attached: running),
    );
    return;
  }
  final info = await store.checkVersion();
  if (!context.mounted) return;
  if (info == null) {
    store.say('检查更新失败，请稍后再试', tone: 'err');
    return;
  }
  final force = await showDialog<bool>(
    context: context,
    builder: (_) => _AirUpdateConfirmDialog(info: info),
  );
  if (force == null || !context.mounted) return;
  await showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _AirUpdateDialog(store: store, force: force),
  );
}

/// 确认框：把「现在是什么版本、会变成什么版本、会付什么代价」写全，再问要不要。
class _AirUpdateConfirmDialog extends StatefulWidget {
  const _AirUpdateConfirmDialog({required this.info});

  final AirVersionInfo info;

  @override
  State<_AirUpdateConfirmDialog> createState() => _AirUpdateConfirmDialogState();
}

class _AirUpdateConfirmDialogState extends State<_AirUpdateConfirmDialog> {
  bool _force = false;

  @override
  Widget build(BuildContext context) {
    return AirOpsDialog(
      title: opsUpdateDialogTitle(widget.info),
      body: opsUpdateDialogBody(widget.info),
      extra: CheckboxListTile(
        key: const ValueKey('air-ops-force'),
        value: _force,
        onChanged: (value) => setState(() => _force = value ?? false),
        controlAffinity: ListTileControlAffinity.leading,
        contentPadding: EdgeInsets.zero,
        dense: true,
        title: const Text(
          opsForceLabel,
          style: TextStyle(color: AppColors.muted, fontSize: 11.5, height: 1.4),
        ),
      ),
      actions: [
        TextButton(
          key: const ValueKey('air-ops-cancel'),
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          key: const ValueKey('air-ops-confirm'),
          onPressed: () => Navigator.of(context).pop(_force),
          child: Text(widget.info.updateAvailable ? '立即更新' : '仍要更新'),
        ),
      ],
    );
  }
}

/// 更新进行中/结束的那一屏。全程不关：关掉的话进度就没人跟了——「后台运行」是
/// 唯一允许的退场，因为它只是把这一屏收起来，轮询照旧。
class _AirUpdateDialog extends StatefulWidget {
  const _AirUpdateDialog({required this.store, this.force = false, this.attached});

  final AirOpsStore store;
  final bool force;

  /// 已经在跑的那一次（从 `/api/update/status` 读到的）。给了就只接管，不再发
  /// 起第二次更新。
  final AirUpdateRun? attached;

  @override
  State<_AirUpdateDialog> createState() => _AirUpdateDialogState();
}

class _AirUpdateDialogState extends State<_AirUpdateDialog> {
  String _title = '正在更新';
  String _body = '正在启动更新…';
  String _log = '';
  List<Widget> _actions = const [];
  bool _wasForced = false;
  bool _polling = true;

  @override
  void initState() {
    super.initState();
    unawaited(_run());
  }

  Future<void> _run() async {
    final attached = widget.attached;
    _wasForced = attached?.force ?? widget.force;
    if (attached != null) {
      if (!mounted) return;
      setState(() {
        _body = '已有一个更新正在进行，正在接管其进度…';
        _log = attached.tail;
      });
      _backgroundOnly();
    } else {
      final result = await widget.store.startUpdate(force: widget.force);
      if (!mounted) return;
      if (result.alreadyRunning) {
        setState(() => _body = '已有一个更新正在进行，正在接管其进度…');
        _backgroundOnly();
      } else if (!result.ok) {
        setState(() {
          _title = '无法启动更新';
          _body = result.error.isEmpty
              ? 'HTTP ${result.status}'
              : result.error + (result.code.isEmpty ? '' : '\n(${result.code})');
          _actions = [_closeButton('关闭')];
          _polling = false;
        });
        return;
      } else {
        setState(() => _body = '正在更新，请勿关闭本机。完成后服务会自动重启。');
        _backgroundOnly();
      }
    }
    await widget.store.pollUntilDone(
      force: _wasForced,
      onState: (run, sawUnreachable) {
        if (!mounted) return;
        _paint(run, sawUnreachable: sawUnreachable);
      },
    );
  }

  void _backgroundOnly() {
    setState(() => _actions = [_closeButton('后台运行')]);
  }

  Widget _closeButton(String label) => TextButton(
    key: const ValueKey('air-ops-close'),
    onPressed: () => Navigator.of(context).pop(),
    child: Text(label),
  );

  void _paint(AirUpdateRun run, {required bool sawUnreachable}) {
    final hint = opsUpdateHint(run, sawUnreachable: sawUnreachable);
    setState(() {
      if (run.unreachable) {
        _body = '服务正在重启，连接已暂时断开。这一步通常需要几秒钟。';
        return;
      }
      if (run.finished) {
        _title = '更新完成';
        // Web 到这里就 location.reload() 了；App 没有可刷新的页面，它自己会重连，
        // 所以这里只把话说完，再给人一个退出这一屏的按钮。
        _body = '更新已完成，服务已重启。App 会自己重连。';
        _log = run.tail;
        _actions = [_closeButton('关闭')];
        _polling = false;
        return;
      }
      if (run.state == 'timeout') {
        _title = '更新超时';
        _body = '等待超过 20 分钟仍未结束。请到服务器上查看 logs/update.log。';
        _actions = [_closeButton('关闭')];
        _polling = false;
        return;
      }
      if (run.broken) {
        final failed = run.state == 'failed';
        _title = failed ? '更新失败' : '更新失去响应';
        _body = failed
            ? '更新未完成（退出码 ${run.exitCode}）。服务没有被更新，下面是完整输出：'
            : '更新进程超过 15 分钟没有任何输出，可能已被系统结束。下面是它最后的输出：';
        _log = run.tail.isEmpty ? '(无输出)' : run.tail;
        _actions = [
          // 这一次是不是强制的，以这次运行自己的记录为准：这一屏可能是从另一个
          // 端接管过来的。
          if (failed && !_wasForced)
            FilledButton(
              key: const ValueKey('air-ops-force-retry'),
              style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
              onPressed: () => unawaited(_retryForced()),
              child: const Text('强制更新重试'),
            ),
          _closeButton('关闭'),
        ];
        _polling = false;
        return;
      }
      if (run.state == 'running') {
        _body = sawUnreachable ? '服务已回来，正在收尾…' : '正在更新，请勿关闭本机。完成后服务会自动重启。';
        _log = run.tail;
        return;
      }
      _body = '正在启动更新…';
    });
    unawaited(_afterPaint(run, hint));
  }

  /// 成功之后补两件事：重新读一次开机时间（新进程）和版本（新代码）。这比刷新
  /// 页面更省事，也更诚实——屏幕上那两个数都来自服务端，不是我们猜的。
  Future<void> _afterPaint(AirUpdateRun run, String hint) async {
    if (!run.finished) return;
    widget.store.say('更新完成，服务已重启，App 会自动重连。');
    await widget.store.loadBootTime();
    await widget.store.checkVersion();
  }

  Future<void> _retryForced() async {
    final store = widget.store;
    // 先记下宿主再收这一屏：pop 之后这个 context 就不是能挂对话框的那一个了。
    final host = Navigator.of(context).context;
    Navigator.of(context).pop();
    await showDialog<void>(
      context: host,
      barrierDismissible: false,
      builder: (_) => _AirUpdateDialog(store: store, force: true),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AirOpsDialog(
      title: _title,
      body: _body,
      log: _log,
      dismissible: !_polling,
      actions: _actions,
    );
  }
}

// ── 二维码 ────────────────────────────────────────────────────────────────

/// 二维码里放什么：主机自己报的局域网地址优先，问不到就退回配好的主机地址
/// （Web 那边退回的是 `location.origin`）。尾巴上那个斜杠要去掉，不然拼出来
/// 是 `http://x:3000//air`。两边都空就返回空串，由界面说清楚。
String qrAirUrl({String? serverUrl, required String fallbackHost}) {
  final reported = (serverUrl ?? '').trim();
  final base = reported.isEmpty ? fallbackHost.trim() : reported;
  if (base.isEmpty) return '';
  return '${base.replaceAll(RegExp(r'/+$'), '')}/air';
}

/// 扫的是**另一台设备**：手机相机打开这个地址，就在同一网络下进到这台主机的
/// Air 控制台。所以内容必须是局域网可达的那个地址，不是 App 自己连的那个。
Future<void> openAirQr(BuildContext context, AirOpsStore store) async {
  // 读数还没到就先问一次；问不到也没关系，退回配好的主机地址。
  if (store.serverInfo == null) await store.loadBootTime();
  if (!context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (_) => _AirQrDialog(store: store),
  );
}

class _AirQrDialog extends StatelessWidget {
  const _AirQrDialog({required this.store});

  final AirOpsStore store;

  @override
  Widget build(BuildContext context) {
    final url = qrAirUrl(
      serverUrl: store.serverInfo?.url,
      fallbackHost: store.settings.host,
    );
    QrCode? code;
    String? failure;
    if (url.isNotEmpty) {
      try {
        code = encodeQr(url);
      } on ArgumentError {
        // 只有长到版本 40 都放不下才会走到这儿；说清楚，别画一张错的。
        failure = '地址太长，画不成二维码。手动访问：$url';
      }
    }
    return AirOpsDialog(
      title: '扫码打开 MultiCC Air',
      body: code == null
          ? (failure ?? '这台主机的地址还没读到，稍后再试。')
          : '用手机相机扫码，在同一网络下打开这台主机的 Air 控制台。',
      extra: code == null ? null : _QrCanvas(code: code, url: url),
      actions: [_closeTextButton(context)],
    );
  }
}

class _QrCanvas extends StatelessWidget {
  const _QrCanvas({required this.code, required this.url});

  final QrCode code;
  final String url;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Center(
          child: Container(
            // 黑模块白底，和 Web 那边一样：套上 shell 的配色是好看，但扫不动。
            // 外面这圈留白也不是装饰，是标准要求的静默区。
            color: Colors.white,
            padding: const EdgeInsets.all(12),
            child: CustomPaint(
              key: const ValueKey('air-qr-image'),
              size: const Size.square(200),
              painter: _QrPainter(code),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          url,
          key: const ValueKey('air-qr-url'),
          textAlign: TextAlign.center,
          style: const TextStyle(color: AppColors.muted, fontSize: 11.5, height: 1.4),
        ),
      ],
    );
  }
}

class _QrPainter extends CustomPainter {
  const _QrPainter(this.code);

  final QrCode code;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = size.width / code.size;
    // 关掉抗锯齿：相邻的格子得严丝合缝，不然缩放时中间会露出一道白缝。
    final paint = Paint()
      ..color = Colors.black
      ..isAntiAlias = false;
    for (var row = 0; row < code.size; row++) {
      for (var column = 0; column < code.size; column++) {
        if (!code.isDark(row, column)) continue;
        canvas.drawRect(Rect.fromLTWH(column * cell, row * cell, cell, cell), paint);
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter oldDelegate) => oldDelegate.code != code;
}

// ── 安装包 ────────────────────────────────────────────────────────────────

Future<void> openAirPackages(BuildContext context, AirOpsStore store) async {
  await showDialog<void>(
    context: context,
    builder: (_) => _AirPackagesDialog(store: store),
  );
}

class _AirPackagesDialog extends StatefulWidget {
  const _AirPackagesDialog({required this.store});

  final AirOpsStore store;

  @override
  State<_AirPackagesDialog> createState() => _AirPackagesDialogState();
}

class _AirPackagesDialogState extends State<_AirPackagesDialog> {
  bool _loading = true;
  List<AirPackage> _packages = const [];

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final packages = await widget.store.loadPackages();
    if (!mounted) return;
    setState(() {
      _packages = packages;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final body = _loading
        ? '正在读取…'
        : _packages.isEmpty
        ? '这台主机还没有可用的安装包。运行发布脚本后回到这里即可下载。'
        : '直接下载安装包，或打开 iOS 的免重启安装页。';
    return AirOpsDialog(
      title: '安装包',
      body: body,
      extra: _packages.isEmpty
          ? null
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final package in _packages)
                  _PackageRow(
                    package: package,
                    onOpen: () => unawaited(_open(package)),
                  ),
              ],
            ),
      actions: [_closeTextButton(context)],
    );
  }

  Future<void> _open(AirPackage package) async {
    final uri = Uri.tryParse(package.url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (error) {
      if (!mounted) return;
      widget.store.say('打开下载链接失败：$error', tone: 'err');
    }
  }
}

class _PackageRow extends StatelessWidget {
  const _PackageRow({required this.package, required this.onOpen});

  final AirPackage package;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        key: ValueKey('air-package-${package.platform}'),
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  package.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: AppColors.text,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  '${opsPackageSize(package.size)} · ${opsPackageMtime(package.mtime)}',
                  style: const TextStyle(color: AppColors.faint, fontSize: 11),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          FilledButton(
            key: ValueKey('air-package-open-${package.platform}'),
            onPressed: onOpen,
            style: FilledButton.styleFrom(
              minimumSize: const Size(0, 34),
              padding: const EdgeInsets.symmetric(horizontal: 14),
            ),
            child: const Text('下载', style: TextStyle(fontSize: 12.5)),
          ),
        ],
      ),
    );
  }
}

// ── 重启 / 退出登录 ───────────────────────────────────────────────────────

Future<void> confirmAirRestart(BuildContext context, AirOpsStore store) async {
  final agreed = await showDialog<bool>(
    context: context,
    builder: (_) => AirOpsDialog(
      title: '重启服务',
      body: '确定要重启 multicc 服务吗？\n这会短暂断开所有会话，随后自动重连（在途消息会先保存）。',
      actions: [
        TextButton(
          key: const ValueKey('air-ops-cancel'),
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('取消'),
        ),
        FilledButton(
          key: const ValueKey('air-ops-restart-confirm'),
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('重启'),
        ),
      ],
    ),
  );
  if (agreed != true) return;
  await store.restart();
}

/// 退出登录 = 这台机器忘掉那台主机和它的访问令牌。
///
/// Web 的 `/logout` 清的是服务端 cookie，本机什么都没留；App 把主机和令牌存在
/// 本机偏好里，所以「退出」必须连历史记录一起清——只清当前那一份的话，列表里
/// 那一行还带着令牌，点一下就又进去了，等于没退。
Future<void> confirmAirLogout(
  BuildContext context, {
  required Future<void> Function() onLogout,
}) async {
  final agreed = await showDialog<bool>(
    context: context,
    builder: (_) => AirOpsDialog(
      title: '退出登录',
      body: '本机会忘掉这台主机和它的访问令牌，回到连接设置重新登录。\n主机上的任务、会话和数据都不受影响。',
      actions: [
        TextButton(
          key: const ValueKey('air-ops-cancel'),
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('取消'),
        ),
        FilledButton(
          key: const ValueKey('air-ops-logout-confirm'),
          style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('退出登录'),
        ),
      ],
    ),
  );
  if (agreed != true) return;
  await onLogout();
}

// ── 共用的对话框外壳 ──────────────────────────────────────────────────────
// 和 Air 里其它对话框同一副骨架（见 air_role_editor.dart）：窄屏上左右各留 16，
// 宽屏封顶 560，正文在上、动作在下。
class AirOpsDialog extends StatelessWidget {
  const AirOpsDialog({
    super.key,
    required this.title,
    required this.body,
    this.extra,
    this.log = '',
    this.actions = const [],
    this.dismissible = true,
  });

  final String title;
  final String body;
  final Widget? extra;
  final String log;
  final List<Widget> actions;

  /// 更新进行中不给退：那一屏关掉，进度就没人跟了（「后台运行」是另一回事）。
  final bool dismissible;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      key: const ValueKey('air-ops-dialog'),
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      backgroundColor: AppColors.panel,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppColors.radiusPanel),
        side: const BorderSide(color: AppColors.line),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 14),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      key: const ValueKey('air-ops-title'),
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  if (dismissible)
                    IconButton(
                      key: const ValueKey('air-ops-close-x'),
                      icon: const Icon(Icons.close_rounded, size: 20),
                      color: AppColors.muted,
                      tooltip: '关闭',
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                ],
              ),
              const SizedBox(height: 6),
              Flexible(
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (body.isNotEmpty)
                        Text(
                          body,
                          key: const ValueKey('air-ops-body'),
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 12.5,
                            height: 1.5,
                          ),
                        ),
                      if (extra != null) ...[const SizedBox(height: 10), extra!],
                      if (log.isNotEmpty)
                        Container(
                          key: const ValueKey('air-ops-log'),
                          margin: const EdgeInsets.only(top: 10),
                          padding: const EdgeInsets.all(10),
                          constraints: const BoxConstraints(maxHeight: 180),
                          decoration: BoxDecoration(
                            color: AppColors.well,
                            borderRadius: BorderRadius.circular(AppColors.radiusChip),
                            border: Border.all(color: AppColors.line),
                          ),
                          child: SingleChildScrollView(
                            child: Text(
                              log,
                              style: const TextStyle(
                                color: AppColors.muted,
                                fontSize: 10.5,
                                fontFamily: 'monospace',
                                height: 1.4,
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              if (actions.isNotEmpty) ...[
                const SizedBox(height: 12),
                Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 8,
                  children: actions,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

TextButton _closeTextButton(BuildContext context) => TextButton(
  key: const ValueKey('air-ops-close'),
  onPressed: () => Navigator.of(context).pop(),
  child: const Text('关闭'),
);
