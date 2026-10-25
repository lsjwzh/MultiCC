import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import '../i18n.dart';
import '../services/chat_service.dart';
import '../providers/session_manager.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';

/// A refusal from the separation endpoint, keeping the server's stable code.
class TaskSeparationError implements Exception {
  final String code;
  final String message;
  const TaskSeparationError(this.code, this.message);
  @override
  String toString() => taskSeparationErrorText(code, message);
}

// Same code → i18n key table as public/chat-task-separation.js.
const _errKeys = <String, List<String>>{
  'taskSeparationErrBusy': [
    'fork_source_busy',
    'task_busy',
    'workspace_lease_unavailable',
    'workspace_busy',
    'barrier_code_changed',
  ],
  'taskSeparationErrStale': ['separation_stale'],
  'taskSeparationErrDirty': ['fork_source_dirty'],
  'taskSeparationErrDelivery': [
    'integration_receipt_required',
    'baseline_revalidation_required',
    'final_run_result_required',
    'run_not_succeeded',
    'code_observation_required',
    'barrier_run_mismatch',
  ],
  'taskSeparationErrIndex': ['code_index_unsupported'],
  'taskSeparationErrTooLarge': ['code_observation_limit'],
  'taskSeparationErrGitOp': ['code_git_operation'],
  'taskSeparationErrChanging': ['code_changed_during_observation'],
  'taskSeparationErrPath': [
    'code_path_unsupported',
    'code_parent_unsupported',
    'code_file_unsupported',
  ],
  'taskSeparationErrResolved': [
    'separation_already_resolved',
    'separation_not_found',
  ],
  'taskSeparationErrConfirmed': ['separation_already_confirmed'],
  'taskSeparationErrTaskLimit': ['task_shell_task_limit'],
  'taskSeparationErrCapacity': [
    'workspace_resident_capacity',
    'workspace_execution_capacity',
    'workspace_restore_capacity',
  ],
};

/// Readable text for a separation refusal: known codes are translated,
/// unknown ones get a generic sentence carrying the code for diagnosis.
String taskSeparationErrorText(String code, String message) {
  String? keyOf(String c) {
    for (final e in _errKeys.entries) {
      if (e.value.contains(c)) return e.key;
    }
    return null;
  }

  // Older servers carry the stable code only in the message.
  if (keyOf(code) == null &&
      RegExp(r'^[a-z][a-z0-9_]{2,99}$').hasMatch(message)) {
    code = message;
  }
  final key = keyOf(code);
  if (key != null) return t(key);
  if (code.isEmpty) code = 'separation_failed';
  final generic = t('taskSeparationErrFailed', {'code': code});
  return message.isNotEmpty && message != code ? '$generic $message' : generic;
}

/// Watches classification/reconnect events; no polling or model invocation.
class TaskSeparationPrompt extends StatefulWidget {
  final Stream<ChatEvent> events;
  final String sessionId;
  final http.Client? httpClient;
  final SettingsService settings;
  final Widget child;
  const TaskSeparationPrompt({
    super.key,
    required this.events,
    required this.sessionId,
    this.httpClient,
    required this.settings,
    required this.child,
  });
  @override
  State<TaskSeparationPrompt> createState() => _TaskSeparationPromptState();
}

class _TaskSeparationPromptState extends State<TaskSeparationPrompt> {
  StreamSubscription<dynamic>? _events;
  Object? _stream;
  bool _loading = false, _again = false;
  String? _displayed;
  DialogRoute<void>? _dialog;
  @override
  void initState() {
    super.initState();
    _subscribe();
  }

