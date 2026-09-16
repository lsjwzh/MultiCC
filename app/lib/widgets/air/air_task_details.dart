import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../theme.dart';
import 'air_role_editor.dart';
import 'air_task_actions.dart';

/// 归属建议被挡在哪一条上（Web `air.js` 的 `blockerNames`）。这些是枚举值，漏
/// 一个界面上就会蹦出一行英文。
const Map<String, String> airBlockerNames = {
  'view_changed': '已有新输入或视图变化，旧建议不能迟到改投。',
  'final_run_result_required': '等待本轮最终执行结果。',
  'run_not_succeeded': '本轮失败、取消或仍在等待回答。',
  'code_observation_required': '本轮最终代码版本尚未核实。',
  'integration_receipt_required': '等待本轮代码按项目流程合入基分支。',
  'baseline_revalidation_required': '基分支已变化，需要重新核验交付记录。',
  'source_writer_barrier_required': '尚不能确认源工作目录持续停写。',
  'separation_application_required': '独立任务尚未创建并记录生效凭证。',
  'fork_source_dirty': '源工作目录仍有未交付修改，暂不能分离。',
  'fork_source_busy': '源任务仍在执行，等本轮结束后再分离。',
  'workspace_busy': '源工作目录仍有写入者，暂不能建立停写屏障。',
  'separation_barrier_unavailable': '当前运行时不支持分离停写屏障。',
  'delivery_evidence_unavailable': '当前运行时无法读取交付事实。',
  'separation_application_unavailable': '当前运行时无法写入分离生效凭证。',
};

/// 页头那行状态：手机上是跟标题挤同一行的，「任务 进行中」这一段可以让位，留下
/// 「本轮 …」和「归属待核验」。分段返回，具体藏哪段由界面决定（同 Web
/// `taskStateSegments`）。
List<String> airTaskStateSegments(Map<String, dynamic> value) {
  final task = (value['task'] as Map?)?.cast<String, dynamic>() ?? const {};
  final execution =
      (value['execution'] as Map?)?.cast<String, dynamic>() ?? const {};
  final messages = value['messages'] as List?;
  final unstartedPlan =
      task['recordType'] == 'planned' &&
      (messages == null || messages.isEmpty) &&
      execution['busy'] != true &&
      execution['pending'] != true;
  final status =
      execution['status']?.toString() ??
      (execution['busy'] == true ? 'running' : 'idle');
  final run = unstartedPlan
      ? '计划待执行'
      : airLabel(execution['pending'] == true ? 'waiting' : status);
  final lifecycle = airLabel((task['status'] ?? value['status'])?.toString());
  return [
    if (run.isNotEmpty) '本轮 $run',
    if (lifecycle.isNotEmpty) '任务 $lifecycle',
  ];
}

/// 交付卡的文案。这一段是「本轮 ≠ 任务完成 ≠ 归属生效」那条规则在界面上的全部
/// 出口，所以判断顺序和 Web `renderDelivery` 一字不差：先看有没有卡住的资源，
/// 再看有没有在等回答，再看过期的建议，最后才是「本轮成功」那些。
class AirDeliveryCopy {
  const AirDeliveryCopy({
    required this.eyebrow,
    required this.title,
    required this.text,
    required this.steps,
  });

  final String eyebrow;
  final String title;
  final String text;

  /// 每一步都是服务端独立事实，客户端不再用一个 stage 猜后两步。
  final List<AirDeliveryStep> steps;
}

class AirDeliveryStep {
  const AirDeliveryStep({
    required this.key,
    required this.label,
    required this.status,
  });
  final String key;
  final String label;
  final String status;
}

const List<String> airDeliverySteps = ['本轮成功', '代码交付', '源现场稳定', '任务归属'];

List<AirDeliveryStep> _airDeliverySteps(Map<String, dynamic> attribution) {
  final reported = attribution['steps'] as List?;
  if (reported != null && reported.isNotEmpty) {
    return reported
        .take(4)
        .toList()
        .asMap()
        .entries
        .map((entry) {
          final value =
              (entry.value as Map?)?.cast<String, dynamic>() ?? const {};
          final status =
              {
                'done',
                'pending',
                'blocked',
                'skipped',
              }.contains(value['status'])
              ? '${value['status']}'
              : 'pending';
          return AirDeliveryStep(
            key: '${value['key'] ?? entry.key}',
            label: '${value['label'] ?? airDeliverySteps[entry.key]}',
            status: status,
          );
        })
        .toList(growable: false);
  }
  final run = attribution['run'] as Map?;
  final integration = attribution['integration'] as Map?;
  final stage = integration?['baselineCurrent'] == true
      ? 3
      : integration != null
      ? 2
      : run?['outcome'] == 'succeeded' && run?['pendingInput'] != true
      ? 1
      : 0;
  return airDeliverySteps
      .asMap()
      .entries
      .map(
        (entry) => AirDeliveryStep(
          key: '$entry.key',
          label: entry.value,
          status: entry.key < stage ? 'done' : 'pending',
        ),
      )
      .toList(growable: false);
}

