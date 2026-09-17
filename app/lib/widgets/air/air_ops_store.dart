import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../../services/air_ops_service.dart';
import '../../services/settings_service.dart';

/// 侧栏底部那几行字的唯一一份状态（Web `public/air-ops.js`）。
///
/// 版本行留在折叠区外、开机时间在折叠区里、回执又在折叠区外——三处长得不一样，
/// 说的却是同一件事。Web 靠一个模块里的闭包变量把它们串起来；这里换成
/// [ChangeNotifier]，三个位置各挂一个 `ListenableBuilder`，不用把状态复制三份
/// 再指望它们一直一致。
class AirOpsStore extends ChangeNotifier {
  AirOpsStore({
    required this.settings,
    this.httpClient,
    AirOpsService? service,
    DateTime Function()? clock,
    Duration pollInterval = const Duration(milliseconds: 2500),
    Duration repaintInterval = const Duration(seconds: 60),
    Duration versionInterval = const Duration(hours: 1),
    this.updateDeadline = const Duration(minutes: 20),
  }) : service = service ?? AirOpsService(settings: settings, httpClient: httpClient),
       _clock = clock ?? DateTime.now,
       _repaintInterval = repaintInterval,
       _versionInterval = versionInterval,
       _pollInterval = pollInterval;

  final SettingsService settings;
  final http.Client? httpClient;
  final AirOpsService service;

  /// 这一层的时间来源。开机时长和更新时限都拿它比，测试里换成能推着走的钟。
  final DateTime Function() _clock;

  DateTime now() => _clock();

  /// 轮询更新状态、重画开机时长、定时查版本的三个节拍。
  final Duration _pollInterval;
  final Duration _repaintInterval;
  final Duration _versionInterval;

  /// 等到这里还不见结果就收手，别让一次卡住的更新把这一页永远占住。
  final Duration updateDeadline;

  AirVersionInfo? version;
  bool checkingVersion = false;

  /// 第一次答复回来之前，版本行说的是「检查中…」而不是「检查失败」——还没问过
  /// 和问过没答复是两件事。
  bool checkedOnce = false;

  bool get versionPending => checkingVersion || !checkedOnce;

  AirServerInfo? serverInfo;

  /// 收到服务端那条读数的那一刻（本地时钟）。开机时长从这里往前推，不去信主机
  /// 自己的钟。
  DateTime? bootReadingAt;

  String receipt = '';
  String receiptTone = '';
  /// 关盖运行：null = 还没读到（或读不到），false = 这台主机没这个能力。
  /// 三态是必要的：还没问过就摆一个开关，用户点下去才发现这台机器根本不支持。
  bool? lidSleepAvailable;
  bool lidSleepOn = false;
  bool lidSleepBusy = false;

  /// 正在跑的更新。null 表示没在跟任何一次更新。
  AirUpdateRun? updateRun;

  bool get updating => updateRun != null && !updateRun!.finished && !updateRun!.broken;

  Timer? _receiptTimer;
  Timer? _repaintTimer;
  Timer? _versionTimer;
  bool _disposed = false;

  /// 开机多久了（毫秒）。服务端读数 + 本地流逝，主机表不准也不会显示未来的时间。
  int get uptimeMs {
    final info = serverInfo;
    final at = bootReadingAt;
    if (info == null || at == null) return 0;
    return info.uptimeMs + _clock().difference(at).inMilliseconds;
  }

  bool get hasBootReading => serverInfo != null && bootReadingAt != null;

  /// 一次开机的读数 + 一个每分钟重画一次的表。前者不会变（进程活着就不会变），
  /// 所以重画不发请求——Web 那边也是这么省的。
  void start() {
    _repaintTimer ??= Timer.periodic(_repaintInterval, (_) => _notify());
    // 版本行是唯一能发现新版的地方，所以它每隔一段时间自己查一次；正跟着一次
    // 更新时不查——那会让版本行把那一次的进度挤掉。
    _versionTimer ??= Timer.periodic(_versionInterval, (_) {
      if (!updating) unawaited(checkVersion());
    });
    unawaited(loadBootTime());
    unawaited(loadLidSleep());
    unawaited(checkVersion());
  }

