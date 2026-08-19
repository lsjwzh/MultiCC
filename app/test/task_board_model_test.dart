import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/task_board.dart';

void main() {
  test('task module assignment is operation metadata, not a task state', () {
    final task = TaskBoardTask.fromJson({
      'id': 'task-1',
      'moduleId': 'pending',
      'title': '待归类任务',
      'status': 'active',
      'runState': 'waiting',
      'moduleAssignment': {
        'running': false,
        'attempts': 2,
        'lastError': 'classification_failed',
      },
    });

    expect(task.runState, 'waiting');
    expect(task.moduleAssignment?.running, isFalse);
    expect(task.moduleAssignment?.attempts, 2);
    expect(task.moduleAssignment?.lastError, 'classification_failed');
  });

  test('legacy classification metadata is accepted during rolling upgrade', () {
    final task = TaskBoardTask.fromJson({
      'id': 'task-legacy',
      'moduleId': 'pending',
      'title': '旧任务',
      'classification': {'state': 'running', 'attempts': 1},
    });

    expect(task.moduleAssignment?.running, isTrue);
    expect(task.moduleAssignment?.attempts, 1);
  });

  // M4-T3: the unified chat view's messages DTO carries run attribution
  // (which TaskRun produced the message) and the streaming-tail marker.
  // Both are additive — old servers omit them and parse to the defaults.
  test('task messages carry run attribution and streaming markers', () {
    final streaming = TaskMessage.fromJson({
      'sessionId': '',
      'role': 'assistant',
      'text': '部分输出…',
      'taskRunId': 'run-abc123',
      'partial': true,
    });
    expect(streaming.taskRunId, 'run-abc123');
    expect(streaming.partial, isTrue);
    expect(streaming.hasSessionTarget, isFalse);

    final legacy = TaskMessage.fromJson({
      'sessionId': 'session-1',
      'role': 'user',
      'text': 'hi',
    });
    expect(legacy.taskRunId, isNull);
    expect(legacy.partial, isFalse);
  });

  test('detail prefers the unified messages DTO and exposes page cursors', () {
    // A0: the sheet pages through the same `messages` contract the web chat
    // view consumes (test-chat-dto-golden pins it server-side), instead of
    // the legacy unpaginated `items` projection.
    final detail = TaskBoardDetail.fromJson({
      'ok': true,
      'messages': [
        {
          'id': 'm-1',
          'role': 'user',
          'content': '继续任务',
          'ts': 1724000001000,
          'taskRunId': 'run-9',
          'clientMsgId': 'cm-1',
        },
        {
          'id': 'm-2',
          'role': 'assistant',
          'content': '部分输出…',
          'ts': 1724000004000,
          'taskRunId': 'run-9',
          'partial': true,
        },
      ],
      'hasMore': true,
      'before': 'm-1',
      'items': [
        {'sessionId': 'legacy-1', 'role': 'user', 'text': '旧投影不应被采用'},
      ],
    });
    expect(detail.messages, hasLength(2));
    expect(detail.messages.first.messageId, 'm-1');
    expect(detail.messages.first.text, '继续任务');
    expect(detail.messages.first.hasSessionTarget, isFalse);
    expect(detail.messages.last.partial, isTrue);
    expect(detail.hasMore, isTrue);
    expect(detail.before, 'm-1');
  });

  test('detail falls back to legacy items on servers without the messages page', () {
    final detail = TaskBoardDetail.fromJson({
      'ok': true,
      'items': [
        {
          'sessionId': 'sess-1',
          'sessionLabel': '工程师1',
          'role': 'assistant',
          'messageId': 'legacy-7',
          'text': '旧格式',
          'ts': 1,
        },
      ],
    });
    expect(detail.messages, hasLength(1));
    expect(detail.messages.single.text, '旧格式');
    expect(detail.messages.single.hasSessionTarget, isTrue);
    expect(detail.hasMore, isFalse);
    expect(detail.before, isNull);
  });
}