AirDeliveryCopy airDeliveryCopy(Map<String, dynamic> value) {
  final attribution =
      (value['attribution'] as Map?)?.cast<String, dynamic>() ?? const {};
  final candidate = attribution['candidate'] as Map?;
  final separation = attribution['separation'] as Map?;
  final run = attribution['run'] as Map?;
  final integration = attribution['integration'] as Map?;
  final resource = (value['resource'] as Map?)?.cast<String, dynamic>();
  final execution =
      (value['execution'] as Map?)?.cast<String, dynamic>() ?? const {};
  final task = (value['task'] as Map?)?.cast<String, dynamic>() ?? const {};

  final capacity = resource?['capacityReason']?.toString();
  final pending = execution['pending'] == true;
  final status =
      execution['status']?.toString() ??
      (execution['busy'] == true ? 'running' : 'idle');
  final running =
      execution['busy'] == true ||
      const ['starting', 'running', 'queued'].contains(status);
  final failed = const ['error', 'failed', 'cancelled'].contains(status);
  final unstartedPlan =
      task['recordType'] == 'planned' &&
      ((value['messages'] as List?)?.isEmpty ?? true) &&
      run == null;

  final currentTitle = '${task['title'] ?? ''}';
  final targetTitle =
      '${separation?['targetTitle'] ?? candidate?['title'] ?? candidate?['taskName'] ?? '建议任务'}';

  var eyebrow = 'MULTICC · 本轮状态';
  var title = '本轮状态已记录';
  var text = '任务保持当前归属，可以继续输入下一步。';
  final steps = _airDeliverySteps(attribution);

  if (capacity != null && capacity.isNotEmpty) {
    eyebrow = 'MULTICC · 执行资源';
    title = '${airLabel(capacity)} · 现有工作现场正在保留';
    text = '消息已绑定当前任务；资源可用后继续，不会停止其他服务或删除未交付修改。';
  } else if (pending) {
    eyebrow = 'MULTICC · 等待回答';
    title = '本轮需要你的回答';
    text = '回答仍提交给原任务与原请求，不会因为归属建议改变目标。';
  } else if (candidate?['state'] == 'stale' && separation == null) {
    eyebrow = 'MULTICC · 归属建议未应用';
    title = '本次归属建议已过期';
    text = '你已继续输入或切换视图，迟到的分类与合并事件不会改投已经接受的消息。';
  } else if (separation?['state'] == 'separated') {
    eyebrow = 'MULTICC · 分离已生效';
    title = '已创建独立任务「$targetTitle」';
    text = '本轮已按停写屏障锁定的版本应用到新任务；源任务原始对话保持不变。';
  } else if (separation?['state'] == 'kept') {
    eyebrow = 'MULTICC · 分离建议已处理';
    title = '本轮保留在当前任务';
    text = '你已选择不创建独立任务；第 4 步以「已跳过」记录。';
  } else if (separation != null) {
    final blocked = separation['phase'] == 'blocked';
    final blockers = (attribution['blockers'] as List?)?.map((item) => '$item');
    final blocker = blockers
        ?.where((item) => item != 'separation_application_required')
        .firstOrNull;
    eyebrow = blocked ? 'MULTICC · 分离暂未生效' : 'MULTICC · 建议独立任务';
    title = blocked ? '「$targetTitle」尚未建立' : '是否将本轮分离为「$targetTitle」';
    text = blocked
        ? (airBlockerNames[blocker] ??
              '${(separation['lastError'] as Map?)?['message'] ?? '完整交付与停写核验通过后可安全重试。'}')
        : '确认后会创建一个独立任务壳与工作目录，不改写当前任务的原始对话。';
  } else if (candidate != null && running) {
    eyebrow = 'MULTICC · 本轮执行中';
    title = '归属将在本轮交付后确认';
    text = '可能关联「$targetTitle」，当前仍在「$currentTitle」中执行。';
  } else if (candidate != null &&
      (run?['outcome'] != 'succeeded' || run?['pendingInput'] == true)) {
    eyebrow = 'MULTICC · 尚未满足归属条件';
    title = '本轮未成功或仍需回答';
    text = '建议目标仍是「$targetTitle」，原问题继续绑定当前任务。';
  } else if (candidate != null && integration == null) {
    eyebrow = 'MULTICC · 本轮成功，等待交付';
    title = '建议归入「$targetTitle」';
    text = '执行成功不等于任务完成或归属生效；相关代码按项目流程交付后再核验。';
  } else if (candidate != null &&
      integration != null &&
      integration['baselineCurrent'] != true) {
    eyebrow = 'MULTICC · 交付记录待核验';
    title = '建议归入「$targetTitle」';
    text = '已有合并记录，但基分支状态发生变化；重新核验前保持当前任务。';
  } else if (candidate != null) {
    eyebrow = 'MULTICC · 交付已核验';
    title = '建议归入「$targetTitle」· 等待源现场稳定';
    text = '代码交付已核验；持续停写屏障与原子归属尚未完成，不提前转移工作区或消息。';
  } else if (running) {
    eyebrow = 'MULTICC · 本轮执行中';
    title = '任务正在当前工作目录执行';
    text = '本轮结果、代码交付与任务完成会分别记录；执行期间下一条消息仍发送到当前任务。';
  } else if (failed || (run != null && run['outcome'] != 'succeeded')) {
    eyebrow = 'MULTICC · 本轮未成功';
    title = '任务保持进行中';
    text = '失败、取消或等待回答都不会被误写成任务完成，后续可以在当前任务重试或继续。';
  } else if (run != null) {
    eyebrow = 'MULTICC · 本轮结果';
    title = integration != null ? '本轮成功，交付记录已保存' : '本轮成功，任务仍保持当前归属';
    text = integration != null
        ? '代码交付与任务生命周期分别记录；完成一轮不会自动勾掉任务。'
        : '如果包含代码修改，仍需按项目流程完成交付。';
  } else {
    eyebrow = unstartedPlan ? 'MULTICC · 计划任务' : 'MULTICC · 等待下一步';
    title = unstartedPlan ? '计划尚未执行' : '任务已就绪';
    text = unstartedPlan
        ? '任务说明与验收标准已保存在计划卡中；发送第一条消息后才开始执行。'
        : '新消息将继续发送到当前任务；首次执行时才会准备所需工作目录。';
  }

  return AirDeliveryCopy(
    eyebrow: eyebrow,
    title: title,
    text: text,
    steps: steps,
  );
}

