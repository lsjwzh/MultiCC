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
    if (identical(stream, _stream)) return;
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
      throw Exception(
        data['message'] ?? data['code'] ?? 'HTTP ${response.statusCode}',
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
                  throw Exception('separation_stale');
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
                    error = '$e';
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
