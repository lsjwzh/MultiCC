import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/utils/status_presentation.dart';
import 'package:multicc_app/widgets/air/air_task_status.dart';

/// 造一条任务，只给这一份判定真正会读的字段。
AirTask _task({
  String id = 't1',
  String dirId = 'd1',
  String status = 'active',
  String? runState,
  String? workflowStage,
  String recordType = '',
  Map<String, dynamic> resource = const {},
  int updatedAt = 0,
}) => AirTask(
  id: id,
  dirId: dirId,
  title: '任务 $id',
  status: status,
  recordType: recordType,
  updatedAt: updatedAt,
  readOnly: false,
  workflowStage: workflowStage,
  runState: runState,
  resource: resource,
);

void main() {
  group('一条任务算什么', () {
    test('生命周期最优先：归档和完成不因为这一轮在跑就被改写成执行中', () {
      expect(
        airTaskStatus(_task(status: 'archived', runState: 'running')),
        CanonicalStatus.archived,
      );
      expect(
        airTaskStatus(_task(status: 'done', runState: 'running')),
        CanonicalStatus.done,
      );
    });

    test('status 只有三个生命周期取值，「在不在跑」只能从 runState 读', () {
      expect(
        airTaskStatus(_task(runState: 'running')),
        CanonicalStatus.running,
      );
      expect(
        airTaskStatus(_task(runState: 'waiting')),
        CanonicalStatus.waiting,
      );
      // active 但什么都没在跑，是空闲，不是执行中 —— 这正是从前按
      // `status == 'active'` 数「执行中」会数错的那一批。
      expect(airTaskStatus(_task()), CanonicalStatus.idle);
      expect(airTaskRunning(_task()), isFalse);
    });

    test('只有 runState=running 会转圈：出错的任务绝不动画', () {
      expect(airTaskRunning(_task(runState: 'running')), isTrue);
      expect(airTaskRunning(_task(runState: 'error')), isFalse);
      expect(airTaskRunning(_task(runState: 'queued')), isFalse);
      expect(
        airTaskStatus(_task(runState: 'error')),
        CanonicalStatus.error,
      );
    });

    test('认不出来的 runState 落 unknown，不猜成成功也不猜成在跑', () {
      expect(
        airTaskStatus(_task(runState: '前所未见的状态')),
        CanonicalStatus.unknown,
      );
    });
  });

  group('谁在等我', () {
    test('等待回答 > 出错 > 卡在资源 > 正在跑 > 其它', () {
      expect(airTaskUrgency(_task(runState: 'waiting')), 0);
      expect(airTaskUrgency(_task(runState: 'error')), 1);
      expect(
        airTaskUrgency(
          _task(
            runState: 'idle',
            resource: const {'capacityReason': 'workspace_execution_capacity'},
          ),
        ),
        2,
      );
      expect(airTaskUrgency(_task(runState: 'running')), 3);
      // 租约已经交出去：还没跑起来，但名额已经不在池子里了。
      expect(
        airTaskUrgency(_task(resource: const {'lease': 'starting'})),
        3,
      );
      expect(airTaskUrgency(_task()), 4);
      expect(airTaskUrgency(_task(status: 'done')), 5);
      expect(airTaskUrgency(_task(status: 'archived')), 5);
    });

    test('空闲和已结束的不算「在等我」，同紧急度按更新时间新的在前', () {
      final rows = airUrgentTasks([
        _task(id: 'idle', runState: 'idle'),
        _task(id: 'done', status: 'done'),
        _task(id: 'old', runState: 'waiting', updatedAt: 100),
        _task(id: 'new', runState: 'waiting', updatedAt: 200),
        _task(id: 'bad', runState: 'error', updatedAt: 999),
      ]);
      expect(rows.map((t) => t.id).toList(), ['new', 'old', 'bad']);
    });

    test('有任务在跑的目录才带标记', () {
      expect(
        airRunningDirectories([
          _task(id: 'a', dirId: 'd1', runState: 'running'),
          _task(id: 'b', dirId: 'd2', runState: 'waiting'),
          _task(id: 'c', dirId: 'd3', runState: 'idle'),
        ]),
        {'d1'},
      );
    });
  });

  group('行上的第二层信息', () {
    test('计划 + 阶段 + 资源去向，合起来一句话', () {
      expect(
        airTaskDetail(
          _task(
            recordType: 'planned',
            workflowStage: 'inbox',
            resource: const {'residency': 'planned'},
          ),
        ),
        '计划 · 待处理 · 执行时准备目录',
      );
    });

    test('资源那句话说不出新东西时就不重复一遍', () {
      // 目录已准备 + 阶段就是「目录已准备」：说两遍不如说一遍。
      expect(
        airTaskDetail(
          _task(
            workflowStage: 'resident',
            resource: const {'residency': 'resident'},
          ),
        ),
        '目录已准备',
      );
    });

    test('时间按本地时区写成 月/日 时:分，没时间就不写', () {
      expect(airTaskTime(0), '');
      final at = DateTime(2026, 9, 13, 8, 5);
      expect(
        airTaskTime(at.millisecondsSinceEpoch),
        '9/13 08:05',
      );
    });
  });
}
