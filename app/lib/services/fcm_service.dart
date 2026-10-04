import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'settings_service.dart';

/// Optional Android push. All work starts after the session UI is constructed;
/// missing plugins, GMS, config and connectivity are ordinary unavailable states.
class FcmService {
  static const channel = MethodChannel('com.multicc.multicc_app/fcm');
  static FcmService? current;
  static bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  final SettingsService settings;
  final void Function(String) onTap;
  final http.Client _client;
  final Future<dynamic> Function(String, Map<String, dynamic>?) _invoke;
  final bool _supported;
  final Duration timeout;
  final status = ValueNotifier<String>('idle');
  Timer? _timer;
  final Set<_GuardedTimeout> _pendingTimeouts = {};
  bool _disposed = false;
  bool _busy = false;
  bool _again = false;
  String _activeSession = '';
  String _binding = '';
  String _host = '';
  String _access = '';
  String _registeredToken = '';
  DateTime? _registeredAt;

  FcmService({
    required this.settings,
    required this.onTap,
    http.Client? client,
    Future<dynamic> Function(String, Map<String, dynamic>?)? invoke,
    bool? isSupported,
    this.timeout = const Duration(seconds: 10),
  }) : _client = client ?? http.Client(),
       _invoke =
           invoke ?? ((method, args) => channel.invokeMethod(method, args)),
       _supported = isSupported ?? supported;

  void start() {
    if (!_supported) return;
    current = this;
    channel.setMethodCallHandler((call) async {
      if (call.method == 'tap') handleTap(call.arguments);
    });
    settings.pushPreferences.addListener(_changed);
    _timer = Timer.periodic(const Duration(minutes: 5), (_) => refresh());
    unawaited(refresh());
  }

  void handleTap(dynamic data) {
    if (!_disposed &&
        data is Map &&
        data['binding'] == settings.pushBinding &&
        data['sessionId'] is String &&
        (data['sessionId'] as String).isNotEmpty) {
      onTap(data['sessionId'] as String);
    }
  }

  void setActiveSession(String? session) {
    if (_activeSession == (session ?? '')) return;
    _activeSession = session ?? '';
    unawaited(_sync());
  }

  Future<void> _sync() async {
    if (!_supported || _disposed) return;
    try {
      await _guard(_invoke('sync', {
        'binding': settings.pushBinding,
        'endpoint': settings.host.isEmpty ? '' : _uri(settings.host).toString(),
        'access': settings.host.isEmpty ? '' : settings.token,
        'deviceId': settings.pushDeviceId,
        'locale': settings.lang,
        'enabled': settings.host.isNotEmpty && settings.notificationsEnabled,
        'disabledSessions': settings.pushDisabledSessions,
        'activeSession': _activeSession,
      }));
    } catch (_) {}
  }

  void _changed() {
    // Sync the local guard immediately, even when registration is awaiting a
    // slow Google request. Old-server messages must stop at the device boundary.
    unawaited(_sync());
    unawaited(refresh());
  }

  void _state(String value) {
    if (!_disposed) status.value = value;
  }

  /// Same contract as `future.timeout(timeout)`, but the timer it schedules is
  /// tracked so [dispose] can cancel it outright instead of leaving it armed
  /// until the (possibly never-settling, e.g. an unmocked platform channel)
  /// original future resolves on its own.
  Future<T> _guard<T>(Future<T> future) {
    final completer = Completer<T>();
    late final _GuardedTimeout entry;
    final timer = Timer(timeout, () {
      _pendingTimeouts.remove(entry);
      if (!completer.isCompleted) {
        completer.completeError(TimeoutException('FcmService timed out', timeout));
      }
    });
    entry = _GuardedTimeout(timer, completer);
    _pendingTimeouts.add(entry);
    future.then(
      (value) {
        if (_pendingTimeouts.remove(entry)) timer.cancel();
        if (!completer.isCompleted) completer.complete(value);
      },
      onError: (Object error, StackTrace stack) {
        if (_pendingTimeouts.remove(entry)) timer.cancel();
        if (!completer.isCompleted) completer.completeError(error, stack);
      },
    );
    return completer.future;
  }

