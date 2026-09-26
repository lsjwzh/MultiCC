// CLI 展示目录（App 侧的唯一一份）。
//
// 权威表在服务端：src/cli/cli-capability.js 的 CLIS。Web 侧镜像在
// public/provider-catalog.js，这里是 App 侧镜像；tests/test-cli-display-parity.js
// 读这三份，任何一列漂移就红。
//
// 这里【不是】CLI 的事实源 —— 车道协议、能力、是否支持 provider 都由服务端定义。
// 本文件只有「这个 id 在不同端上叫什么、什么颜色、折叠时用哪个字母」。
//
// 一张表，两层 —— 一个 CLI 是**家族**（[CliFamily] / kCliFamilies），家族在每个
// **场景**（chat / terminal）里给出一组**衍生车道**（[CliLane]）。于是「一个 CLI，
// 多种展示」是同一张表的两种读法：
//
//   claude 在 chat 里   大字 Claude、小字 Claude Agent SDK（外加一条 offered:false
//                       的 `claude -p`，chat 里不再提供它）
//   claude 在 terminal 里 `claude`（大字 Claude Code）—— 跑的就是这个可执行文件
//   对外（任务卡、线路位）只说家族名：Claude
//
// 车道的 id 永不改名（会话记录、Provider 池、wire 路由都存着它），改的只是叫法。
// kCliDisplays 是这张表摊平后的车道视图，所有既有取词都读它。
//
// 这些字面量原先散在四处，而且各写各的：message.dart 的 displayName switch、
// dashboard_screen 的两处 switch（`_ => 'Claude'`，于是 codebuddy / kimi / dsh /
// gemini / grok 在仪表盘上都显示成 Claude）、ai_config_sheet 的 _providerName、
// cron_screen 的 _cliChoice。现在都从这里取。
//
// 未知 id 一律回落成 id 本身，绝不回落成 'Claude'：把一个没见过的 CLI 标成另一个
// 产品，比显示它的内部 id 更难查。

import 'package:flutter/material.dart';

import '../theme.dart';

/// 家族在某场景里的一条衍生车道 —— 只写这个场景特有的说法。
class CliLane {
  const CliLane(this.id, {this.label, this.mark, this.engine, this.offered = true, this.deprecated = false, this.replacedBy});

  /// 车道 id，也就是会话记录里的 `cli` 字段（[SessionCli.name]）。
  final String id;

  /// 这个场景里的大字；null = 家族名（所以 chat 里两条衍生都叫 "Claude"）。
  final String? label;

  /// 这个场景里的小字；null = 车道 id。终端那条车道上，id 就是要跑的命令。
  final String? engine;

  /// 这个场景里的角标；null = 家族给的那个。
  final String? mark;

  /// 这个场景的选择器给不给这条衍生。是**策略**不是能力：`claude -p` 不是不能
  /// chat，是产品不再在 chat 里提供它。
  final bool offered;

  /// 这条衍生在这个场景里仍在用、但已在淘汰路上；[replacedBy] 是该换的那条。
  final bool deprecated;
  final String? replacedBy;
}

/// 一个 CLI 家族：对外只说一次的名字/品牌色/角标，以及它在每个场景里的衍生。
class CliFamily {
  const CliFamily(this.name, this.color, {this.mark, this.providerless = false, this.lanes = const <String, List<CliLane>>{}});

  /// 界面上显示的产品名，也是**对外**（任务卡、线路位）说的那个名字。
  final String name;

  /// 品牌色（浅色主题版本；Web 那列是深色主题的十六进制值）。
  final Color color;

  /// 折叠成一颗小徽标时用的单个字母；null = 名字首字母。
  final String? mark;

  /// 自持账号：厂商自己的账号/模型配置，不挂 MultiCC provider。
  final bool providerless;

  /// 每个场景给哪些衍生。**没写 lanes 的家族**（claude / codex 之外的全部）就是
  /// 它自己一条车道、两种场景都给。
  final Map<String, List<CliLane>> lanes;
}

/// 一个 CLI 的展示事实：名字、品牌色、折叠徽标上的字母、是否自持账号、是否在淘汰路上。
class CliDisplay {
  const CliDisplay(this.name, this.color, this.mark, {this.providerless = false, this.deprecated = false, this.replacedBy, this.engine, this.kinds = const ['chat', 'terminal']});

