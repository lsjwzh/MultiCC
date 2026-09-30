import 'dart:async';
import 'package:flutter/foundation.dart';
import '../../services/air_service.dart';

/// Debounced search with stale-response fencing across query and directory changes.
class AirDirectorySearch extends ChangeNotifier {
  AirDirectorySearch(this.service, {this.crossDirectory = false});

  final AirService service;

  /// 跨目录检索。目录首页那一份搜索永远带着自己的目录（它搜的就是眼下这一页），
  /// 控制台那一份则跨全部目录（Web 那边同一处不传 dirId）。两条路的差别只在这一
  /// 个开关上，其余（防抖、作废、退路）一模一样。
  final bool crossDirectory;
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
    if (text.isEmpty || (!crossDirectory && dirId == null)) return;
    loading = true;
    final epoch = _epoch;
    _timer = Timer(const Duration(milliseconds: 180), () async {
      try {
        final result = await service.searchTaskIds(
          text,
          dirId: crossDirectory ? null : dirId,
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
