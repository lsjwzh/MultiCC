import 'dart:async';
import 'package:flutter/foundation.dart';
import '../../services/air_service.dart';

/// Debounced search with stale-response fencing across query and directory changes.
class AirDirectorySearch extends ChangeNotifier {
  AirDirectorySearch(this.service);
  final AirService service;
  Timer? _timer;
  int _epoch = 0;
  List<String>? ids;
  bool loading = false;
  bool failed = false;

  void reset() {
    _timer?.cancel();
    _epoch++;
    ids = null;
    loading = false;
    failed = false;
  }

  void search(String query, String? dirId, bool fullText) {
    reset();
    final text = query.trim();
    if (text.isEmpty || dirId == null) return;
    loading = true;
    final epoch = _epoch;
    _timer = Timer(const Duration(milliseconds: 180), () async {
      try {
        final result = await service.searchTaskIds(
          text,
          dirId: dirId,
          fullText: fullText,
        );
        if (epoch != _epoch) return;
        ids = result;
      } catch (_) {
        if (epoch != _epoch) return;
        failed = true;
      }
      loading = false;
      notifyListeners();
    });
  }

  @override
  void dispose() {
    reset();
    super.dispose();
  }
}
