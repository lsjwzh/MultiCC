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
}