/// 详情面板里的一组「标题 + 若干键值行」（Web `detailGroup`）。
class AirDetailGroup {
  const AirDetailGroup({required this.title, required this.rows, this.footer});

  final String title;
  final List<(String, String)> rows;
  final Widget? footer;
}

List<AirDetailGroup> airDetailGroups(Map<String, dynamic> value) {
  final attribution =
      (value['attribution'] as Map?)?.cast<String, dynamic>() ?? const {};
  final run = attribution['run'] as Map?;
  final integration = attribution['integration'] as Map?;
  final barrier = attribution['barrier'] as Map?;
  final application = attribution['application'] as Map?;
  final separation = attribution['separation'] as Map?;
  final resource =
      (value['resource'] as Map?)?.cast<String, dynamic>() ?? const {};
  final task = (value['task'] as Map?)?.cast<String, dynamic>() ?? const {};
  final bindings = value['roleBindings'] as Map?;
  final configuration =
      (value['configuration'] as Map?)?.cast<String, dynamic>() ?? const {};

  final attached = ((bindings?['bindings'] as List?) ?? const [])
      .map((b) => '${(b as Map)['name']}')
      .join('、');
  final roleText = bindings != null
      ? '${attached.isEmpty ? '无附加角色' : attached} · 版本 ${bindings['version']}'
      : '${configuration['rolePresetId'] ?? '本任务配置'}';

  // 归属建议被挡在哪：这一组回答的是「为什么还没归过去」。
  final blockers = <String>[
    ...((attribution['blockers'] as List?) ??
            ((attribution['candidate'] as Map?)?['blockers'] as List?) ??
            const [])
        .map((r) => airBlockerNames['$r'] ?? '$r'),
  ];

  final plan = task['description'] != null || task['acceptanceCriteria'] != null
      ? _PlanCopy(
          description: task['description']?.toString(),
          acceptance: task['acceptanceCriteria']?.toString(),
        )
      : null;

  return [
    AirDetailGroup(
      title: '计划与任务生命周期',
      rows: [
        ('任务 ID', '${task['id'] ?? ''}'),
        ('任务类型', task['recordType'] == 'planned' ? '计划任务' : '执行任务'),
        (
          '工作阶段',
          task['recordType'] == 'planned'
              ? (airLabel(task['workflowStage']?.toString()).isEmpty
                    ? '待处理'
                    : airLabel(task['workflowStage']?.toString()))
              : '—',
        ),
        ('任务状态', airLabel((task['status'] ?? value['status'])?.toString())),
        ('访问方式', value['readOnly'] == true ? '只读；可显式 fork' : '可继续执行'),
      ],
      footer: plan,
    ),
    AirDetailGroup(
      title: '代码与交付',
      rows: [
        (
          '本轮结果',
          run != null
              ? '${airLabel(run['outcome']?.toString())}${run['pendingInput'] == true ? ' · 等待回答' : ''}'
              : '尚无已核验的本轮结果',
        ),
        ('代码版本', run?['codeObserved'] == true ? '已观测最终版本' : '尚未核实'),
        (
          '交付状态',
          integration != null
              ? (integration['baselineCurrent'] == true
                    ? '已合入基分支，版本有效'
                    : '有合并记录，等待重新核验')
              : '尚无覆盖本轮代码的合并凭证',
        ),
        ('源现场', barrier != null ? '写入者已停止，最终版本已锁定' : '尚无可验证的停写屏障'),
        (
          '任务归属',
          application != null
              ? '分离已生效 · ${separation?['targetTaskId'] ?? ''}'
              : separation?['state'] == 'kept'
              ? '已选择保留在当前任务'
              : separation != null
              ? '独立任务尚未生效'
              : (attribution['steps'] as List?)?.elementAtOrNull(
                      3,
                    )?['status'] ==
                    'done'
              ? '准入时已锁定当前任务'
              : '尚未核验',
        ),
      ],
      footer: blockers.isEmpty ? null : _BlockerList(blockers: blockers),
    ),
    AirDetailGroup(
      title: '角色与上下文',
      rows: [
        ('角色附件', roleText),
        ('生效边界', '修改只影响下一条新消息'),
        ('原生上下文', '角色变化时续接任务历史，不更换工作区'),
      ],
    ),
    AirDetailGroup(
      title: '执行资源',
      rows: [
        ('目录', '${resource['path'] ?? '首次执行时准备'}'),
        ('分支', '${resource['branch'] ?? '尚未创建'}'),
        ('资源状态', airResourceText(resource)),
        ('运行来源', '${value['sessionId'] ?? ''}'),
      ],
    ),
  ];
}

