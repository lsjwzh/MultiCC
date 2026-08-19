import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/workspace_service.dart';

/// M4-T3: the App side of the chat-view unification's task_run_stream
/// envelope (M1 forwarder). The per-directory workspace socket now surfaces
/// run activity for headless task runs; these tests pin the envelope shape
/// (slot identity never crosses the envelope) and the dispatch behaviour.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await SettingsService.getInstance();
  });

  group('parseTaskRunStreamEnvelope', () {
    test('parses a single-event envelope into an immutable projection', () {
      final event = WorkspaceService.parseTaskRunStreamEnvelope({
        'type': 'task_run_stream',
        'taskId': 'task-1',
        'runId': 'run-9',
        'dirId': 'dir-a',
        'slotEvent': {'type': 'assistant', 'text': 'hi'},
      });

      expect(event, isNotNull);
      expect(event!.taskId, 'task-1');
      expect(event.runId, 'run-9');
      expect(event.dirId, 'dir-a');
      expect(event.slotEvents, hasLength(1));
      expect(event.slotEvents.first['type'], 'assistant');
      expect(
        () => event.slotEvents.first['type'] = 'mutated',
        throwsUnsupportedError,
      );
      expect(
        () => event.slotEvents.add({'type': 'injected'}),
        throwsUnsupportedError,
      );
    });

    test('parses a batch envelope and drops non-map slot events', () {
      final event = WorkspaceService.parseTaskRunStreamEnvelope({
        'type': 'task_run_stream',
        'taskId': 'task-1',
        'runId': 'run-9',
        'dirId': 'dir-a',
        'slotEvents': [
          {'type': 'part_delta'},
          'not-a-map',
          {'type': 'message_start'},
        ],
      });

      expect(event, isNotNull);
      expect(event!.slotEvents, hasLength(2));
      expect(event.slotEvents.last['type'], 'message_start');
    });

    test('rejects envelopes without identity or usable payload', () {
      // Wrong type is not a task run envelope at all.
      expect(
        WorkspaceService.parseTaskRunStreamEnvelope({
          'type': 'status',
          'taskId': 'task-1',
          'runId': 'run-9',
          'slotEvent': {'type': 'assistant'},
        }),
        isNull,
      );
      // Missing taskId or runId — cannot attribute the activity.
      for (final broken in [
        {'type': 'task_run_stream', 'runId': 'run-9', 'slotEvent': {}},
        {'type': 'task_run_stream', 'taskId': 'task-1', 'slotEvent': {}},
        {
          'type': 'task_run_stream',
          'taskId': '',
          'runId': 'run-9',
          'slotEvent': {},
        },
      ]) {
        expect(
          WorkspaceService.parseTaskRunStreamEnvelope(broken),
          isNull,
          reason: '$broken must not parse',
        );
      }
      // Neither slotEvent nor slotEvents, or a batch with no map entries.
      expect(
        WorkspaceService.parseTaskRunStreamEnvelope({
          'type': 'task_run_stream',
          'taskId': 'task-1',
          'runId': 'run-9',
          'dirId': 'dir-a',
        }),
        isNull,
      );
      expect(
        WorkspaceService.parseTaskRunStreamEnvelope({
          'type': 'task_run_stream',
          'taskId': 'task-1',
          'runId': 'run-9',
          'dirId': 'dir-a',
          'slotEvents': ['nope'],
        }),
        isNull,
      );
    });
  });

  group('socket dispatch', () {
    test('a task_run_stream message fires onTaskRunEvent exactly once', () async {
      final settings = await SettingsService.getInstance();
      final service = WorkspaceService(settings: settings, dirId: 'dir-a');
      addTearDown(service.dispose);

      final received = <TaskRunStreamEvent>[];
      service.onTaskRunEvent = received.add;

      service.handleSocketMessage(
        jsonEncode({
          'type': 'task_run_stream',
          'taskId': 'task-1',
          'runId': 'run-9',
          'dirId': 'dir-a',
          'slotEvents': [
            {'type': 'part_delta'},
            {'type': 'part_delta'},
          ],
        }),
      );

      expect(received, hasLength(1));
      expect(received.single.taskId, 'task-1');
      expect(received.single.slotEvents, hasLength(2));
    });

    test('malformed payloads and unrelated types never fire the callback', () async {
      final settings = await SettingsService.getInstance();
      final service = WorkspaceService(settings: settings, dirId: 'dir-a');
      addTearDown(service.dispose);

      var fired = 0;
      service.onTaskRunEvent = (_) => fired++;

      service.handleSocketMessage('not json at all');
      service.handleSocketMessage({'type': 'snapshot', 'sessions': []});
      service.handleSocketMessage([1, 2, 3]);
      service.handleSocketMessage(
        jsonEncode({'type': 'task_run_stream', 'taskId': 'task-1'}),
      );

      expect(fired, 0);
      expect(service.statuses, isEmpty);
    });
  });
}
