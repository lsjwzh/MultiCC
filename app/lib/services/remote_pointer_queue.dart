import 'dart:async';

/// Serial HTTP fallback for RFB-style pointer samples. Keep button transitions
/// and coalesce only motion, so slow requests never replay an old drag later.
class RemotePointerQueue {
  RemotePointerQueue(this.send, {String? viewer})
    : viewer =
          viewer ?? DateTime.now().microsecondsSinceEpoch.toRadixString(36);

  final Future<Map<String, dynamic>> Function(Map<String, dynamic>) send;
  final String viewer;
  final List<_Sample> _pending = [];
  Future<void>? _running;
  int _mask = 0;
  bool _legacy = false;
  _Sample? _legacyDown;

  static bool unsupported(Map<String, dynamic> reply) {
    final error = '${reply['error'] ?? ''}';
    return error == 'unsupported' ||
        error.startsWith('unknown op') ||
        error.startsWith('op not allowed');
  }

  void add(int mask, int x, int y) {
    final edge = mask != _mask;
    _mask = mask;
    final sample = _Sample(mask, x, y, edge);
    if (!edge && _pending.isNotEmpty && !_pending.last.edge) {
      _pending[_pending.length - 1] = sample;
    } else {
      _pending.add(sample);
    }
    _running ??= _drain().whenComplete(() => _running = null);
  }

  Future<void> get drained => _running ?? Future<void>.value();

  Future<void> _drain() async {
    while (_pending.isNotEmpty) {
      final sample = _pending.removeAt(0);
      if (_legacy) {
        await _sendLegacy(sample);
        continue;
      }
      final reply = await send({
        'op': 'pointer',
        'viewer': viewer,
        'mask': sample.mask,
        'x': sample.x,
        'y': sample.y,
      });
      if (unsupported(reply)) {
        _legacy = true;
        await _sendLegacy(sample);
      }
    }
  }

  // Older Agents and non-RFB platforms retain their previous click/drag API.
  Future<void> _sendLegacy(_Sample sample) async {
    if (sample.mask == 1) {
      _legacyDown ??= sample;
      return;
    }
    final down = _legacyDown;
    _legacyDown = null;
    if (down == null) return;
    final dx = sample.x - down.x, dy = sample.y - down.y;
    final drag = dx * dx + dy * dy > 64;
    await send({
      'op': drag ? 'drag' : 'click',
      'x': down.x,
      'y': down.y,
      if (drag) ...{'x2': sample.x, 'y2': sample.y, 'ms': 350},
    });
  }
}

class _Sample {
  const _Sample(this.mask, this.x, this.y, this.edge);
  final int mask, x, y;
  final bool edge;
}