class _PlanCopy extends StatelessWidget {
  const _PlanCopy({this.description, this.acceptance});

  final String? description;
  final String? acceptance;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (description != null && description!.isNotEmpty) ...[
          const _Strong('任务说明'),
          Text(description!, style: _bodyStyle),
        ],
        if (acceptance != null && acceptance!.isNotEmpty) ...[
          const SizedBox(height: 8),
          const _Strong('验收标准'),
          Text(acceptance!, style: _bodyStyle),
        ],
      ],
    ),
  );
}

class _BlockerList extends StatelessWidget {
  const _BlockerList({required this.blockers});

  final List<String> blockers;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final blocker in blockers)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('· ', style: _bodyStyle),
                Expanded(child: Text(blocker, style: _bodyStyle)),
              ],
            ),
          ),
      ],
    ),
  );
}

class _Strong extends StatelessWidget {
  const _Strong(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 2),
    child: Text(
      text,
      style: const TextStyle(
        color: AppColors.text,
        fontSize: 12.5,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

const _bodyStyle = TextStyle(
  color: AppColors.muted,
  fontSize: 12.5,
  height: 1.7,
);

/// 任务详情面板（Web `#task-details`）：一张交付卡 + 四组明细 + 该任务能做的动作。
///
/// 它自己拉 `GET /api/air/tasks/:id` —— 面板上的每一句都来自那次响应里的
/// `attribution` / `execution` / `resource`，任务行上那份 `/api/air` 快照没有这些。
class AirTaskDetailsPanel extends StatefulWidget {
  const AirTaskDetailsPanel({
    super.key,
    required this.taskId,
    required this.service,
    this.onOpenConversation,
    this.onOpenSeparatedTask,
    this.directories = const <AirDirectory>[],
    this.dirId,
    this.onTaskChanged,
    this.onTaskMoved,
    this.onTaskRemoved,
  });

  final String taskId;
  final AirService service;

  /// 「进入对话」：面板是浮在首页上的一层，进去之后由宿主决定去哪。
  final VoidCallback? onOpenConversation;

  /// 分离 saga 已有 application receipt 时，宿主可直接打开目标任务。
  final ValueChanged<String>? onOpenSeparatedTask;

  /// 「移动到其他目录…」的候选。Web 是 `data.directories` 去掉当前目录
  /// （`public/air.js` 的 `openMoveDialog`），所以宿主把整份目录表给它即可。
  final List<AirDirectory> directories;

  /// 这条任务现在挂在哪个目录，用来把自己从移动候选里剔掉。空串代表宿主不知道
  /// （直接构造面板的测试）—— 那时候选就是全部目录。
  final String? dirId;

  /// 归档 / 恢复之后：任务还在原地，宿主刷一次快照就够。
  final VoidCallback? onTaskChanged;

  /// 移动之后：任务已经不在这个目录，宿主得换到 [dirId] 再打开它（Web 的
  /// `navigate(chosen, taskId)` 也是这个意思）。
  final ValueChanged<String>? onTaskMoved;

  /// 删除之后：这条任务没了，宿主只应关掉面板并刷新。
  final VoidCallback? onTaskRemoved;

  @override
  State<AirTaskDetailsPanel> createState() => _AirTaskDetailsPanelState();
}

class _AirTaskDetailsPanelState extends State<AirTaskDetailsPanel> {
  Map<String, dynamic>? _value;
  String _error = '';
  bool _loading = true;
  bool _working = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final value = await widget.service.taskDetails(widget.taskId);
      if (mounted) setState(() => _value = value);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 合并记录重新核验。归属本身仍以完整交付条件为准 —— 这个按钮只刷新「交付到
  /// 哪儿了」这条记录，不搬任务。
  Future<void> _reconcile() async {
    if (_working) return;
    setState(() => _working = true);
    try {
      await widget.service.reconcileDelivery(widget.taskId);
      await _load();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('合并记录已重新核验；任务归属仍以完整交付条件为准。')),
        );
      }
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  /// 编辑这个任务的角色上下文。版本号取自面板刚读到的那一份 —— 保存时带上它，
  /// 才能发现「别的页面已经改过了」，而不是把别人的修改盖掉。
  Future<void> _editRoles() async {
    final value = _value;
    if (value == null) return;
    final bindings = AirRoleBindings.fromJson(
      (value['roleBindings'] as Map?)?.cast<String, dynamic>(),
    );
    await showAirRoleEditor(
      context,
      settings: widget.service.settings,
      service: widget.service,
      taskId: widget.taskId,
      version: bindings.version,
      initial: bindings.bindings,
      onSaved: _load,
    );
  }

  /// 服务端认定的任务生命周期状态。`done` / `archived` 是终态那两位，
  /// 「归档 / 恢复」按钮翻的就是它 —— Web 读的是同一处的 `value.task.status
  /// || value.status`（`public/air.js` 的 `renderDetail`）。
  String get _lifecycleStatus =>
      '${(_value?['task'] as Map?)?['status'] ?? _value?['status'] ?? ''}';

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  /// 生命周期动作的统一外壳：按住的这段时间禁用整条动作栏，失败时把服务端的
  /// 错误码翻成中文（[airTaskActionErrors]）而不是丢一句 HTTP 状态。
  ///
  /// [failure] 只在动作失败时被叫到，用来把「面板刷新不出来了」这类二次故障
  /// 也说出来 —— 成功路径各自处理，因为它们要刷新的东西不一样。
  Future<void> _runTaskAction(Future<void> Function() action) async {
    if (_working) return;
    setState(() => _working = true);
    try {
      await action();
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  /// 归档 / 恢复。Web 这两步不做二次确认 —— 状态随时能翻回去，真正不可逆的
  /// 只有删除。
  Future<void> _toggleArchive() async {
    final archive = _lifecycleStatus != 'archived';
    await _runTaskAction(() async {
      await widget.service.setTaskLifecycle(
        widget.taskId,
        archive ? 'archived' : 'active',
      );
      await _load();
      _toast(archive ? '任务已归档；归档的任务不再执行，随时可以恢复。' : '任务已恢复。');
      widget.onTaskChanged?.call();
    });
  }

  /// 移动到其他目录。Web 的对话框是一组单选（`openMoveDialog`），这里用同一份
  /// 结构；移动成功之后这条任务已经不属于当前目录，交给宿主跟着挪过去。
  Future<void> _moveTask() async {
    final targets = widget.directories
        .where((directory) => directory.id != widget.dirId)
        .toList();
    if (targets.isEmpty) {
      _toast('还没有其他工作目录可以移动。');
      return;
    }
    final title = '${(_value?['task'] as Map?)?['title'] ?? widget.taskId}';
    final chosen = await showDialog<String>(
      context: context,
      builder: (dialogContext) =>
          _MoveTaskDialog(title: title, targets: targets),
    );
    if (chosen == null || !mounted) return;
    await _runTaskAction(() async {
      final result = await widget.service.relocateTask(widget.taskId, chosen);
      final carried = result['carried'] is Map
          ? Map<String, dynamic>.from(result['carried'] as Map)
          : const <String, dynamic>{};
      final files = carried['files'];
      AirDirectory? target;
      for (final directory in targets) {
        if (directory.id == chosen) target = directory;
      }
      _toast(
        '任务已移动到 ${target?.name ?? '目标目录'}'
        '${carried.isEmpty ? '' : '；已带走未提交改动${files == null ? '' : '和 $files 个新文件'}'}。',
      );
      widget.onTaskMoved?.call(chosen);
    });
  }

  /// 删除任务。文案逐字对着 Web 的 `window.confirm` 抄：它把「会连会话和工作区
  /// 一起删」和「什么时候会被拒绝」都写在同一句话里，比一个「确定吗」有用。
  Future<void> _deleteTask() async {
    final title = '${(_value?['task'] as Map?)?['title'] ?? widget.taskId}';
    if (_working) return;
    setState(() => _working = true);
    final deleted = await deleteAirTaskWithConfirmation(
      context: context,
      service: widget.service,
      taskId: widget.taskId,
      title: title,
      keyPrefix: 'air-details',
      onError: (error) {
        if (mounted) setState(() => _error = '$error');
      },
    );
    if (mounted) setState(() => _working = false);
    if (deleted) widget.onTaskRemoved?.call();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _value == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final value = _value;
    if (value == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _error.isEmpty ? '无法读取任务详情。' : _error,
            textAlign: TextAlign.center,
            style: const TextStyle(color: AppColors.muted, fontSize: 13),
          ),
        ),
      );
    }

    final copy = airDeliveryCopy(value);
    final groups = airDetailGroups(value);
    final integration = (value['attribution'] as Map?)?['integration'] != null;
    final separation = (value['attribution'] as Map?)?['separation'] as Map?;
    final separatedTaskId =
        separation != null && separation['state'] == 'separated'
        ? separation['targetTaskId']?.toString()
        : null;
    final title = '${(value['task'] as Map?)?['title'] ?? '任务详情'}';

    return ListView(
      key: const ValueKey('air-details-panel'),
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                '任务详情',
                style: TextStyle(
                  color: AppColors.text,
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            if (widget.onOpenConversation != null)
              TextButton.icon(
                key: const ValueKey('air-details-open-conversation'),
                onPressed: widget.onOpenConversation,
                icon: const Icon(Icons.forum_outlined, size: 18),
                label: const Text('进入对话'),
              ),
          ],
        ),
        if (_error.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Text(
              _error,
              style: const TextStyle(color: AppColors.danger, fontSize: 12.5),
            ),
          ),
        // 「本轮 … · 任务 …」：交付卡说的是这一轮能拿什么结论，这一行说的是它现在
        // 处于哪一步 —— 两句话各自回答不同的问题（同 Web 页头那行状态）。
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Text(
            airTaskStateSegments(value).join(' · '),
            key: const ValueKey('air-details-state'),
            style: const TextStyle(color: AppColors.muted, fontSize: 12.5),
          ),
        ),
        _DeliveryCard(
          copy: copy,
          title: title,
          onReconcile: integration ? _reconcile : null,
          onOpenSeparatedTask:
              separatedTaskId != null && separatedTaskId != widget.taskId
              ? () => widget.onOpenSeparatedTask?.call(separatedTaskId)
              : null,
          busy: _working,
        ),
        // 观察来的（只读）任务没有自己的角色，也就没什么可编辑的。
        if (value['roleBindings'] != null && value['readOnly'] != true)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                key: const ValueKey('air-details-edit-roles'),
                onPressed: _working ? null : _editRoles,
                icon: const Icon(Icons.badge_outlined, size: 17),
                label: const Text('编辑角色上下文'),
              ),
            ),
          ),
        // 任务生命周期动作条 —— Web `renderDetail` 最后那一组 `detail-actions`：
        // 归档/恢复、移动到其他目录…、删除任务…。三者的顺序和「哪些要确认」
        // 都照 Web：只有删除不可逆，所以只有它拦一道。
        _LifecycleActions(
          archived: _lifecycleStatus == 'archived',
          readOnly: value['readOnly'] == true,
          canMove: widget.directories.any(
            (directory) => directory.id != widget.dirId,
          ),
          busy: _working,
          onArchive: _toggleArchive,
          onMove: _moveTask,
          onDelete: _deleteTask,
        ),
        const SizedBox(height: 18),
        for (final group in groups) ...[
          _DetailGroupView(group: group),
          const SizedBox(height: 14),
        ],
      ],
    );
  }
}

