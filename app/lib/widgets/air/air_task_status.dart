/// Air 侧「这条任务算什么、在不在跑」的唯一判定 —— 对应 Web
/// `public/air-admin.js` 顶部那一段（`taskStatus` / `isRunning` /
/// `taskUrgency` / `taskDetail`）。
///
/// 判定权不在这一层，在 `utils/status_presentation.dart` 的
/// `statusPresentation`：那边只给 running 设了 spinner，于是「出错的任务绝不动
/// 画」是一条规则，而不是每个用到状态的地方各判一遍。侧栏、任务行、控制台统计
/// 都从这里取值，所以同一条任务在两个地方不可能显示成两种状态。
library;

import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../utils/status_presentation.dart';

/// 生命周期（archived/done）优先，其次是这一轮的 [AirTask.runState]。
CanonicalStatus airTaskStatus(AirTask task) =>
    taskStatusOf(status: task.status, runState: task.runState);

StatusSpec airTaskSpec(AirTask task) =>
    statusSpecOf(StatusDomain.task, airTaskStatus(task));

/// Air 面上每个状态叫什么 —— 逐条对着 Web `public/air-admin.js` 的 `STATUS_COPY`。
///
/// 为什么不直接用注册表的 `labelKey`（App 词典里 running 是「进行中」、waiting 是
/// 「等待中」）：Web 的 Air 面自带一份中文（`air.html` 里没有 t()，`air.js` 的
/// `label()` 查的也是这份 Air 词表），说的是跟阶段、资源去向（[airLabel]）同源的那
/// 套词。两套词混着用，同一行就会冒出两个词说同一件事 —— 徽标写「进行中」、旁边那
/// 行写「执行中」，读的人得先猜它们是不是一回事。
const Map<CanonicalStatus, String> airStatusCopy = {
  CanonicalStatus.idle: '空闲',
  CanonicalStatus.queued: '排队中',
  CanonicalStatus.running: '执行中',
  CanonicalStatus.waiting: '等待回答',
  CanonicalStatus.blocked: '等待配置',
  CanonicalStatus.error: '执行异常',
  CanonicalStatus.succeeded: '执行成功',
  CanonicalStatus.done: '已完成',
  CanonicalStatus.cancelled: '已取消',
  CanonicalStatus.archived: '已归档',
  CanonicalStatus.offline: '已离线',
  CanonicalStatus.unknown: '状态未知',
};

/// Air 面上的状态词。兜底是原样的状态名，同 Web 的 `STATUS_COPY[status] || status`。
String airStatusLabel(CanonicalStatus status) =>
    airStatusCopy[status] ?? status.name;

/// Air 面的状态徽标：词走 [airStatusCopy]，可见文案和无障碍名是同一个词（同 Web
/// `statusBadge()` 那句「translate 恒等于可见文案」）。侧栏的任务行、目录首页的
/// 任务卡都从这里取，所以一条任务在两个地方不可能写成两种状态。
class AirTaskStatusBadge extends StatelessWidget {
  const AirTaskStatusBadge({
    super.key,
    required this.task,
    this.fontSize = 10.5,
    this.dense = false,
  });

  final AirTask task;
  final double fontSize;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final status = airTaskStatus(task);
    final word = airStatusLabel(status);
    return StatusBadge(
      domain: StatusDomain.task,
      status: status,
      label: word,
      semanticLabel: word,
      fontSize: fontSize,
      dense: dense,
    );
  }
}

String airWorktreeChangeLabel(AirTask task) {
  final changes = task.worktreeChanges;
  if (changes == null || !changes.pending) return '';
  if (changes.dirty && changes.ahead > 0) {
    return 'Worktree 有未提交改动，另有 ${changes.ahead} 个提交尚未合并';
  }
  if (changes.dirty) return 'Worktree 有未提交改动';
  return 'Worktree 有 ${changes.ahead} 个提交尚未合并';
}

/// Web `.worktree-change-badge` 的 App 对位件：静态琥珀色分支图标，tooltip 与
/// 无障碍名区分「未提交」和「已提交但未合回」。不做常驻动画。
class AirWorktreeChangeBadge extends StatelessWidget {
  const AirWorktreeChangeBadge({super.key, required this.task});

  final AirTask task;

