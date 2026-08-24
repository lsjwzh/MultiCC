import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/provider_route_gate.dart';

void main() {
  Map<String, dynamic> init({Map<String, dynamic>? active}) => {
    'type': 'system',
    'subtype': 'init',
    'is_streaming': false,
    'providerRouteProtocolVersion': 1,
    if (active != null) 'providerRoute': active,
  };

  Map<String, dynamic> route(
    int generation,
    String attemptId, {
    String providerId = 'provider-a',
    String phase = 'selected',
  }) => {
    'type': 'provider_route_event',
    'version': 1,
    'phase': phase,
    'providerRouteScope': 'attempt',
    'runtimeEpoch': 'epoch-1',
    'turnId': 'turn-1',
    'decisionId': 'decision-1',
    'routeAttemptId': attemptId,
    'routeGeneration': generation,
    'attemptNo': generation,
    'providerId': providerId,
    'providerRevision': 'revision-$providerId',
  };

  Map<String, dynamic> frame(
    int generation,
    String attemptId, {
    String providerId = 'provider-a',
    String type = 'part_delta',
  }) => {
    'type': type,
    'providerRouteScope': 'attempt',
    'runtimeEpoch': 'epoch-1',
    'turnId': 'turn-1',
    'decisionId': 'decision-1',
    'routeAttemptId': attemptId,
    'routeGeneration': generation,
    'attemptNo': generation,
    'providerId': providerId,
    'providerRevision': 'revision-$providerId',
  };

  test(
    'legacy connection accepts unlabelled frames until init advertises v1',
    () {
      final gate = ProviderRouteGate();
      expect(gate.accept({'type': 'part_delta'}), isTrue);
      expect(gate.strict, isFalse);
      expect(gate.accept(init()), isTrue);
      expect(gate.strict, isTrue);
      expect(gate.accept({'type': 'part_delta'}), isFalse);
    },
  );

  test('strict mode advances only through a valid monotonic route event', () {
    final gate = ProviderRouteGate();
    gate.accept(init());
    expect(gate.accept(route(2, 'attempt-2')), isTrue);
    expect(gate.accept(frame(2, 'attempt-2')), isTrue);
    expect(gate.accept(frame(1, 'attempt-1')), isFalse);
    expect(gate.accept(frame(2, 'attempt-x')), isFalse);
    expect(
      gate.accept({...frame(2, 'attempt-2'), 'runtimeEpoch': 'old'}),
      isFalse,
    );
    expect(gate.accept(route(1, 'attempt-1')), isFalse);
    expect(gate.accept(route(2, 'attempt-x')), isFalse);
    expect(
      gate.accept({...route(3, 'attempt-3'), 'providerRevision': null}),
      isFalse,
      reason: 'route events require the complete attribution tuple',
    );
    expect(
      gate.accept(route(3, 'attempt-3', providerId: 'provider-b')),
      isTrue,
    );
    expect(gate.accept(frame(2, 'attempt-2')), isFalse);
    expect(
      gate.accept(frame(3, 'attempt-3', providerId: 'provider-b')),
      isTrue,
    );
  });

  test(
    'reconnect init seeds the active tuple and terminal closes late frames',
    () {
      final gate = ProviderRouteGate();
      gate.accept(init());
      gate.accept(route(7, 'attempt-7'));
      gate.resetConnection();

      final active = route(7, 'attempt-7')..remove('type');
      expect(gate.accept(init(active: active)), isTrue);
      expect(gate.accept(frame(7, 'attempt-7')), isTrue);
      expect(gate.accept(route(7, 'attempt-7', phase: 'succeeded')), isTrue);
      expect(gate.accept(frame(7, 'attempt-7')), isFalse);
      expect(
        gate.accept(route(7, 'attempt-7')),
        isFalse,
        reason: 'a terminal generation cannot be re-opened',
      );
      expect(gate.accept(route(8, 'attempt-8')), isTrue);
      expect(gate.accept(frame(8, 'attempt-8')), isTrue);
    },
  );

  test(
    'attempt scope is fail-closed while host terminal frames stay compatible',
    () {
      final gate = ProviderRouteGate();
      gate.accept(init());
      for (final type in const ['part_delta', 'stream_event']) {
        expect(
          gate.accept({'type': type, 'providerRouteScope': 'host'}),
          isFalse,
          reason: type,
        );
      }
      for (final type in const [
        'assistant',
        'user',
        'result',
        'api_error_policy',
        'provider_token_stats',
        'rate_limit_event',
      ]) {
        expect(
          gate.accept({'type': type, 'providerRouteScope': 'host'}),
          isTrue,
          reason: 'host $type',
        );
        expect(
          gate.accept({'type': type, 'providerRouteScope': 'attempt'}),
          isFalse,
          reason: 'attempt $type requires a complete tuple',
        );
      }
      expect(
        gate.accept({'type': 'error', 'providerRouteScope': 'attempt'}),
        isFalse,
      );
      expect(
        gate.accept({
          'type': 'error',
          'providerRouteScope': 'host',
          'error': 'host failure',
        }),
        isTrue,
      );
    },
  );
}
