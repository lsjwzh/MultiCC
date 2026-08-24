/// Client-side high-water gate for provider-attempt-owned chat frames.
///
/// The gate is deliberately inert for legacy servers. A server opts into the
/// strict contract only through its authoritative `system/init` frame with
/// `providerRouteProtocolVersion: 1`. From that point, an explicit
/// `provider_route_event` (or the reconnect init's `providerRoute` snapshot)
/// is the sole authority allowed to establish or advance the active attempt.
class ProviderRouteGate {
  static const _attemptOwnedTypes = <String>{
    'part_delta',
    'stream_event',
    'assistant',
    'user',
    'result',
    'api_error_policy',
    'error',
    'provider_token_stats',
    'rate_limit_event',
  };
  static const _terminalPhases = <String>{
    'failed',
    'succeeded',
    'released',
    'cancelled',
  };

  bool _strict = false;
  _ProviderRouteIdentity? _active;
  bool _terminal = false;

  bool get strict => _strict;

  Map<String, dynamic>? get active {
    final value = _active;
    return value == null ? null : Map.unmodifiable(value.toJson());
  }

  /// Starts a fresh physical WebSocket generation. Capability and route state
  /// must be re-established by that connection's own authoritative init, so a
  /// restarted legacy server remains compatible and an old socket cannot lend
  /// authority to the new one.
  void resetConnection() {
    _strict = false;
    _active = null;
    _terminal = false;
  }

  /// Returns whether [message] may enter ChatService's state/render pipeline.
  bool accept(Map<String, dynamic> message) {
    final type = message['type'];
    if (type is! String) return true;

    if (_isAuthoritativeInit(message)) {
      if (message['providerRouteProtocolVersion'] == 1) {
        _strict = true;
        final source = _initRouteSource(message);
        _active = source == null ? null : _ProviderRouteIdentity.from(source);
        _terminal = _active != null && source != null && _isTerminal(source);
      }
      return true;
    }

    if (!_strict) return true;
    if (type == 'provider_route_event') return _acceptRouteEvent(message);
    if (!_attemptOwnedTypes.contains(type)) return true;
    final scope = message['providerRouteScope'];
    if (scope == 'host') return type != 'part_delta' && type != 'stream_event';
    if (scope != 'attempt') return false;

    final candidate = _ProviderRouteIdentity.from(message);
    return !_terminal && candidate != null && candidate == _active;
  }

  bool _acceptRouteEvent(Map<String, dynamic> message) {
    if (message['version'] != 1) return false;
    final next = _ProviderRouteIdentity.from(message);
    if (next == null) return false;
    final current = _active;
    if (current != null) {
      if (next.runtimeEpoch != current.runtimeEpoch) return false;
      if (next.routeGeneration < current.routeGeneration) return false;
      if (next.routeGeneration == current.routeGeneration && next != current) {
        return false;
      }
      if (next.routeGeneration == current.routeGeneration &&
          _terminal &&
          !_isTerminal(message)) {
        return false;
      }
    }
    if (current == null || next.routeGeneration > current.routeGeneration) {
      _active = next;
      _terminal = false;
    }
    if (_isTerminal(message)) _terminal = true;
    return true;
  }

  static bool _isAuthoritativeInit(Map<String, dynamic> message) =>
      message['type'] == 'system' &&
      message['subtype'] == 'init' &&
      message.containsKey('is_streaming');

  static Map<dynamic, dynamic>? _initRouteSource(Map<String, dynamic> message) {
    final providerRoute = message['providerRoute'];
    if (providerRoute is Map) return providerRoute;
    final activeProviderRoute = message['activeProviderRoute'];
    if (activeProviderRoute is Map) return activeProviderRoute;
    return _ProviderRouteIdentity.from(message) == null ? null : message;
  }

  static bool _isTerminal(Map<dynamic, dynamic> source) {
    final phase = source['phase']?.toString().toLowerCase();
    final outcome = source['outcome']?.toString().toLowerCase();
    return _terminalPhases.contains(phase) || _terminalPhases.contains(outcome);
  }
}

class _ProviderRouteIdentity {
  const _ProviderRouteIdentity({
    required this.providerRouteScope,
    required this.runtimeEpoch,
    required this.turnId,
    required this.decisionId,
    required this.routeAttemptId,
    required this.routeGeneration,
    required this.attemptNo,
    required this.providerId,
    required this.providerRevision,
  });

  final String providerRouteScope;
  final String runtimeEpoch;
  final String turnId;
  final String decisionId;
  final String routeAttemptId;
  final int routeGeneration;
  final int attemptNo;
  final String providerId;
  final String providerRevision;

  static final _invalidText = RegExp(r'[\u0000-\u001f\u007f]');

  static _ProviderRouteIdentity? from(Map<dynamic, dynamic> source) {
    String field(String name) {
      final value = source[name];
      if (value is! String) return '';
      final text = value.trim();
      if (text.isEmpty || text.length > 256 || _invalidText.hasMatch(text)) {
        return '';
      }
      return text;
    }

    final providerRouteScope = field('providerRouteScope');
    final runtimeEpoch = field('runtimeEpoch');
    final turnId = field('turnId');
    final decisionId = field('decisionId');
    final routeAttemptId = field('routeAttemptId');
    final providerId = field('providerId');
    final providerRevision = field('providerRevision');
    final routeGeneration = source['routeGeneration'];
    final attemptNo = source['attemptNo'];
    if (providerRouteScope != 'attempt' ||
        runtimeEpoch.isEmpty ||
        turnId.isEmpty ||
        decisionId.isEmpty ||
        routeAttemptId.isEmpty ||
        providerId.isEmpty ||
        providerRevision.isEmpty ||
        routeGeneration is! int ||
        routeGeneration < 1 ||
        attemptNo is! int ||
        attemptNo < 1) {
      return null;
    }
    return _ProviderRouteIdentity(
      providerRouteScope: providerRouteScope,
      runtimeEpoch: runtimeEpoch,
      turnId: turnId,
      decisionId: decisionId,
      routeAttemptId: routeAttemptId,
      routeGeneration: routeGeneration,
      attemptNo: attemptNo,
      providerId: providerId,
      providerRevision: providerRevision,
    );
  }

  Map<String, dynamic> toJson() => {
    'providerRouteScope': providerRouteScope,
    'runtimeEpoch': runtimeEpoch,
    'turnId': turnId,
    'decisionId': decisionId,
    'routeAttemptId': routeAttemptId,
    'routeGeneration': routeGeneration,
    'attemptNo': attemptNo,
    'providerId': providerId,
    'providerRevision': providerRevision,
  };

  @override
  bool operator ==(Object other) =>
      other is _ProviderRouteIdentity &&
      providerRouteScope == other.providerRouteScope &&
      runtimeEpoch == other.runtimeEpoch &&
      turnId == other.turnId &&
      decisionId == other.decisionId &&
      routeAttemptId == other.routeAttemptId &&
      routeGeneration == other.routeGeneration &&
      attemptNo == other.attemptNo &&
      providerId == other.providerId &&
      providerRevision == other.providerRevision;

  @override
  int get hashCode => Object.hash(
    providerRouteScope,
    runtimeEpoch,
    turnId,
    decisionId,
    routeAttemptId,
    routeGeneration,
    attemptNo,
    providerId,
    providerRevision,
  );
}