class _DeliveryCard extends StatelessWidget {
  const _DeliveryCard({
    required this.copy,
    required this.title,
    required this.onReconcile,
    required this.onOpenSeparatedTask,
    required this.busy,
  });

  final AirDeliveryCopy copy;
  final String title;
  final VoidCallback? onReconcile;
  final VoidCallback? onOpenSeparatedTask;
  final bool busy;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('air-delivery-card'),
    decoration: BoxDecoration(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusPanel),
      border: Border.all(color: AppColors.line),
    ),
    padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          copy.eyebrow,
          style: const TextStyle(
            color: AppColors.faint,
            fontSize: 10.5,
            letterSpacing: 0.6,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 5),
        Text(
          copy.title,
          key: const ValueKey('air-delivery-title'),
          style: const TextStyle(
            color: AppColors.text,
            fontSize: 15.5,
            fontWeight: FontWeight.w600,
            height: 1.4,
          ),
        ),
        const SizedBox(height: 5),
        Text(copy.text, style: _bodyStyle),
        const SizedBox(height: 11),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final entry in copy.steps.asMap().entries)
              _DeliveryStep(
                label: entry.value.label,
                status: entry.value.status,
                current:
                    entry.value.status == 'pending' &&
                    copy.steps
                        .take(entry.key)
                        .every(
                          (step) =>
                              const {'done', 'skipped'}.contains(step.status),
                        ),
              ),
          ],
        ),
        const SizedBox(height: 11),
        Text('下一条消息仍发送到「$title」', style: _bodyStyle),
        if (onReconcile != null) ...[
          const SizedBox(height: 8),
          OutlinedButton(
            key: const ValueKey('air-delivery-reconcile'),
            onPressed: busy ? null : onReconcile,
            child: Text(busy ? '正在核验…' : '重新核验交付'),
          ),
        ],
        if (onOpenSeparatedTask != null) ...[
          const SizedBox(height: 8),
          FilledButton.tonal(
            key: const ValueKey('air-delivery-open-separated'),
            onPressed: busy ? null : onOpenSeparatedTask,
            child: const Text('打开独立任务'),
          ),
        ],
      ],
    ),
  );
}