  Map<String, String> _headers(String access) => {
    'Content-Type': 'application/json',
    if (access.isNotEmpty) 'X-Access-Token': access,
  };

  Uri _uri(String host, [String suffix = '']) {
    final base = host.startsWith('http') ? host : 'http://$host';
    return Uri.parse(
      '${base.replaceAll(RegExp(r'/$'), '')}/api/push/fcm$suffix',
    );
  }

  Future<void> _remove(String host, String access, String binding) async {
    if (host.isEmpty || binding.isEmpty) return;
    try {
      await _guard(_client
          .delete(
            _uri(host),
            headers: _headers(access),
            body: jsonEncode({'id': settings.pushDeviceId, 'binding': binding}),
          ));
    } catch (_) {}
  }

  Future<void> refresh() async {
    if (!_supported || _disposed) return;
    if (_busy) {
      _again = true;
      return;
    }
    _busy = true;
    try {
      await _sync();
      final binding = settings.pushBinding;
      final host = settings.host;
      final access = settings.token;
      if (_binding != binding || !settings.notificationsEnabled) {
        final oldHost = _host, oldAccess = _access, oldBinding = _binding;
        _registeredToken = '';
        _registeredAt = null;
        _binding = binding;
        _host = host;
        _access = access;
        await _remove(oldHost, oldAccess, oldBinding);
      }
      if (_disposed || binding != settings.pushBinding) return;
      if (host.isEmpty || !settings.notificationsEnabled) {
        _state('disabled');
        return;
      }
      final info = await _guard(_invoke('token', null));
      if (_disposed || binding != settings.pushBinding) return;
      if (info is! Map ||
          info['status'] != 'ready' ||
          info['token'] is! String) {
        _state(
          info is Map && info['status'] is String
              ? info['status'] as String
              : 'unavailable',
        );
        return;
      }
      final token = info['token'] as String;
      if (token == _registeredToken &&
          _registeredAt != null &&
          DateTime.now().difference(_registeredAt!) <
              const Duration(hours: 24)) {
        _state('registered');
        return;
      }
      final response = await _guard(_client
          .post(
            _uri(host),
            headers: _headers(access),
            body: jsonEncode({
              'id': settings.pushDeviceId,
              'binding': binding,
              'token': token,
              'projectId': info['projectId'],
              'locale': settings.lang,
            }),
          ));
      if (_disposed ||
          binding != settings.pushBinding ||
          !settings.notificationsEnabled) {
        await _remove(host, access, binding);
        return;
      }
      if (response.statusCode == 200 &&
          jsonDecode(response.body)['ok'] == true) {
        _registeredToken = token;
        _registeredAt = DateTime.now();
        _state('registered');
      } else {
        _state(
          response.statusCode == 503 ? 'server_not_configured' : 'unavailable',
        );
      }
    } catch (_) {
      _state('unavailable');
    } finally {
      _busy = false;
      if (_again && !_disposed) {
        _again = false;
        unawaited(refresh());
      }
    }
  }

  /// True means Google accepted the test, never a claim of handset delivery.
  Future<bool> test() async {
    try {
      final response = await _guard(_client
          .post(
            _uri(settings.host, '/test'),
            headers: _headers(settings.token),
            body: jsonEncode({'id': settings.pushDeviceId}),
          ));
      return response.statusCode == 200 &&
          jsonDecode(response.body)['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
    for (final entry in _pendingTimeouts) {
      entry.timer.cancel();
      if (!entry.completer.isCompleted) {
        entry.completer.completeError(StateError('FcmService disposed'));
      }
    }
    _pendingTimeouts.clear();
    settings.pushPreferences.removeListener(_changed);
    if (identical(current, this)) {
      current = null;
      channel.setMethodCallHandler(null);
    }
    _client.close();
    status.dispose();
  }
}

/// A [_guard]-scheduled timeout [Timer] paired with the [Completer] it would
/// otherwise fire into, so [FcmService.dispose] can retire both together
/// instead of leaving the timer armed for a future nobody awaits anymore.
class _GuardedTimeout {
  _GuardedTimeout(this.timer, this.completer);
  final Timer timer;
  final Completer<dynamic> completer;
}
