import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../theme.dart';
import 'air_role_editor.dart';

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
    required this.stage,
    required this.currentStep,
  });

  final String eyebrow;
  final String title;
  final String text;

  /// 走完了 4 步里的几步：本轮成功 → 代码交付 → 源现场稳定 → 归属生效。
  final int stage;
  final bool currentStep;
}

const List<String> airDeliverySteps = ['本轮成功', '代码交付', '源现场稳定', '归属生效'];

AirDeliveryCopy airDeliveryCopy(Map<String, dynamic> value) {
  final attribution =
      (value['attribution'] as Map?)?.cast<String, dynamic>() ?? const {};
  final candidate = attribution['candidate'] as Map?;
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
  final targetTitle = '${candidate?['title'] ?? candidate?['taskName'] ?? '建议任务'}';

  var eyebrow = 'MULTICC · 本轮状态';
  var title = '本轮状态已记录';
  var text = '任务保持当前归属，可以继续输入下一步。';
  var stage = 0;
  var currentStep = false;
  if (run?['outcome'] == 'succeeded' && run?['pendingInput'] != true) stage = 1;
  if (integration != null) stage = 2;
  if (integration?['baselineCurrent'] == true) stage = 3;

  if (capacity != null && capacity.isNotEmpty) {
    eyebrow = 'MULTICC · 执行资源';
    title = '${airLabel(capacity)} · 现有工作现场正在保留';
    text = '消息已绑定当前任务；资源可用后继续，不会停止其他服务或删除未交付修改。';
  } else if (pending) {
    eyebrow = 'MULTICC · 等待回答';
    title = '本轮需要你的回答';
    text = '回答仍提交给原任务与原请求，不会因为归属建议改变目标。';
  } else if (candidate?['state'] == 'stale') {
    eyebrow = 'MULTICC · 归属建议未应用';
    title = '本次归属建议已过期';
    text = '你已继续输入或切换视图，迟到的分类与合并事件不会改投已经接受的消息。';
  } else if (candidate != null && running) {
    eyebrow = 'MULTICC · 本轮执行中';
    title = '归属将在本轮交付后确认';
    text = '可能关联「$targetTitle」，当前仍在「$currentTitle」中执行。';
    currentStep = true;
  } else if (candidate != null &&
      (run?['outcome'] != 'succeeded' || run?['pendingInput'] == true)) {
    eyebrow = 'MULTICC · 尚未满足归属条件';
    title = '本轮未成功或仍需回答';
    text = '建议目标仍是「$targetTitle」，原问题继续绑定当前任务。';
    currentStep = true;
  } else if (candidate != null && integration == null) {
    eyebrow = 'MULTICC · 本轮成功，等待交付';
    title = '建议归入「$targetTitle」';
    text = '执行成功不等于任务完成或归属生效；相关代码按项目流程交付后再核验。';
    currentStep = true;
  } else if (candidate != null &&
      integration != null &&
      integration['baselineCurrent'] != true) {
    eyebrow = 'MULTICC · 交付记录待核验';
    title = '建议归入「$targetTitle」';
    text = '已有合并记录，但基分支状态发生变化；重新核验前保持当前任务。';
    currentStep = true;
  } else if (candidate != null) {
    eyebrow = 'MULTICC · 交付已核验';
    title = '建议归入「$targetTitle」· 等待源现场稳定';
    text = '代码交付已核验；持续停写屏障与原子归属尚未完成，不提前转移工作区或消息。';
    currentStep = true;
  } else if (running) {
    eyebrow = 'MULTICC · 本轮执行中';
    title = '任务正在当前工作目录执行';
    text = '本轮结果、代码交付与任务完成会分别记录；执行期间下一条消息仍发送到当前任务。';
    currentStep = true;
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
    stage: stage,
    currentStep: currentStep,
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
  final candidate = attribution['candidate'] as Map?;
  final blockers = <String>[
    if (candidate != null)
      ...(((candidate['blockers'] ?? attribution['blockers']) as List?) ?? const [])
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
      ],
      footer: blockers.isEmpty
          ? null
          : _BlockerList(blockers: blockers),
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
  });

  final String taskId;
  final AirService service;

  /// 「进入对话」：面板是浮在首页上的一层，进去之后由宿主决定去哪。
  final VoidCallback? onOpenConversation;

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
          const SnackBar(
            content: Text('合并记录已重新核验；任务归属仍以完整交付条件为准。'),
          ),
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
    required this.busy,
  });

  final AirDeliveryCopy copy;
  final String title;
  final VoidCallback? onReconcile;
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
            for (var i = 0; i < airDeliverySteps.length; i++)
              _DeliveryStep(
                label: airDeliverySteps[i],
                done: i < copy.stage,
                current: copy.currentStep && i == copy.stage,
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
      ],
    ),
  );
}

class _DeliveryStep extends StatelessWidget {
  const _DeliveryStep({
    required this.label,
    required this.done,
    required this.current,
  });

  final String label;
  final bool done;
  final bool current;

  @override
  Widget build(BuildContext context) {
    final color = done
        ? AppColors.success
        : current
        ? AppColors.accent
        : AppColors.faint;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: done || current ? 0.10 : 0.05),
        borderRadius: BorderRadius.circular(AppColors.radiusPill),
        border: Border.all(color: color.withValues(alpha: 0.30)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: done || current ? FontWeight.w600 : FontWeight.w400,
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
                SizedBox(
                  width: 76,
                  child: Text(row.$1, style: _bodyStyle),
                ),
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