  /// 界面上显示的产品名（两行式 CLI 行的**大字**）。
  final String name;

  /// 品牌色（浅色主题版本；Web 那列是深色主题的十六进制值）。
  final Color color;

  /// 折叠成一颗小徽标时用的单个字母。
  final String mark;

  /// 自持账号：厂商自己的账号/模型配置，不挂 MultiCC provider。
  final bool providerless;

  /// 兜底车道，计划淘汰（服务端的 deprecated 列）。id 不会变，所以 UI 只能靠这个
  /// 标记说出「该换一条线路了」。
  final bool deprecated;

  /// 淘汰后该换成谁（非淘汰车道为 null）。
  final String? replacedBy;

  /// 两行式 CLI 行的**小字**：这条车道底下的引擎。扶正后的两条常驻车道写引擎产品名
  /// （Claude Agent SDK / Codex App Server）；为 null 时小字就是 id 本身，也就是终端
  /// 里真正要跑的命令。
  final String? engine;

  /// 这条车道能出现在哪种会话的 CLI 选择里（'chat' / 'terminal'）。是车道的事实，
  /// 不是某个界面的规矩 —— 它原先在 App 的建会话弹窗和 Air 的目录页各写了一遍，
  /// 两处已经走偏了。
  final List<String> kinds;

  /// 这条车道能不能出现在 [kind]（'chat' / 'terminal'）的 CLI 选择里。
  bool offersIn(String kind) => kinds.contains(kind.trim().toLowerCase());
}

/// 一个家族在某场景里的候选行：大小字与角标都已回落好，选择器拿到就能画。
class CliLaneView {
  const CliLaneView({required this.lane, required this.kind, required this.label, required this.engine, required this.mark, required this.color, required this.offered, required this.deprecated, this.replacedBy});

  final String lane;
  final String kind;
  final String label;
  final String engine;
  final String mark;
  final Color color;
  final bool offered;
  final bool deprecated;
  final String? replacedBy;
}

/// 家族表：一个 CLI 在每个场景里给哪些衍生。**唯一一份**。
///
/// 2026-09-26：两条常驻车道扶正为产品名，两条一次性车道退出 chat。
///
///   家族    场景       车道        大字           小字
///   claude  chat      claude-exp  Claude         Claude Agent SDK
///           chat      claude      Claude         claude -p     （offered: false）
///           terminal  claude      Claude Code    claude
///   codex   chat      codex-exp   Codex          Codex App Server
///           chat      codex       Codex          codex exec    （offered: false）
///           terminal  codex       Codex Exec     codex
///
/// `claude` 是 `claude -p`、`codex` 是 `codex exec`：chat 里已经没有它们的位置，但
/// 终端真的要把这两个可执行文件跑起来，所以只退出 chat、留在终端。角标跟着名字走
/// —— X 归 Codex，E 归 Codex Exec；同一张任务卡上两颗 X 分不出是哪条车道。
const Map<String, CliFamily> kCliFamilies = <String, CliFamily>{
  'claude': CliFamily('Claude', AppColors.claude, lanes: <String, List<CliLane>>{
    'chat': <CliLane>[
      CliLane('claude-exp', mark: 'A', engine: 'Claude Agent SDK'),
      CliLane('claude', engine: 'claude -p', offered: false),
    ],
    'terminal': <CliLane>[
      CliLane('claude', label: 'Claude Code', mark: 'C', engine: 'claude'),
    ],
  }),
  'codex': CliFamily('Codex', AppColors.codex, lanes: <String, List<CliLane>>{
    'chat': <CliLane>[
      CliLane('codex-exp', mark: 'X', engine: 'Codex App Server'),
      CliLane('codex', engine: 'codex exec', offered: false, deprecated: true, replacedBy: 'codex-exp'),
    ],
    'terminal': <CliLane>[
      CliLane('codex', label: 'Codex Exec', mark: 'E', engine: 'codex'),
    ],
  }),
  'opencode': CliFamily('OpenCode', AppColors.opencode, mark: 'O'),
  'zcode': CliFamily('ZCode', AppColors.zcode, mark: 'Z'),
  'qoder': CliFamily('Qoder CN', AppColors.qoder, mark: 'Q', providerless: true),
  'kimi': CliFamily('Kimi Code', AppColors.kimi, mark: 'K'),
  'codebuddy': CliFamily('WorkBuddy', AppColors.codebuddy, mark: 'W', providerless: true),
  'dsh': CliFamily('DSH', AppColors.dsh, mark: 'D', providerless: true),
  'gemini': CliFamily('Gemini', AppColors.gemini, mark: 'G', providerless: true),
  'grok': CliFamily('Grok', AppColors.grok, mark: 'R', providerless: true),
};

