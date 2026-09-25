import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
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
  AirWorktreeChanges? worktreeChanges,
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
  worktreeChanges: worktreeChanges,
);

void main() {
  // Air 词表出自注册表的 airLabelKey 列，取词走 t()，所以词典得先装好 —— 不然
  // 拿到的是 key 本身。
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

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
    test('等待回答 > 出错 > 卡在资源 > 正在跑/等后台任务 > 其它', () {
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
      // 在等后台任务：有东西在外面跑，不是等我动手。
      expect(airTaskUrgency(_task(runState: 'background')), 3);
      expect(airNeedsAttention(_task(runState: 'background')), isFalse);
      // 租约已经交出去：还没跑起来，但名额已经不在池子里了。
      expect(
        airTaskUrgency(_task(resource: const {'lease': 'starting'})),
        3,
      );
      expect(airTaskUrgency(_task()), 4);
      expect(airTaskUrgency(_task(status: 'done')), 5);
      expect(airTaskUrgency(_task(status: 'archived')), 5);
    });

    test('只有要我动手的才算「在等我」：在跑的不列，空闲 / 已结束的也不列', () {
      expect(airNeedsAttention(_task(runState: 'waiting')), isTrue);
      expect(airNeedsAttention(_task(runState: 'error')), isTrue);
      // 拿不到执行名额同样要我去处理。
      expect(
        airNeedsAttention(
          _task(
            runState: 'idle',
            resource: const {'capacityReason': 'workspace_execution_capacity'},
          ),
        ),
        isTrue,
      );
      // 跑着的东西不是待办：它不需要我操作。
      expect(airNeedsAttention(_task(runState: 'running')), isFalse);
      expect(
        airNeedsAttention(_task(resource: const {'lease': 'starting'})),
        isFalse,
      );
      expect(airNeedsAttention(_task(runState: 'idle')), isFalse);
      expect(airNeedsAttention(_task(status: 'done')), isFalse);
      expect(airNeedsAttention(_task(status: 'archived')), isFalse);

      final rows = airUrgentTasks([
        _task(id: 'idle', runState: 'idle'),
        _task(id: 'done', status: 'done'),
        _task(id: 'run', runState: 'running', updatedAt: 999),
        _task(id: 'wait', runState: 'waiting', updatedAt: 100),
        _task(id: 'bad', runState: 'error', updatedAt: 200),
      ]);
      expect(rows.map((t) => t.id).toList(), ['bad', 'wait']);
    });

    test('清单是纯时间倒序：刚动过的最靠前，不按紧急度分层（同 Web）', () {
      final rows = airUrgentTasks([
        _task(id: 'old', runState: 'waiting', updatedAt: 100),
        _task(id: 'err', runState: 'error', updatedAt: 999),
        _task(id: 'new', runState: 'waiting', updatedAt: 200),
      ]);
      // 按紧急度分层会得到 new · old · err；纯时间只会是 err · new · old。
      expect(rows.map((t) => t.id).toList(), ['err', 'new', 'old']);
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

  group('Air 徽标说 Air 词表', () {
    test('词从注册表的 airLabelKey 列取，跟词典里那几个词不是一个说法', () {
      // App 词典里 running 是「进行中」、waiting 是「等待中」；Air 面说的是另一套 ——
      // 注册表 airLabelKey 那一列（Web `air-admin.js` 的 STATUS_COPY、`air.js` 的
      // stateNames 都由它构建），跟侧栏那些阶段、资源去向（`airLabel`）同源。
      expect(airStatusLabel(CanonicalStatus.running), '执行中');
      expect(airStatusLabel(CanonicalStatus.waiting), '等待回答');
      expect(airStatusLabel(CanonicalStatus.blocked), '等待配置');
      expect(airStatusLabel(CanonicalStatus.error), '执行异常');
      expect(airStatusLabel(CanonicalStatus.succeeded), '执行成功');
      expect(airStatusLabel(CanonicalStatus.unknown), '状态未知');
      // 等后台任务是它自己的词，不是「等待回答」—— 那张卡上没有东西要人回答。
      expect(airStatusLabel(CanonicalStatus.background), '等待后台任务');
      expect(
        airStatusLabel(CanonicalStatus.background),
        isNot(airStatusLabel(CanonicalStatus.waiting)),
      );
      // 每个状态一个不落、一个词也不重：两个状态共用一个词，折叠就又隐身了。
      final words = <String>{};
      for (final status in CanonicalStatus.values) {
        final word = airStatusCopy()[status];
        expect(word, isNotNull, reason: '$status 缺词');
        expect(word, isNot(status.name), reason: '$status 落回了状态名');
        expect(words.add(word!), isTrue, reason: '$status 和别的状态同词：$word');
      }
    });

    test('一行上不会出现两个词说同一件事', () {
      // 在跑的任务：徽标「执行中」，第二层不该再说一遍（租约也是 running）。
      final running = _task(runState: 'running', resource: const {'lease': 'running'});
      expect(airStatusLabel(airTaskStatus(running)), '执行中');
      expect(airTaskDetail(running), '');
    });
  });

  group('worktree 待交付图标', () {
    test('未提交、未合并和两者同时存在时，提示各说各的', () {
      expect(airWorktreeChangeLabel(_task(
        worktreeChanges: const AirWorktreeChanges(dirty: true),
      )), 'Worktree 有未提交改动');
      expect(airWorktreeChangeLabel(_task(
        worktreeChanges: const AirWorktreeChanges(ahead: 3),
      )), 'Worktree 有 3 个提交尚未合并');
      expect(airWorktreeChangeLabel(_task(
        worktreeChanges: const AirWorktreeChanges(dirty: true, ahead: 2),
      )), 'Worktree 有未提交改动，另有 2 个提交尚未合并');
      expect(airWorktreeChangeLabel(_task(
        worktreeChanges: const AirWorktreeChanges(),
      )), '');
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

    test('观察型记录不说阶段：这正是「满屏进行中」的来源', () {
      // `status` 是生命周期（active/done/archived），不是「在不在跑」。老写法拿它
      // 兜底当阶段，于是每条没跑的任务都在这一行写「进行中」，跟同一行的徽标
      // （空闲 / 执行成功 / 等待回答）说反话。
      expect(airTaskDetail(_task()), '', reason: '观察型记录没有阶段，也没有资源去向');
      expect(
        airTaskDetail(_task(status: 'done')),
        '',
        reason: '已完成也不该在这里写「进行中」—— 徽标已经说了',
      );
      // 有真话可说的时候照说：卡在名额上就得写出来。
      expect(
        airTaskDetail(
          _task(runState: 'waiting', resource: const {
            'capacityReason': 'workspace_execution_capacity',
          }),
        ),
        '等待执行名额',
      );
    });

    test('徽标说过的词不在第二层再说一遍（同 Web 侧栏）', () {
      expect(
        airTaskDetail(_task(runState: 'running', resource: const {'lease': 'running'})),
        '',
        reason: '徽标「执行中」+ 这行「执行中」不是更多信息',
      );
      // 阶段和资源去向撞词时同理（planned 记录才有阶段）。
      expect(
        airTaskDetail(
          _task(
            recordType: 'planned',
            workflowStage: 'review',
            resource: const {'lease': 'review'},
          ),
        ),
        '计划 · 待验收',
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
