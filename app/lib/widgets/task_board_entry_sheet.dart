import 'dart:async';
import 'package:flutter/material.dart';
import '../i18n.dart';
import '../models/message.dart';
import '../services/manage_service.dart';
import '../services/settings_service.dart';
import 'message_bubble.dart';

/// A board preview never owns an execution session or a worktree.
class TaskBoardEntrySheet extends StatefulWidget {
  final SettingsService settings;
  final String taskId;
  final Map<String, dynamic>? initialEntry;
  final void Function(String)? onOpenSession;
  const TaskBoardEntrySheet({
    super.key,
    required this.settings,
    required this.taskId,
    this.initialEntry,
    this.onOpenSession,
  });
  @override
  State<TaskBoardEntrySheet> createState() => _TaskBoardEntrySheetState();
}

class _TaskBoardEntrySheetState extends State<TaskBoardEntrySheet> {
  Map<String, dynamic>? _entry;
  String? _error;
  bool _busy = false;
  Timer? _timer;
  final _forkKey = 'fork-${DateTime.now().microsecondsSinceEpoch}';
  ManageService get _service => ManageService(settings: widget.settings);
  @override
  void initState() {
    super.initState();
    _entry = widget.initialEntry;
    _refresh();
  }

  Future<void> _refresh() async {
    try {
      final entry = await _service.taskShellEntry(widget.taskId);
      if (mounted) setState(() => _entry = entry);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
    if (mounted) _timer = Timer(const Duration(seconds: 3), _refresh);
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _open(String? sessionId) {
    if (sessionId == null || widget.onOpenSession == null) {
      return;
    }
    Navigator.pop(context);
    widget.onOpenSession!(sessionId);
  }

  Future<void> _fork() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await _service.taskShellEntry(
        widget.taskId,
        forkKey: _forkKey,
      );
      if (mounted) _open(result['sessionId'] as String?);
    } catch (e) {
      if (mounted) {
        setState(
          () =>
              _error = e is BoardRouteException && e.code == 'fork_source_busy'
              ? t('taskBoardForkSourceBusy')
              : e is BoardRouteException && e.code == 'fork_source_dirty'
              ? t('taskBoardForkSourceDirty')
              : e.toString(),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final messages = (_entry?['messages'] as List? ?? [])
        .whereType<Map>()
        .toList();
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .9,
        child: Column(
          children: [
            ListTile(
              title: Text(
                _entry?['task']?['title']?.toString() ?? widget.taskId,
              ),
              trailing: IconButton(
                icon: const Icon(Icons.close),
                onPressed: () => Navigator.pop(context),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(t('taskBoardReadOnlyHint')),
            ),
            if (_error != null)
              Padding(padding: const EdgeInsets.all(8), child: Text(_error!)),
            Expanded(
              child: _entry == null
                  ? const Center(child: CircularProgressIndicator())
                  : ListView.builder(
                      itemCount: messages.length,
                      itemBuilder: (_, i) => MessageBubble(
                        message: ChatMessage.fromHistory(
                          Map<String, dynamic>.from(messages[i]),
                        ),
                        enableServerActions: false,
                      ),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Wrap(
                spacing: 12,
                children: [
                  TextButton(
                    onPressed:
                        widget.onOpenSession == null ||
                            _entry?['sourceSessionId'] == null
                        ? null
                        : () => _open(_entry!['sourceSessionId'] as String),
                    child: Text(t('taskBoardReturnConversation')),
                  ),
                  FilledButton(
                    onPressed:
                        _busy || _entry == null || widget.onOpenSession == null
                        ? null
                        : _fork,
                    child: Text(
                      t(
                        _busy ? 'taskBoardForking' : 'taskBoardForkIndependent',
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