/// 这个 CLI 目录认识哪两种场景。
const List<String> kCliKinds = <String>['chat', 'terminal'];

String _key(String? id) => (id ?? '').trim().toLowerCase();

String _firstLetter(String name) {
  final text = name.trim();
  return text.isEmpty ? '?' : text.substring(0, 1).toUpperCase();
}

/// 一个家族在某场景里的衍生；没写 lanes 的家族两场景各一条自身。
List<CliLane> _laneEntries(String familyId, CliFamily family, String kind) {
  if (family.lanes.isEmpty) return <CliLane>[CliLane(familyId)];
  return family.lanes[kind] ?? const <CliLane>[];
}

/// 家族表摊平成车道表 —— 与服务端 buildDisplay / Web cliBuildDisplay 同一套规则，
/// 所以三端可以逐列对比，而不是各写一份结果。
///
/// 每个字段都是**逐车道**合并的：一个家族的两条衍生各自算自己的 kinds/labels/
/// engine，家族那层只提供缺省值。
Map<String, CliDisplay> _flattenFamilies(Map<String, CliFamily> families) {
  final displays = <String, CliDisplay>{};
  families.forEach((familyId, family) {
    final order = <String>[];
    final rows = <String, _LaneFacts>{};
    for (final kind in kCliKinds) {
      for (final entry in _laneEntries(familyId, family, kind)) {
        final id = _key(entry.id).isEmpty ? familyId : _key(entry.id);
        final row = rows.putIfAbsent(id, () {
          order.add(id);
          return _LaneFacts();
        });
        final label = entry.label;
        if (label != null && !row.labels.contains(label)) row.labels.add(label);
        final mark = entry.mark;
        if (mark != null && !row.marks.contains(mark)) row.marks.add(mark);
        final engine = entry.engine;
        if (engine != null) row.engines.putIfAbsent(kind, () => engine);
        if (entry.offered && !row.kinds.contains(kind)) row.kinds.add(kind);
        if (entry.deprecated && row.dying == null) row.dying = entry;
      }
    }
    for (final id in order) {
      final row = rows[id]!;
      // 小字属于**提供这条车道**的场景；两种场景都给的家族（除 claude / codex 之外
      // 的全部）取它先声明的那一种。
      final engineKind = row.kinds.firstWhere(
        (k) => row.engines.containsKey(k),
        orElse: () => row.engines.isEmpty ? '' : row.engines.keys.first,
      );
      final dying = row.dying;
      displays[id] = CliDisplay(
        row.labels.isEmpty ? family.name : row.labels.first,
        family.color,
        row.marks.isEmpty ? (family.mark ?? _firstLetter(family.name)) : row.marks.first,
        providerless: family.providerless,
        deprecated: dying != null,
        replacedBy: dying?.replacedBy,
        engine: engineKind.isEmpty ? null : row.engines[engineKind],
        kinds: row.kinds.length == kCliKinds.length ? kCliKinds : List<String>.from(row.kinds),
      );
    }
  });
  return displays;
}

/// 摊平一行时逐车道攒下来的那几列。
class _LaneFacts {
  final List<String> labels = <String>[];
  final List<String> marks = <String>[];
  final Map<String, String> engines = <String, String>{};
  final List<String> kinds = <String>[];
  CliLane? dying;
}

/// 车道视图：一行一条衍生。既有的所有取词都读它。
final Map<String, CliDisplay> kCliDisplays = _flattenFamilies(kCliFamilies);

/// 车道 → 家族 id；Id 也可以是家族 id 自己。没听说过答 null。
String? cliFamilyOf(String? id) {
  final key = _key(id);
  if (key.isEmpty) return null;
  if (kCliFamilies.containsKey(key)) return key;
  for (final entry in kCliFamilies.entries) {
    for (final kind in kCliKinds) {
      for (final lane in _laneEntries(entry.key, entry.value, kind)) {
        if (_key(lane.id) == key) return entry.key;
      }
    }
  }
  return null;
}