  @override
  Widget build(BuildContext context) {
    final label = airWorktreeChangeLabel(task);
    if (label.isEmpty) return const SizedBox.shrink();
    return Tooltip(
      message: label,
      child: Semantics(
        label: label,
        image: true,
        child: Container(
          key: ValueKey('air-worktree-change-${task.id}'),
          width: 18,
          height: 18,
          decoration: BoxDecoration(
            color: const Color(0xfffff7df),
            border: Border.all(color: const Color(0xffe8c982)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: const Icon(
            Icons.merge_type_rounded,
            size: 13,
            color: Color(0xff98630c),
          ),
        ),
      ),
    );
  }
}

/// 只有注册表说 spinner 的状态才配转圈 —— 「在跑」全局只有这一个定义，所以这
/// 里不写 `runState == 'running'`。
bool airTaskRunning(AirTask task) => airTaskSpec(task).spinner;

/// 有任务正在执行的目录。目录行上那个「有活在跑」的标记用它。
Set<String> airRunningDirectories(Iterable<AirTask> tasks) => {
  for (final task in tasks)
    if (airTaskRunning(task)) task.dirId,
};

/// 租约已经交出去的状态：这些阶段任务还没跑起来，但名额已经不在池子里了，
/// 对读者就是「它正在被处理」。
const Set<String> airRunningLeases = {
  'reserved',
  'materializing',
  'starting',
  'running',
  'uncertain',
};

/// 「谁在等我」的分级权重，越小越急：
/// 等我回答 → 出错要我去处理 → 卡在资源 → 正在跑。故障排在任何乐观信号前面。
///
/// 这份权重只用来判断「算不算在等我」（见 [airNeedsAttention]），不再决定谁排
/// 在前面 —— 排序是纯时间，和 Web 一致。
int airTaskUrgency(AirTask task) {
  final status = airTaskStatus(task);
  if (status == CanonicalStatus.waiting) return 0;
  if (status == CanonicalStatus.error) return 1;
  final capacity = task.resource['capacityReason']?.toString() ?? '';
  if (capacity.isNotEmpty) return 2;
  if (status == CanonicalStatus.running ||
      airRunningLeases.contains(task.resource['lease']?.toString())) {
    return 3;
  }
  if (status == CanonicalStatus.done || status == CanonicalStatus.archived) {
    return 5;
  }
  return 4;
}

/// 「在等我」的分界线：0 等我回答 · 1 出错要我去处理 · 2 卡在资源 —— 这三类都得
/// 我动手。3（正在跑）不列进来：跑着的东西不是待办，它不需要我操作。控制台那张
/// 「等待处理」统计卡走的是同一条线，两处口径必须一致。
bool airNeedsAttention(AirTask task) => airTaskUrgency(task) < 3;

/// 跨所有目录、需要我动手的任务。这条信号原来由侧栏的「跨目录活动」承担，现在
/// 是控制台的第一个分区，也是侧栏入口上的那个数字 —— 一处定义，两处显示。
///
/// 顺序是纯时间倒序（最近动过的最靠前），和 Web 的 `urgentTasks` 一致：刚有动静
/// 的任务才是眼下要接手的那条。
List<AirTask> airUrgentTasks(Iterable<AirTask> tasks) =>
    tasks.where(airNeedsAttention).toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));

/// 任务行的第二层信息：状态徽标已经说了「在不在跑」，这里补记录类型、阶段和
/// 资源去向（同 Web 的 `taskDetail`）。
///
/// 阶段（看板那一列）只有计划记录才有 —— `workflowStage` 是那类记录自己的字段，
/// 观察型记录（从对话里长出来的任务）永远是 null。所以不要拿 `status` 兜底：它是
/// 生命周期（active/done/archived），跟「在不在跑」无关，翻出来是「进行中」，
/// 而同一行上的徽标正说着「空闲」/「执行成功」—— 一行话自相矛盾。Web 的侧栏
/// （`public/air.js` 的 `renderSidebarTasks`）早就是这个规矩：非计划记录不出阶段词。
String airTaskDetail(AirTask task) {
  final stage = task.recordType == 'planned'
      ? airLabel(task.workflowStage ?? task.status)
      : '';
  final bits = <String>[if (stage.isNotEmpty) '计划 · $stage'];
  final held = task.resourceText;
  // 徽标已经说过的词不在这里再说一遍（「执行中 · 执行中」不是更多信息）——
  // 同 Web 侧栏那句 `!badgeText.includes(part)`。比的是徽标上那个词（[airStatusCopy]），
  // 不是词典里的词：一行上只有一套词的时候，这两句才真的能对上。
  final badge = airStatusLabel(airTaskStatus(task));
  if (held.isNotEmpty && held != stage && !badge.contains(held)) bits.add(held);
  return bits.join(' · ');
}

/// 行尾那个时间。Web 用的 `toLocaleString('zh-CN', {month, day, hour, minute})`
/// 出来就是 `9/13 14:05`。
///
/// [AirTask.updatedAt] 是毫秒时间戳，不是带偏移的字符串 —— 那种串交给
/// `DateTime.tryParse` 会被当 UTC，这里没这个坑。
String airTaskTime(int updatedAt) {
  if (updatedAt <= 0) return '';
  final at = DateTime.fromMillisecondsSinceEpoch(updatedAt).toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  return '${at.month}/${at.day} ${two(at.hour)}:${two(at.minute)}';
}
