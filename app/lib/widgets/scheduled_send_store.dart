import 'dart:async';

import 'package:flutter/widgets.dart';

import '../i18n.dart';
import '../services/scheduled_send_service.dart';

/// 定时发送的状态宿主（Web `chat-scheduled-send.js` 的 `install()` 里那一摊）。
///
/// 它管三件事：待执行列表、面板上那行状态、以及 1 秒一次的节拍 —— 节拍既要
/// 让「N 分钟后」自己往下掉，也要每 15 秒回服务端对一次表（Web 是
/// `++ticks % 15 === 0`）。草稿本身不在这儿：输入框归 [InputBar]，它调
/// [submit] 时把文本和附件路径递进来，成功了再由它自己清空。
class ScheduledSendStore extends ChangeNotifier {
  ScheduledSendStore({
    required this.service,
    required this.sessionId,
    String Function()? makeId,
    DateTime Function()? clock,
    Duration tick = const Duration(seconds: 1),
    this.refreshEveryTicks = 15,
  }) : _makeId = makeId ?? scheduledClientId,
       _clock = clock ?? DateTime.now,
       _tick = tick;

  final ScheduledSendService service;
  final String sessionId;

  final String Function() _makeId;
  final DateTime Function() _clock;
  final Duration _tick;

  /// 每多少次节拍回服务端对一次表（0 = 只走本地倒计时）。对齐 Web 的 15 秒。
  final int refreshEveryTicks;

  Timer? _timer;
  AppLifecycleListener? _lifecycle;
  int _ticks = 0;
  int _nowMs = 0;
  bool _disposed = false;

  List<ScheduledMessage> _items = const [];
  String _status = '';
  bool _statusIsError = false;
  bool _submitting = false;
  final Set<String> _cancelling = <String>{};

  // 幂等键按「文本 + 延迟」指纹复用：同一份草稿连点两次是同一个键，服务端
  // 认出来会回 duplicate 而不是落第二条。
  String? _pendingFingerprint;
  String? _pendingId;

  List<ScheduledMessage> get items => _items;

  /// 输入栏那个小角标上的字。99 条以上不再数了，数了也放不下。
  String get badgeText => _items.length > 99 ? '99+' : '${_items.length}';

  bool get hasItems => _items.isNotEmpty;

  /// 面板上那行状态（空串 = 不显示）。[statusIsError] 决定颜色。
  String get status => _status;
  bool get statusIsError => _statusIsError;

  bool get submitting => _submitting;
  bool isCancelling(String id) => _cancelling.contains(id);

  /// 最近一次节拍的时刻。倒计时按它算，所以每秒都会变。
  int get nowMs => _nowMs;

  /// 起节拍并订阅回前台。重复调用无害。
  void start() {
    if (_timer != null) return;
    _nowMs = _clock().millisecondsSinceEpoch;
    _lifecycle ??= AppLifecycleListener(
      // 回到前台先对一次表：定时消息可能在后台这段时间已经投递掉了。
      onResume: () => unawaited(refresh(showError: false)),
    );
    _timer = Timer.periodic(_tick, (_) => _beat());
    unawaited(refresh(showError: false));
  }

  void _beat() {
    if (_disposed) return;
    _nowMs = _clock().millisecondsSinceEpoch;
    _ticks++;
    if (refreshEveryTicks > 0 && _ticks % refreshEveryTicks == 0) {
      unawaited(refresh(showError: false));
    }
    notifyListeners();
  }

  void _setStatus(String message, {bool error = false}) {
    _status = message;
    _statusIsError = error;
  }

  /// 回服务端拉一次列表。[showError] 为 false 时静默失败 —— 后台轮询和回前台
  /// 那两次不该往面板上贴红字，用户没在看着它。
  Future<void> refresh({bool showError = true}) async {
    try {
      final list = await service.list(sessionId);
      if (_disposed) return;
      _items = list;
      _nowMs = _clock().millisecondsSinceEpoch;
      notifyListeners();
    } catch (error) {
      if (_disposed) return;
      if (showError) {
        _setStatus(t('scheduleFetchFailed', {'error': '$error'}), error: true);
        notifyListeners();
      }
    }
  }

  /// 把输入框里的草稿排上队。
  ///
  /// 校验顺序照抄 Web：先看时间合不合法，再看有没有正文 —— 时间填错时不该先
  /// 抱怨「请先填写消息」。空白草稿即使带了附件也算空（附件的路径是拼在正文
  /// 后面发出去的，没有正文就无从投递）。
  Future<bool> submit({
    required String amount,
    required String unit,
    required String typedText,
    List<String> attachmentPaths = const [],
    String Function(String text)? decorate,
  }) async {
    if (_submitting) return false;
    final delaySeconds = parseScheduleDelaySeconds(amount, unit);
    if (delaySeconds == null) {
      _setStatus(t('scheduleInvalidDelay'), error: true);
      notifyListeners();
      return false;
    }
    final typed = typedText.trim();
    if (typed.isEmpty) {
      _setStatus(t('scheduleMessageRequired'), error: true);
      notifyListeners();
      return false;
    }
    var text = typed;
    if (attachmentPaths.isNotEmpty) text = '$text ${attachmentPaths.join(' ')}';
    final decorated = decorate?.call(text);
    if (decorated != null && decorated.trim().isNotEmpty) text = decorated.trim();

    // NUL 分隔，跟 Web 的 `message.text + '\0' + delaySeconds` 同一份指纹 ——
    // 用空格分隔的话「正文以数字结尾」和另一种延迟会撞成同一条。
    final fingerprint = '$text\u0000$delaySeconds';
    if (_pendingFingerprint != fingerprint) {
      _pendingFingerprint = fingerprint;
      _pendingId = _makeId();
    }

    _submitting = true;
    _setStatus('');
    notifyListeners();
    try {
      final created = await service.create(
        sessionId: sessionId,
        message: text,
        delaySeconds: delaySeconds,
        clientScheduleId: _pendingId!,
      );
      if (_disposed) return false;
      _pendingFingerprint = null;
      _pendingId = null;
      _setStatus(
        t('scheduleCreated', {'time': formatScheduleDueAt(created.dueAt)}),
      );
      await refresh(showError: false);
      return true;
    } catch (error) {
      if (_disposed) return false;
      final code = error is ScheduledSendException ? error.code : '';
      final key = switch (code) {
        'message_required' => 'scheduleMessageRequired',
        'invalid_delay' => 'scheduleInvalidDelay',
        _ => 'scheduleCreateFailed',
      };
      _setStatus(t(key, {'error': '$error'}), error: true);
      return false;
    } finally {
      if (!_disposed) {
        _submitting = false;
        notifyListeners();
      }
    }
  }

  /// 撤掉一条。失败不动列表 —— 服务端说撤不掉，本地装作撤掉了只会更乱。
  Future<void> cancel(ScheduledMessage item) async {
    if (_cancelling.contains(item.id)) return;
    _cancelling.add(item.id);
    _setStatus('');
    notifyListeners();
    try {
      await service.cancel(sessionId: sessionId, messageId: item.id);
      if (_disposed) return;
      _items = [
        for (final entry in _items)
          if (entry.id != item.id) entry,
      ];
    } catch (error) {
      if (_disposed) return;
      _setStatus(t('scheduleCancelFailed', {'error': '$error'}), error: true);
    } finally {
      if (!_disposed) {
        _cancelling.remove(item.id);
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    _lifecycle?.dispose();
    _lifecycle = null;
    super.dispose();
  }
}