class _DeliveryStep extends StatelessWidget {
  const _DeliveryStep({
    required this.label,
    required this.status,
    required this.current,
  });

  final String label;
  final String status;
  final bool current;

  @override
  Widget build(BuildContext context) {
    final color = status == 'done'
        ? AppColors.success
        : status == 'blocked'
        ? AppColors.danger
        : status == 'skipped'
        ? AppColors.faint
        : current
        ? AppColors.accent
        : AppColors.faint;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(
          alpha: status == 'skipped' || status == 'pending' && !current
              ? 0.05
              : 0.10,
        ),
        borderRadius: BorderRadius.circular(AppColors.radiusPill),
        border: Border.all(color: color.withValues(alpha: 0.30)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: status == 'skipped' || status == 'pending' && !current
              ? FontWeight.w400
              : FontWeight.w600,
        ),
      ),
    );
  }
}

class _DetailGroupView extends StatelessWidget {
  const _DetailGroupView({required this.group});

  final AirDetailGroup group;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: AppColors.panel,
      borderRadius: BorderRadius.circular(AppColors.radiusCard),
      border: Border.all(color: AppColors.line),
    ),
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          group.title,
          style: const TextStyle(
            color: AppColors.text,
            fontSize: 13.5,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 8),
        for (final row in group.rows)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(width: 76, child: Text(row.$1, style: _bodyStyle)),
                Expanded(
                  child: Text(
                    row.$2.isEmpty ? '—' : row.$2,
                    style: const TextStyle(
                      color: AppColors.text,
                      fontSize: 12.5,
                      height: 1.7,
                    ),
                  ),
                ),
              ],
            ),
          ),
        if (group.footer != null) group.footer!,
      ],
    ),
  );
}

