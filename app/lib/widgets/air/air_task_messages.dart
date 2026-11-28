import 'dart:convert';

import 'package:flutter/material.dart';

import '../../i18n.dart';
import '../../services/air_service.dart';

class AirTaskMessages extends StatefulWidget {
  const AirTaskMessages({
    super.key,
    required this.taskId,
    required this.page,
    required this.service,
  });

  final String taskId;
  final Map<String, dynamic> page;
  final AirService service;

  @override
  State<AirTaskMessages> createState() => _AirTaskMessagesState();
}

class _AirTaskMessagesState extends State<AirTaskMessages> {
  late final _messages = _rows(widget.page);
  late String? _before = _cursor(widget.page);
  final _opening = <String>{};
  bool _loading = false;
  String? _error;

  static List<Map<String, dynamic>> _rows(Map<String, dynamic> page) =>
      (page['messages'] as List? ?? [])
          .whereType<Map<String, dynamic>>()
          .toList();
  static String? _cursor(Map<String, dynamic> page) =>
      page['hasMore'] == true ? page['before'] as String? : null;
  static String? _key(Map<String, dynamic> m) =>
      (m['messageKey'] ?? m['contextMessageId'] ?? m['id'])?.toString();

  Future<void> _older() async {
    final cursor = _before;
    if (_loading || cursor == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.service.taskDetails(
        widget.taskId,
        before: cursor,
      );
      if (!mounted) return;
      final seen = _messages.map(_key).toSet();
      setState(() {
        _messages.insertAll(0, _rows(page).where((m) => seen.add(_key(m))));
        _before = _cursor(page) == cursor ? null : _cursor(page);
      });
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _expand(String id) async {
    if (_opening.contains(id)) return;
    setState(() {
      _opening.add(id);
      _error = null;
    });
    try {
      final result = await widget.service.taskDetails(
        widget.taskId,
        messageId: id,
      );
      if (!mounted) return;
      final index = _messages.indexWhere((m) => _key(m) == id);
      if (index >= 0) {
        setState(
          () => _messages[index] = {
            ...result['message'] as Map<String, dynamic>,
            'messageKey': id,
          },
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _opening.remove(id));
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(t('airDetailMessages')),
      if (_error != null) Text(_error!),
      SizedBox(
        height: 300,
        child: NotificationListener<ScrollUpdateNotification>(
          onNotification: (event) {
            if (event.metrics.extentAfter < 48 &&
                (event.scrollDelta ?? 0) > 0) {
              _older();
            }
            return false;
          },
          child: ListView.builder(
            primary: false,
            reverse: true,
            itemCount: _messages.length + (_before == null ? 0 : 1),
            itemBuilder: (context, i) {
              if (i == _messages.length) {
                return TextButton(
                  onPressed: _loading ? null : _older,
                  child: Text(t('airDetailOlderMessages')),
                );
              }
              final m = _messages[_messages.length - 1 - i];
              final id = _key(m);
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(m['role']?.toString() ?? ''),
                  SelectableText(
                    m['content'] is String
                        ? m['content'] as String
                        : jsonEncode(m['content'] ?? ''),
                  ),
                  if (m['toolsExcerpt'] is String)
                    SelectableText(m['toolsExcerpt'] as String),
                  if (m['tools'] != null)
                    SelectableText(jsonEncode(m['tools'])),
                  if (m['truncated'] == true &&
                      m['canExpand'] != false &&
                      id != null)
                    TextButton(
                      onPressed: _opening.contains(id)
                          ? null
                          : () => _expand(id),
                      child: Text(t('airDetailExpandMessage')),
                    ),
                ],
              );
            },
          ),
        ),
      ),
    ],
  );
}
