import 'message.dart';

/// How full the context is, and how sure we are about it.
///
/// This mirrors public/chat-usage-readout.js so web and app answer the question
/// the same way. Two sources, in order of trust:
///
///  · A single request's own report (`message_start`). Its prompt side is, by
///    definition, everything that sat in the window for that call, so it is a
///    measurement.
///  · The turn total. A turn makes several API requests and the CLI sums them,
///    which counts the cached prefix once per request — a turn whose total lands
///    past the window is provably an aggregate, and dropping the cache buckets
///    leaves an upper bound, not a measurement. Labelled as an estimate.
class ContextReadout {
  final int tokens;
  final int window;

  /// True when [tokens] came from one request rather than the aggregate rule.
  final bool exact;

  /// False when even the de-duplicated buckets exceed the window; there is
  /// nothing left that can honestly become a percentage.
  final bool usable;

  const ContextReadout({
    this.tokens = 0,
    this.window = 0,
    this.exact = true,
    this.usable = false,
  });

  bool get isEmpty => tokens <= 0;
  bool get hasMeter => usable && window > 0 && tokens > 0;
  double get fraction =>
      hasMeter ? (tokens / window).clamp(0.0, 1.0).toDouble() : 0.0;
  double get percent => fraction * 100;

  static int _resident(MessageUsage? usage) => usage == null
      ? 0
      : usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;

  static ContextReadout of({
    MessageUsage? request,
    MessageUsage? turn,
    int window = 0,
  }) {
    final exact = _resident(request);
    if (exact > 0) {
      return ContextReadout(
        tokens: exact,
        window: window,
        exact: true,
        usable: true,
      );
    }
    if (turn == null || turn.total <= 0) {
      return ContextReadout(window: window);
    }
    final billed = _resident(turn) + turn.outputTokens;
    if (window <= 0 || billed <= window) {
      return ContextReadout(
        tokens: billed,
        window: window,
        exact: true,
        usable: true,
      );
    }
    final deduped = turn.inputTokens + turn.outputTokens;
    return ContextReadout(
      tokens: deduped,
      window: window,
      exact: false,
      usable: deduped <= window,
    );
  }
}

String formatCompactTokens(int value) {
  final n = value > 0 ? value : 0;
  if (n >= 1000000) {
    return '${(n / 1000000).toStringAsFixed(1).replaceAll(RegExp(r'\.0$'), '')}M';
  }
  if (n >= 1000) {
    return '${(n / 1000).toStringAsFixed(1).replaceAll(RegExp(r'\.0$'), '')}K';
  }
  return '$n';
}