/// 详情面板底部那组生命周期动作（Web `detail-actions`）。
///
/// 「移动」在只读任务上没有（Web 的 `if (!value.readOnly)` 才 append），「删除」
/// 永远在 —— 观察来的任务也能从自己列表里删掉。「没有别的目录可去」时移动按钮
/// 直接不出现，而不是点了才说不行：Web 是点了才提示，但手机上没有 hover，一颗
/// 永远点不动、只能换来一句抱歉的按钮更差。
class _LifecycleActions extends StatelessWidget {
  const _LifecycleActions({
    required this.archived,
    required this.readOnly,
    required this.canMove,
    required this.busy,
    required this.onArchive,
    required this.onMove,
    required this.onDelete,
  });

  final bool archived;
  final bool readOnly;
  final bool canMove;
  final bool busy;
  final VoidCallback onArchive;
  final VoidCallback onMove;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 10),
    child: Wrap(
      spacing: 8,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        OutlinedButton.icon(
          key: const ValueKey('air-details-archive'),
          onPressed: busy ? null : onArchive,
          icon: Icon(
            archived ? Icons.unarchive_outlined : Icons.archive_outlined,
            size: 17,
          ),
          label: Text(archived ? '恢复任务' : '归档任务'),
        ),
        if (!readOnly && canMove)
          OutlinedButton.icon(
            key: const ValueKey('air-details-move'),
            onPressed: busy ? null : onMove,
            icon: const Icon(Icons.drive_file_move_outline, size: 17),
            label: const Text('移动到其他目录…'),
          ),
        OutlinedButton.icon(
          key: const ValueKey('air-details-delete'),
          onPressed: busy ? null : onDelete,
          icon: const Icon(Icons.delete_outline, size: 17),
          label: const Text('删除任务…', style: TextStyle(color: AppColors.danger)),
        ),
      ],
    ),
  );
}

