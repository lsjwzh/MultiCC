/// Air 侧「这条任务算什么、在不在跑」的唯一判定 —— 对应 Web
/// `public/air-admin.js` 顶部那一段（`taskStatus` / `isRunning` /
/// `taskUrgency` / `taskDetail`）。
///
/// 判定权不在这一层，在 `utils/status_presentation.dart` 的
/// `statusPresentation`：那边只给 running 设了 spinner，于是「出错的任务绝不动
/// 画」是一条规则，而不是每个用到状态的地方各判一遍。侧栏、任务行、控制台统计
/// 都从这里取值，所以同一条任务在两个地方不可能显示成两种状态。
library;

import '../../services/air_service.dart';
import '../../utils/status_presentation.dart';

/// 生命周期（archived/done）优先，其次是这一轮的 [AirTask.runState]。
CanonicalStatus airTaskStatus(AirTask task) =>
    taskStatusOf(status: task.status, runState: task.runState);

StatusSpec airTaskSpec(AirTask task) =>
    statusSpecOf(StatusDomain.task, airTaskStatus(task));

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

/// 「谁在等我」的排序权重，越小越急：
/// 等我回答 → 出错要我去处理 → 卡在资源 → 正在跑。故障排在任何乐观信号前面。
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

/// 跨所有目录、正在跑或等着我的任务。这条信号原来由侧栏的「跨目录活动」承担，
/// 现在是控制台的第一个分区，也是侧栏入口上的那个数字 —— 一处定义，两处显示。
List<AirTask> airUrgentTasks(Iterable<AirTask> tasks) =>
    tasks.where((task) => airTaskUrgency(task) < 4).toList()
      ..sort((a, b) {
        final byUrgency = airTaskUrgency(a) - airTaskUrgency(b);
        return byUrgency != 0 ? byUrgency : b.updatedAt.compareTo(a.updatedAt);
      });

/// 任务行的第二层信息：状态徽标已经说了「在不在跑」，这里补记录类型、阶段和
/// 资源去向（同 Web 的 `taskDetail`）。
String airTaskDetail(AirTask task) {
  final bits = <String>[
    if (task.recordType == 'planned') '计划',
  ];
  final stage = airLabel(task.workflowStage ?? task.status);
  if (stage.isNotEmpty) bits.add(stage);
  final held = task.resourceText;
  if (held.isNotEmpty && held != stage) bits.add(held);
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