/// 对外的那个名字：claude / claude-exp 以及这条家族以后任何一条衍生都答 'Claude'。
/// 未知 id 回落成 id 本身（不是 'Claude'）。
String cliFamilyName(String? id) {
  final family = cliFamilyOf(id);
  if (family != null) return kCliFamilies[family]!.name;
  return (id ?? '').trim();
}

/// 一个家族在某场景里给的衍生，按选择器该有的顺序；每项自带该场景的大小字。
List<CliLaneView> cliLanesOf(String? familyOrLane, String kind) {
  final familyId = cliFamilyOf(familyOrLane);
  final wanted = kind.trim().toLowerCase();
  if (familyId == null || !kCliKinds.contains(wanted)) return const <CliLaneView>[];
  final family = kCliFamilies[familyId]!;
  return _laneEntries(familyId, family, wanted).map((entry) {
    final lane = _key(entry.id).isEmpty ? familyId : _key(entry.id);
    return CliLaneView(
      lane: lane,
      kind: wanted,
      label: entry.label ?? family.name,
      engine: entry.engine ?? lane,
      mark: entry.mark ?? family.mark ?? _firstLetter(family.name),
      color: family.color,
      offered: entry.offered,
      deprecated: entry.deprecated,
      replacedBy: entry.deprecated ? entry.replacedBy : null,
    );
  }).toList();
}

/// 这个场景里有东西可给的家族。
List<String> cliFamiliesFor(String kind) {
  final wanted = kind.trim().toLowerCase();
  if (!kCliKinds.contains(wanted)) return const <String>[];
  return kCliFamilies.keys.where((id) => cliLanesOf(id, wanted).any((lane) => lane.offered)).toList();
}

/// id → 展示名。未知 id 回落成 id 本身（不是 'Claude'）。
String cliDisplayName(String? id) {
  final entry = kCliDisplays[_key(id)];
  if (entry != null) return entry.name;
  return (id ?? '').trim();
}

/// id → 品牌色。未知 id 用中性灰，免得借来别人的品牌色。
Color cliDisplayColor(String? id) => kCliDisplays[_key(id)]?.color ?? AppColors.faint;

/// id → 折叠徽标的字母。
String cliShortMark(String? id) {
  final entry = kCliDisplays[_key(id)];
  if (entry != null) return entry.mark;
  final name = cliDisplayName(id);
  return name.isEmpty ? '?' : name.substring(0, 1).toUpperCase();
}

/// 这个 CLI 是不是自持账号（厂商账号/模型配置，不挂 MultiCC provider）。
bool cliProviderless(String? id) => kCliDisplays[_key(id)]?.providerless ?? false;

/// 这个 CLI 是不是兜底车道、已在淘汰路上（服务端的 deprecated 列）。
///
/// 未知 id 与退役无关 —— 返回 false，不抛错也不猜。
bool cliDeprecated(String? id) => kCliDisplays[_key(id)]?.deprecated ?? false;

/// 淘汰后该换成哪个 id；非淘汰车道与未知 id 都是 null。
String? cliReplacedBy(String? id) {
  final entry = kCliDisplays[_key(id)];
  if (entry == null || !entry.deprecated) return null;
  return entry.replacedBy;
}

/// 两行式 CLI 行的小字：这条车道底下的引擎。扶正后的两条常驻车道答引擎产品名
/// （Claude Agent SDK / Codex App Server），其余车道答它自己的 id —— 终端里那行
/// 小字指的就是要跑的命令，所以 id 在这里是最准确的答案。未知 id 同样答 id。
String cliEngine(String? id) {
  final entry = kCliDisplays[_key(id)];
  final engine = entry?.engine;
  if (engine != null && engine.isNotEmpty) return engine;
  return (id ?? '').trim();
}

/// 这条车道能出现在哪种会话的选择里。没听说过的 id 两种都答 true —— 表里没有的
/// CLI 不该在选择器里凭空消失。
bool cliOffersIn(String? id, String kind) {
  final entry = kCliDisplays[_key(id)];
  final kinds = entry?.kinds ?? const ['chat', 'terminal'];
  return kinds.contains(kind.trim().toLowerCase());
}
