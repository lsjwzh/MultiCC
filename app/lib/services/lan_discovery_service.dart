import 'dart:async';
import 'dart:io';

import 'package:nsd/nsd.dart' as nsd;

import '../models/discovered_server.dart';

const multiccServiceType = '_multicc._tcp';
const defaultLanDiscoveryDuration = Duration(seconds: 7);

enum LanDiscoveryFailure { permissionDenied, unsupported, other }

class LanDiscoveryException implements Exception {
  final LanDiscoveryFailure failure;
  final String details;

  const LanDiscoveryException(this.failure, [this.details = '']);

  @override
  String toString() => details.isEmpty ? failure.name : details;
}

abstract interface class LanDiscoveryService {
  /// Searches for MultiCC DNS-SD records for a bounded amount of time.
  Future<List<DiscoveredServer>> scan({
    Duration timeout = defaultLanDiscoveryDuration,
  });

  /// Stops an in-flight native discovery, if any.
  Future<void> stop();
}

typedef NsdDiscoveryStarter =
    Future<nsd.Discovery> Function(
      String serviceType, {
      bool autoResolve,
      nsd.IpLookupType ipLookupType,
    });
typedef NsdDiscoveryStopper = Future<void> Function(nsd.Discovery discovery);

/// Bonjour/NsdManager-backed discovery with a strict start/stop lifecycle.
class NsdLanDiscoveryService implements LanDiscoveryService {
  final NsdDiscoveryStarter _startDiscovery;
  final NsdDiscoveryStopper _stopDiscovery;

  nsd.Discovery? _activeDiscovery;
  Completer<void>? _activeCancellation;
  int _operationGeneration = 0;

  NsdLanDiscoveryService({
    NsdDiscoveryStarter? startDiscovery,
    NsdDiscoveryStopper? stopDiscovery,
  }) : _startDiscovery = startDiscovery ?? nsd.startDiscovery,
       _stopDiscovery = stopDiscovery ?? nsd.stopDiscovery;

  @override
  Future<List<DiscoveredServer>> scan({
    Duration timeout = defaultLanDiscoveryDuration,
  }) async {
    // A service instance owns at most one native discovery/multicast lock.
    await stop();
    final operation = ++_operationGeneration;

    nsd.Discovery? discovery;
    try {
      discovery = await _startDiscovery(
        multiccServiceType,
        autoResolve: true,
        ipLookupType: nsd.IpLookupType.any,
      );
      if (operation != _operationGeneration) {
        await _safeStop(discovery);
        return const [];
      }
      _activeDiscovery = discovery;
      final cancellation = Completer<void>();
      _activeCancellation = cancellation;
      await Future.any<void>([
        Future<void>.delayed(timeout),
        cancellation.future,
      ]);
      return _toDiscoveredServers(discovery.services);
    } on nsd.NsdError catch (error) {
      throw LanDiscoveryException(_failureFor(error), error.message);
    } on LanDiscoveryException {
      rethrow;
    } catch (error) {
      throw LanDiscoveryException(LanDiscoveryFailure.other, '$error');
    } finally {
      if (discovery != null && identical(_activeDiscovery, discovery)) {
        _activeDiscovery = null;
        _activeCancellation = null;
        await _safeStop(discovery);
      }
    }
  }

  @override
  Future<void> stop() async {
    _operationGeneration++;
    final cancellation = _activeCancellation;
    _activeCancellation = null;
    if (cancellation != null && !cancellation.isCompleted) {
      cancellation.complete();
    }
    final discovery = _activeDiscovery;
    if (discovery == null) return;
    _activeDiscovery = null;
    await _safeStop(discovery);
  }

  Future<void> _safeStop(nsd.Discovery discovery) async {
    try {
      await _stopDiscovery(discovery);
    } catch (_) {
      // stop() is also called unawaited from widget disposal. It is idempotent
      // from the Dart side and cleanup errors must not replace scan results or
      // become uncaught futures.
    }
  }

  static LanDiscoveryFailure _failureFor(nsd.NsdError error) {
    switch (error.cause) {
      case nsd.ErrorCause.securityIssue:
        return LanDiscoveryFailure.permissionDenied;
      case nsd.ErrorCause.operationNotSupported:
        return LanDiscoveryFailure.unsupported;
      default:
        final normalized = error.message.toLowerCase();
        if (normalized.contains('permission') ||
            normalized.contains('denied') ||
            normalized.contains('security')) {
          return LanDiscoveryFailure.permissionDenied;
        }
        return LanDiscoveryFailure.other;
    }
  }

  static List<DiscoveredServer> _toDiscoveredServers(
    Iterable<nsd.Service> services,
  ) {
    final endpoints = <String, DiscoveredServer>{};

    for (final service in services) {
      final port = service.port;
      if (port == null || port < 1 || port > 65535) continue;

      final addresses = <InternetAddress>[
        ...?service.addresses,
        if (service.addresses?.isEmpty ?? true)
          if (InternetAddress.tryParse(service.host ?? '') case final address?)
            address,
      ]..removeWhere((address) => !_isUsableLanAddress(address));
      addresses.sort((a, b) {
        final rankOrder = _addressRank(a).compareTo(_addressRank(b));
        return rankOrder != 0 ? rankOrder : a.address.compareTo(b.address);
      });
      if (addresses.isEmpty) continue;

      // A service can resolve to Wi-Fi, Tailscale and IPv6 addresses at once.
      // Show one deterministic LAN-first choice instead of making one server
      // look like several different instances.
      final address = addresses.first;
      final server = DiscoveredServer(
        name: _displayName(service, address.address),
        address: address.address,
        port: port,
      );
      endpoints.putIfAbsent(server.endpointKey, () => server);
    }

    final result = endpoints.values.toList(growable: false)
      ..sort((a, b) {
        final nameOrder = a.name.toLowerCase().compareTo(b.name.toLowerCase());
        return nameOrder != 0
            ? nameOrder
            : a.endpointLabel.compareTo(b.endpointLabel);
      });
    return List.unmodifiable(result);
  }

  static String _displayName(nsd.Service service, String address) {
    final name = service.name?.trim();
    if (name != null && name.isNotEmpty) return name;
    final host = service.host?.trim().replaceFirst(RegExp(r'\.$'), '');
    if (host != null && host.isNotEmpty) return host;
    return address;
  }

  static bool _isUsableLanAddress(InternetAddress address) {
    if (address.isLoopback || address.address.isEmpty) return false;
    final bytes = address.rawAddress;
    if (address.type == InternetAddressType.IPv4) {
      if (bytes.length != 4) return false;
      final unspecified = bytes.every((byte) => byte == 0);
      final multicast = bytes[0] >= 224;
      final linkLocal = bytes[0] == 169 && bytes[1] == 254;
      return !unspecified && !multicast && !linkLocal;
    }
    if (bytes.length != 16) return false;
    final unspecified = bytes.every((byte) => byte == 0);
    final multicast = bytes[0] == 0xff;
    final linkLocal = bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80;
    return !unspecified && !multicast && !linkLocal;
  }

  static int _addressRank(InternetAddress address) {
    final bytes = address.rawAddress;
    if (address.type == InternetAddressType.IPv4) {
      final isPrivate =
          bytes[0] == 10 ||
          (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
          (bytes[0] == 192 && bytes[1] == 168);
      return isPrivate ? 0 : 1;
    }
    final isUniqueLocal = (bytes[0] & 0xfe) == 0xfc;
    return isUniqueLocal ? 2 : 3;
  }
}
