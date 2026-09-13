import 'package:flutter/foundation.dart';

/// 一条调试日志。行格式逐字对齐 Web 的 `dbg(cat, text)`
/// （public/chat.js:453）——`HH:MM:SS.mmm [cat] text`。两端格式一致，出问题时
/// 才能把手机上的日志和浏览器里的日志并排读。
@immutable
class ChatDebugEntry {
  const ChatDebugEntry({
    required this.time,
    required this.cat,
    required this.text,
  });

  /// `HH:MM:SS.mmm`（本地时间，web 的 `_dbgTime()`）。
  final String time;
  final String cat;
  final String text;

  String get line => '$time [$cat] $text';
}

/// 内存里的调试日志环形缓冲 —— Web `chat.js` 的 `_dbgEntries` + `_DBG_MAX`。
///
/// 上限 600 条，超了就丢最旧的：这是个「出问题时已经开着面板」的取证工具，
/// 不是持久日志，没必要落盘，也不该无界增长把 App 撑爆。
class ChatDebugLog extends ChangeNotifier {
  /// 全局单例：写日志的点散在 ChatService / ChatProvider 深处，逐层传一个
  /// log 对象只会让构造函数越来越长。测试里可以整个换掉（见 [reset]）。
  static ChatDebugLog instance = ChatDebugLog();

  /// Web 的 `_DBG_MAX`。
  static const int maxEntries = 600;

  final List<ChatDebugEntry> _entries = [];

  List<ChatDebugEntry> get entries => List.unmodifiable(_entries);
  bool get isEmpty => _entries.isEmpty;
  int get length => _entries.length;

  /// 记一条。分类沿用 Web 真实用到的那些：ws / history / chat / model / state。
  void record(String cat, String text) {
    _entries.add(
      ChatDebugEntry(time: _stamp(DateTime.now()), cat: cat, text: text),
    );
    while (_entries.length > maxEntries) {
      _entries.removeAt(0);
    }
    notifyListeners();
  }

  /// Web 的 Clear：清空之后**自己再记一条**，否则面板会变成一片空白，
  /// 看起来像是坏了。
  void clear() {
    _entries.clear();
    notifyListeners();
    record('state', 'debug log cleared');
  }

  /// Copy 按钮拷的整段文本（web 的 `_dbgEntries.join('\n')`）。
  String dump() => _entries.map((e) => e.line).join('\n');

  /// 测试用：换一个干净的单例，免得用例之间互相看到对方的日志。
  static void reset() => instance = ChatDebugLog();

  static String _stamp(DateTime d) {
    String p(int n, [int len = 2]) => n.toString().padLeft(len, '0');
    return '${p(d.hour)}:${p(d.minute)}:${p(d.second)}.'
        '${p(d.millisecond, 3)}';
  }
}

/// 便捷入口，省得每个调用点都写 `ChatDebugLog.instance.record`。
void dbg(String cat, String text) => ChatDebugLog.instance.record(cat, text);
