import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'demo_data.dart';

/// App 进程内的迷你 MultiCC 主机，只监听回环地址。
///
/// 演示模式不给 App 的各个 service 写假实现，而是让整个 App 照常连到这里：
/// 连接探测、首页快照、会话列表、聊天 WebSocket 都走和真服务端相同的协议，
/// 所以演示看到的就是真界面。这里只实现主流程用到的接口；其余接口一律回
/// 404，App 对服务端缺接口本来就要能降级。
class DemoServer {
  static const String accessToken = 'demo';

  final HttpServer _server;
  final String Function() _lang;
  final Map<String, List<Map<String, dynamic>>> _history = {};
  final Set<WebSocket> _sockets = {};
  int _seq = 0;

  DemoServer._(this._server, this._lang) {
    _seedHistory();
    _server.listen(_handle, onError: (_) {});
  }

  /// 起在随机端口上；[lang] 每次请求时读取，切换语言后演示内容跟着变。
  static Future<DemoServer> start({required String Function() lang}) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    return DemoServer._(server, lang);
  }

  String get host => 'http://127.0.0.1:${_server.port}';

  Future<void> close() async {
    for (final socket in _sockets.toList()) {
      await socket.close();
    }
    await _server.close(force: true);
  }

  // ── 数据 ─────────────────────────────────────────────────────────────────

  int get _now => DateTime.now().millisecondsSinceEpoch;

  String _nextId() => 'demo-${_now.toRadixString(36)}-${_seq++}';

  void _seedHistory() {
    for (final task in demoTasks) {
      _history[task.sessionId] = [];
    }
  }

  /// 种子记录按当前语言现算，追加的新消息原样保留。
  List<Map<String, dynamic>> _messagesFor(DemoTask task) {
    final lang = _lang();
    final base = _now - task.ageMinutes * 60000;
    final seeded = <Map<String, dynamic>>[];
    var ts = base;
    for (final turn in task.turns) {
      seeded.add({
        'id': '${task.sessionId}-u${seeded.length}',
        'role': 'user',
        'content': pick(turn.user, lang),
        'ts': ts,
        'taskId': task.id,
      });
      ts += 40000;
      seeded.add({
        'id': '${task.sessionId}-a${seeded.length}',
        'role': 'assistant',
        'content': pick(turn.assistant, lang),
        'ts': ts,
        'taskId': task.id,
        if (turn.tools.isNotEmpty)
          'tools': [
            for (var i = 0; i < turn.tools.length; i++)
              {
                'name': turn.tools[i].name,
                'input': turn.tools[i].input,
                'id': '${task.sessionId}-tool$i',
                'result': turn.tools[i].result,
                'is_error': false,
                'startedAt': ts - 30000 + i * 5000,
                'endedAt': ts - 28000 + i * 5000,
              },
          ],
      });
      ts += 20000;
    }
    return [...seeded, ...?_history[task.sessionId]];
  }

  DemoTask? _taskForSession(String? sessionId) {
    for (final task in demoTasks) {
      if (task.sessionId == sessionId) return task;
    }
    return null;
  }

  DemoTask? _taskById(String id) {
    for (final task in demoTasks) {
      if (task.id == id) return task;
    }
    return null;
  }

  int _lastActivity(DemoTask task) {
    final appended = _history[task.sessionId];
    if (appended != null && appended.isNotEmpty) {
      return appended.last['ts'] as int;
    }
    return _now - task.ageMinutes * 60000;
  }

  Map<String, dynamic> _directoryJson() => {
    'id': demoDirId,
    'name': 'weather-app',
    'path': demoDirPath,
    'createdAt': DateTime.now()
        .subtract(const Duration(days: 3))
        .toUtc()
        .toIso8601String(),
    'baseBranch': 'main',
    'gitInitialized': true,
    'counts': {'claude_chat': 2, 'codex_chat': 1},
  };

  Map<String, dynamic> _sessionJson(DemoTask task) => {
    'id': task.sessionId,
    'dirId': demoDirId,
    'cwd': demoDirPath,
    'cli': task.cli,
    'kind': 'chat',
    'type': 'chat',
    'label': pick(task.title, _lang()),
    'model': task.model,
    'effectiveModel': task.model,
    'createdAt': DateTime.fromMillisecondsSinceEpoch(
      _now - task.ageMinutes * 60000 - 60000,
    ).toUtc().toIso8601String(),
    'lastActivity': DateTime.fromMillisecondsSinceEpoch(
      _lastActivity(task),
    ).toUtc().toIso8601String(),
    'active': false,
    'clients': 0,
    'streaming': false,
    'taskBoundTaskId': task.id,
    'autoCommit': true,
  };

  Map<String, dynamic> _airSnapshot() {
    final lang = _lang();
    return {
      'ok': true,
      'directories': [
        {
          'id': demoDirId,
          'name': 'weather-app',
          'path': demoDirPath,
          'worktreeCount': demoTasks.length,
        },
      ],
      'tasks': [
        for (final task in demoTasks)
          {
            'id': task.id,
            'dirId': demoDirId,
            'title': pick(task.title, lang),
            'status': task.status,
            'recordType': 'observed',
            'updatedAt': _lastActivity(task),
            'lastMessageAt': _lastActivity(task),
            'sessionId': task.sessionId,
            'sourceSessionId': task.sessionId,
            'readOnly': false,
            'providerName': task.cli == 'codex' ? 'Codex' : 'Claude Code',
            'runState': task.runState,
            'goalState': null,
            'worktreeChanges': {'dirty': false, 'ahead': 0},
            'attention': null,
          },
      ],
      'taskPins': <String>[],
      'clis': ['claude', 'codex'],
      'sessions': [
        for (final task in demoTasks)
          {
            'id': task.sessionId,
            'dirId': demoDirId,
            'label': pick(task.title, lang),
            'kind': 'chat',
            'cli': task.cli,
            'state': 'idle',
            'lastActivityAt': _lastActivity(task),
            'createdAt': _now - task.ageMinutes * 60000 - 60000,
          },
      ],
    };
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  Future<void> _handle(HttpRequest req) async {
    try {
      final path = req.uri.path;
      if (WebSocketTransformer.isUpgradeRequest(req)) {
        await _upgrade(req);
        return;
      }
      final segments = req.uri.pathSegments;
      final method = req.method;

      if (path == '/api/server-info') {
        return _json(req, {
          'product': 'multicc',
          'appProtocolVersion': 1,
          'version': 'demo',
          'ip': '127.0.0.1',
          'port': _server.port,
          'proto': 'http',
          'url': host,
          'authRequired': true,
          'demo': true,
        });
      }
      if (path == '/readyz' || path == '/healthz') {
        return _json(req, {'ok': true});
      }
      if (path == '/api/auth/ws-ticket' && method == 'POST') {
        final body = await _body(req);
        return _json(req, {
          'ticket': 'demo-ticket-${_seq++}',
          'expiresAt': _now + 60000,
          'path': body['path'],
        });
      }
      if (path == '/api/air' && method == 'GET') {
        return _json(req, _airSnapshot());
      }
      if (segments.length == 5 &&
          segments[0] == 'api' &&
          segments[1] == 'air' &&
          segments[2] == 'tasks' &&
          segments[4] == 'open') {
        final task = _taskById(segments[3]);
        if (task != null) {
          return _json(req, {'ok': true, 'session': _sessionJson(task)});
        }
      }
      if (path == '/api/directories' && method == 'GET') {
        return _json(req, [_directoryJson()]);
      }
      if (path == '/api/sessions' && method == 'GET') {
        return _json(req, [for (final t in demoTasks) _sessionJson(t)]);
      }
      if (segments.length >= 3 &&
          segments[0] == 'api' &&
          segments[1] == 'sessions') {
        final task = _taskForSession(segments[2]);
        if (task != null && segments.length == 3 && method == 'GET') {
          return _json(req, _sessionJson(task));
        }
        if (task != null && segments.length == 4 && segments[3] == 'history') {
          return _json(req, {'messages': _messagesFor(task), 'hasMore': false});
        }
      }
      // 首页和控制台顺手会读的几项：给空但合法的结果，界面就显示「暂无」，
      // 不会冒出加载失败的提示。
      if (method == 'GET') {
        final empty = switch (path) {
          '/api/cron' => <Object>[],
          '/api/external-fleets' => {'fleets': <Object>[]},
          '/api/ui-layout' => {'ok': true, 'layout': <String, Object>{}},
          '/api/version-check' => {
            'current': 'demo',
            'updateAvailable': false,
            'apiError': false,
          },
          '/api/settings/power' => {'available': false, 'enabled': false},
          _ => null,
        };
        if (empty != null) return _json(req, empty);
      }
      if (path == '/api/task-shells' && method == 'POST') {
        // 演示会话不走任务外壳，App 收到这个码就直接连会话本身。
        return _json(req, {'code': 'unsupported_source'});
      }
      return _json(req, {
        'error': 'Not available in demo mode',
        'code': 'demo_mode',
      }, status: HttpStatus.notFound);
    } catch (_) {
      try {
        req.response.statusCode = HttpStatus.internalServerError;
        await req.response.close();
      } catch (_) {}
    }
  }

  Future<Map<String, dynamic>> _body(HttpRequest req) async {
    final raw = await utf8.decodeStream(req);
    if (raw.trim().isEmpty) return {};
    final decoded = jsonDecode(raw);
    return decoded is Map ? decoded.cast<String, dynamic>() : {};
  }

  Future<void> _json(HttpRequest req, Object body, {int status = 200}) async {
    final res = req.response
      ..statusCode = status
      ..headers.contentType = ContentType.json;
    res.add(utf8.encode(jsonEncode(body)));
    await res.close();
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  Future<void> _upgrade(HttpRequest req) async {
    final path = req.uri.path;
    final socket = await WebSocketTransformer.upgrade(req);
    _sockets.add(socket);
    final task = path == '/ws/chat'
        ? _taskForSession(req.uri.queryParameters['session'])
        : null;
    final chat = task == null ? null : _DemoChat(this, socket, task);
    socket.listen(
      (raw) {
        Map<String, dynamic> msg;
        try {
          msg = (jsonDecode(raw as String) as Map).cast<String, dynamic>();
        } catch (_) {
          return;
        }
        if (msg['type'] == 'ping') {
          _send(socket, {'type': 'pong'});
          return;
        }
        chat?.onMessage(msg);
      },
      onDone: () {
        chat?.dispose();
        _sockets.remove(socket);
      },
      onError: (_) {},
    );
    if (path == '/ws/chat') {
      if (task == null) {
        _send(socket, {
          'type': 'chat_history',
          'messages': [],
          'hasMore': false,
        });
      } else {
        _send(socket, {'type': 'session_id', 'sessionId': task.sessionId});
        _send(socket, {
          'type': 'chat_history',
          'messages': _messagesFor(task),
          'hasMore': false,
        });
      }
    }
  }

  void _send(WebSocket socket, Map<String, dynamic> msg) {
    if (socket.readyState != WebSocket.open) return;
    socket.add(jsonEncode(msg));
  }
}

/// 一条聊天 socket 的演示轮次：收到 user_message 就按真服务端的帧顺序流式
/// 吐出内置回复（stream_start → 文本增量 → assistant → result → stream_end）。
class _DemoChat {
  final DemoServer _host;
  final WebSocket _socket;
  final DemoTask _task;
  Timer? _timer;
  void Function()? _finish;

  _DemoChat(this._host, this._socket, this._task);

  void dispose() {
    _timer?.cancel();
    _timer = null;
  }

  void _send(Map<String, dynamic> msg) => _host._send(_socket, msg);

  void onMessage(Map<String, dynamic> msg) {
    switch (msg['type']) {
      case 'user_message':
        _startTurn(msg);
      case 'cancel':
        final finish = _finish;
        _timer?.cancel();
        _timer = null;
        if (finish != null) finish();
    }
  }

  void _startTurn(Map<String, dynamic> msg) {
    if (_timer != null) {
      _send({
        'type': 'error',
        'error': 'Busy',
        'notDelivered': true,
        'clientMsgId': msg['clientMsgId'],
      });
      return;
    }
    final text = (msg['text'] ?? '').toString();
    final history = _host._history[_task.sessionId]!;
    final now = _host._now;
    final userId = _host._nextId();
    history.add({
      'id': userId,
      'role': 'user',
      'content': text,
      'ts': now,
      'clientMsgId': msg['clientMsgId'],
      'taskId': _task.id,
    });
    _send({
      'type': 'chat_msg_meta',
      'id': userId,
      'role': 'user',
      'ts': now,
      'clientMsgId': msg['clientMsgId'],
    });
    _send({'type': 'stream_start'});
    _send({
      'type': 'stream_event',
      'event': {
        'type': 'message_start',
        'message': {
          'id': 'msg_${_host._nextId()}',
          'type': 'message',
          'role': 'assistant',
          'model': _task.model,
          'content': [],
        },
      },
    });
    _send({
      'type': 'stream_event',
      'event': {
        'type': 'content_block_start',
        'index': 0,
        'content_block': {'type': 'text', 'text': ''},
      },
    });

    final reply = demoReply(text, _host._lang());
    final chunks = _chunks(reply);
    var sent = 0;
    final buffer = StringBuffer();

    void finish() {
      _finish = null;
      _timer = null;
      final content = buffer.toString();
      _send({
        'type': 'stream_event',
        'event': {'type': 'content_block_stop', 'index': 0},
      });
      _send({
        'type': 'assistant',
        'message': {
          'type': 'message',
          'role': 'assistant',
          'model': _task.model,
          'content': [
            {'type': 'text', 'text': content},
          ],
        },
      });
      _send({
        'type': 'stream_event',
        'event': {
          'type': 'message_delta',
          'delta': {'stop_reason': 'end_turn'},
        },
      });
      _send({
        'type': 'stream_event',
        'event': {'type': 'message_stop'},
      });
      final ts = _host._now;
      final id = _host._nextId();
      history.add({
        'id': id,
        'role': 'assistant',
        'content': content,
        'ts': ts,
        'taskId': _task.id,
      });
      _send({'type': 'chat_msg_meta', 'id': id, 'role': 'assistant', 'ts': ts});
      _send({'type': 'result'});
      _send({
        'type': 'notify',
        'state': 'succeeded',
        'classifyState': 'D',
        'message': _host._lang() == 'zh' ? '演示回复已完成' : 'Demo reply finished',
      });
      _send({'type': 'stream_end'});
    }

    _finish = finish;
    _timer = Timer.periodic(const Duration(milliseconds: 45), (timer) {
      if (sent >= chunks.length) {
        timer.cancel();
        finish();
        return;
      }
      final piece = chunks[sent++];
      buffer.write(piece);
      _send({
        'type': 'stream_event',
        'event': {
          'type': 'content_block_delta',
          'index': 0,
          'delta': {'type': 'text_delta', 'text': piece},
        },
      });
    });
  }

  static List<String> _chunks(String text) {
    const size = 6;
    final runes = text.runes.toList();
    return [
      for (var i = 0; i < runes.length; i += size)
        String.fromCharCodes(
          runes.sublist(i, i + size > runes.length ? runes.length : i + size),
        ),
    ];
  }
}