/// 移动任务的目录选择（Web `openMoveDialog` 的那张单选框列表）。
///
/// 用 `showDialog<String>` 返回选中的 dirId：null 代表取消。文案也照抄 —— 它
/// 说清了「工作区会迁到目标仓库，未提交的改动和新文件一起带走」，以及正在执行
/// 的任务服务端会拒。
class _MoveTaskDialog extends StatefulWidget {
  const _MoveTaskDialog({required this.title, required this.targets});

  final String title;
  final List<AirDirectory> targets;

  @override
  State<_MoveTaskDialog> createState() => _MoveTaskDialogState();
}

class _MoveTaskDialogState extends State<_MoveTaskDialog> {
  String? _chosen;

  @override
  Widget build(BuildContext context) => AlertDialog(
    key: const ValueKey('air-details-move-dialog'),
    title: Text('移动「${widget.title}」'),
    content: SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            '选择目标工作目录。工作区会迁到目标仓库，未提交的改动和新文件一起带走；正在执行的任务不能移动。',
            style: TextStyle(
              color: AppColors.muted,
              fontSize: 12.5,
              height: 1.6,
            ),
          ),
          const SizedBox(height: 6),
          for (final directory in widget.targets)
            RadioListTile<String>(
              key: ValueKey('air-details-move-target-${directory.id}'),
              value: directory.id,
              groupValue: _chosen,
              onChanged: (value) => setState(() => _chosen = value),
              contentPadding: EdgeInsets.zero,
              dense: true,
              title: Text(
                directory.name,
                style: const TextStyle(fontSize: 13.5),
              ),
              subtitle: Text(
                directory.path,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11.5, color: AppColors.faint),
              ),
            ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('取消'),
      ),
      TextButton(
        key: const ValueKey('air-details-move-confirm'),
        onPressed: _chosen == null
            ? null
            : () => Navigator.of(context).pop(_chosen),
        child: const Text('移动', style: TextStyle(color: AppColors.accentDark)),
      ),
    ],
  );
}