  @override
  void dispose() {
    _disposed = true;
    _receiptTimer?.cancel();
    _repaintTimer?.cancel();
    _versionTimer?.cancel();
    super.dispose();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// 回执八秒后自己消失：它讲的是刚才那一下的结果，不该永远挂在那里。
  void say(String text, {String tone = ''}) {
    receipt = text;
    receiptTone = tone;
    _receiptTimer?.cancel();
    _notify();
    if (text.isEmpty) return;
    _receiptTimer = Timer(const Duration(seconds: 8), () {
      receipt = '';
      receiptTone = '';
      _notify();
    });
  }

  Future<void> loadBootTime() async {
    try {
      final info = await service.fetchServerInfo();
      if (!info.known) return; // 让占位符留着，别写一个假时间
      serverInfo = info;
      bootReadingAt = _clock();
      _notify();
    } catch (_) {
      // 连不上的主机有比侧栏一个横杠更明显的症状，这里不吵。
    }
  }

  Future<AirVersionInfo?> checkVersion() async {
    checkingVersion = true;
    _notify();
    try {
      final info = await service.checkVersion();
      version = info;
      return info;
    } catch (_) {
      version = null;
      return null;
    } finally {
      checkingVersion = false;
      checkedOnce = true;
      _notify();
    }
  }

  /// 「安装包」这一页要的两个包。读不到就返回空表，由界面说「还没有可用的包」。
  Future<List<AirPackage>> loadPackages() => service.fetchPackages();

  /// 问一次当前那次更新跑到哪了。问不到是一个状态，不是异常。
  Future<AirUpdateRun> updateStatus() => service.updateStatus();

  /// 真正按下「更新」之后的那一步。force 由确认框里的勾选决定。
  ///
  /// 这里只负责发起，不接管进度：轮询由那一屏对话框自己跟，因为它才是要把每一
  /// 拍画出来的地方（见 `_AirUpdateDialog`）。
  Future<AirUpdateStart> startUpdate({bool force = false}) async {
    AirUpdateStart result;
    try {
      result = await service.startUpdate(force: force);
    } catch (error) {
      return AirUpdateStart(ok: false, status: 0, error: '$error');
    }
    if (result.activeStreaming > 0) {
      say(
        '⚠️ 有 ${result.activeStreaming} 个会话正在输出，更新后的重启会中断它们（在途内容已保存）',
        tone: 'warn',
      );
    }
    return result;
  }

  /// 轮询到出结果为止。每一次都要让界面看得见——更新中途服务会掉线，那一段也
  /// 属于这次更新的过程。
  ///
  /// [onState] 在每一拍被叫一次，宿主用它更新对话框；返回 false 表示对话框已经
  /// 关了，就不再改它，但轮询照旧（进度是这次运行的，不是那个对话框的）。
  Future<void> pollUntilDone({
    required bool force,
    void Function(AirUpdateRun run, bool sawUnreachable)? onState,
  }) async {
    final startedAt = _clock();
    var sawUnreachable = false;
    for (;;) {
      final run = await service.updateStatus();
      if (_disposed) return;
      updateRun = run;
      _notify();
      if (run.unreachable) sawUnreachable = true;
      onState?.call(run, sawUnreachable);
      if (run.finished || run.broken) return;
      if (_clock().difference(startedAt) > updateDeadline) {
        updateRun = const AirUpdateRun(state: 'timeout', running: false);
        _notify();
        onState?.call(updateRun!, sawUnreachable);
        return;
      }
      await Future<void>.delayed(_pollInterval);
      if (_disposed) return;
    }
  }

  /// 关盖运行的当前状态（Web `air.js` 的 loadLidSleepRow）。
  ///
  /// 读不到就保持 null（这一行先不出现），不写回执：侧栏不是报错的地方，而且
  /// 主机连不上这件事本身有别的地方在说。只有服务端明确答 available=false
  /// （非 macOS）才把这一行永久关掉。
  Future<void> loadLidSleep() async {
    try {
      final status = await service.fetchMacLidSleep();
      lidSleepAvailable = status.available;
      lidSleepOn = status.enabled;
    } catch (_) {
      return;
    }
    _notify();
  }

  /// 点一下开关。先动界面再发请求：授权框是弹在 Mac 上的，用户在这台设备上按下去
  /// 之后不该看到一个还停在旧状态的开关。失败退回服务端答的状态（Web 同款）。
  Future<void> toggleLidSleep() async {
    if (lidSleepBusy || lidSleepAvailable != true) return;
    lidSleepBusy = true;
    final wanted = !lidSleepOn;
    lidSleepOn = wanted;
    _notify();
    try {
      final status = await service.setMacLidSleep(wanted);
      lidSleepAvailable = status.available;
      lidSleepOn = status.enabled;
      say(status.enabled ? '已开启关盖保持运行' : '已恢复关盖睡眠');
    } catch (error) {
      lidSleepOn = !wanted;
      say('关盖运行设置失败：$error', tone: 'err');
    } finally {
      lidSleepBusy = false;
      _notify();
    }
  }

  Future<AirRestartResult?> restart() async {
    try {
      final result = await service.restart();
      say(
        result.ok
            ? (result.activeStreaming > 0
                  ? '⚠️ 有 ${result.activeStreaming} 个会话正在输出，将先尝试保存其在途内容，再重启'
                  : '重启请求已发送，服务即将重启…')
            : '重启失败：${result.error.isEmpty ? 'HTTP' : result.error}',
        tone: result.ok ? 'warn' : 'err',
      );
      return result;
    } catch (error) {
      say('重启请求失败：$error', tone: 'err');
      return null;
    }
  }

  /// 「推送通知」在原生侧不是浏览器订阅，而是本机的通知通道（Bark / Webhook）。
  /// 这里只报告它开着没有，开关本身在设置中心。
  bool get pushEnabled => settings.notificationsEnabled;

  /// 退出登录：忘掉主机和令牌，连历史记录一起。
  ///
  /// 只清当前那一份是不够的——服务历史里同样存着令牌，列表里点一下就又进去了，
  /// 等于没退。主机上的东西一律不动，忘的只是这台设备。
  Future<void> logout() async {
    await settings.save(host: '', token: '');
    await settings.clearServerHistory();
  }
}