  @override
  void didUpdateWidget(TaskSeparationPrompt oldWidget) {
    super.didUpdateWidget(oldWidget);
    _subscribe();
    if (oldWidget.sessionId != widget.sessionId) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _refresh();
      });
    }
  }

  void _subscribe() {
    final stream = widget.events;
    // 广播控制器的 `.stream` 每次 get 都是新包装对象（== 按控制器比较，
    // identical 永远不等）——用 identical 会让每次重建都重订阅并立刻请求一次，
    // 页面一直重绘时（比如反复重连）就成了每秒几十次的 task-separation 请求。
    if (stream == _stream) return;
    _events?.cancel();
    _stream = stream;
    _events = stream.listen((event) {
      if ([
        'task_state',
        'system_init',
        'chat_msg_meta',
        'task_separation_updated',
        'state_change',
      ].contains(event.type)) {
        unawaited(_refresh());
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _refresh();
    });
  }

  Future<Map<String, dynamic>> _request(
    String session, {
    String? id,
    String? decision,
  }) async {
    final settings = widget.settings;
    final uri = Uri.parse(
      settings.buildHttpUrl(
        '/api/sessions/${Uri.encodeComponent(session)}/task-separation${id == null ? '' : '/${Uri.encodeComponent(id)}'}',
      ),
    );
    final headers = <String, String>{
      'Content-Type': 'application/json',
      if (settings.token.isNotEmpty) 'X-Access-Token': settings.token,
    };
    final body = jsonEncode({'decision': decision});
    final pending = id == null
        ? (widget.httpClient?.get(uri, headers: headers) ??
              http.get(uri, headers: headers))
        : (widget.httpClient?.post(uri, headers: headers, body: body) ??
              http.post(uri, headers: headers, body: body));
    final response = await pending.timeout(const Duration(seconds: 30));
    final data = (jsonDecode(utf8.decode(response.bodyBytes)) as Map)
        .cast<String, dynamic>();
    if (response.statusCode != 200 || data['ok'] != true) {
      throw TaskSeparationError(
        '${data['code'] ?? ''}',
        '${data['message'] ?? 'HTTP ${response.statusCode}'}',
      );
    }
    return data;
  }

  void _close() {
    final route = _dialog;
    _dialog = null;
    _displayed = null;
    if (route?.isActive == true) route!.navigator?.removeRoute(route);
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    if (_loading) {
      _again = true;
      return;
    }
    if (ModalRoute.of(context)?.isCurrent == false && _dialog == null) return;
    final session = widget.sessionId;
    if (session.isEmpty) return;
    _loading = true;
    try {
      final data = await _request(session);
      if (!mounted) return;
      if (session != widget.sessionId) {
        _again = true;
        return;
      }
      final suggestion = data['suggestion'] as Map?;
      final id = suggestion?['id']?.toString();
      if (id != _displayed) _close();
      if (id == null || _displayed == id) return;
      _displayed = id;
      String? error;
      bool saving = false;
      final route = DialogRoute<void>(
        context: context,
        barrierDismissible: false,
        builder: (dialogContext) => StatefulBuilder(
          builder: (context, update) {
            Future<void> decide(String decision) async {
              update(() {
                saving = true;
                error = null;
              });
              try {
                if (session != widget.sessionId) {
                  throw const TaskSeparationError('separation_stale', '');
                }
                final result = await _request(
                  session,
                  id: id,
                  decision: decision,
                );
                if (!mounted) return;
                if (result['decision'] == 'separate') {
                  final next = await SessionService(
                    settings: widget.settings,
                  ).fetchTaskBoundSession(result['sessionId'] as String);
                  if (!mounted) return;
                  if (next == null) {
                    throw Exception('Unable to open task session');
                  }
                  final manager = this.context.read<SessionManager>();
                  _close();
                  manager.openSession(next, historyArchive: true);
                  manager.switchToSession(next.id);
                } else {
                  _close();
                }
              } catch (e) {
                if (dialogContext.mounted) {
                  update(() {
                    saving = false;
                    error = e is TaskSeparationError
                        ? '$e'
                        : taskSeparationErrorText('', '$e');
                  });
                }
              }
            }

            return PopScope(
              canPop: false,
              child: AlertDialog(
                title: Text(t('taskSeparationTitle')),
                content: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(t('taskSeparationBody')),
                      const SizedBox(height: 12),
                      Text(
                        '${suggestion!['sourceTitle'] ?? ''} → ${suggestion['title']}',
                      ),
                      if ((suggestion['reason'] ?? '').toString().isNotEmpty)
                        Text('${suggestion['reason']}'),
                      if (error != null)
                        Text(
                          error!,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                    ],
                  ),
                ),
                actions: [
                  TextButton(
                    onPressed: saving ? null : () => decide('keep'),
                    child: Text(t('taskSeparationKeep')),
                  ),
                  FilledButton(
                    onPressed: saving ? null : () => decide('separate'),
                    child: Text(t('taskSeparationAccept')),
                  ),
                ],
              ),
            );
          },
        ),
      );
      _dialog = route;
      unawaited(Navigator.of(context).push(route));
    } catch (e) {
      debugPrint('Task separation: $e');
    } finally {
      _loading = false;
      if (_again && mounted) {
        _again = false;
        unawaited(_refresh());
      }
    }
  }

  @override
  void dispose() {
    _events?.cancel();
    _close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
