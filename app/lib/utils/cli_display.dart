// CLI 展示目录（App 侧的唯一一份）。
//
// 权威表在服务端：src/cli/cli-capability.js 的 DISPLAY（displayName / shortMark /
// colour / providerless / deprecated / replacedBy 六列）。Web 侧镜像在
// public/provider-catalog.js，这里是 App 侧镜像；tests/test-cli-display-parity.js
// 读这三份，任何一列漂移就红。
//
// 这里【不是】CLI 的事实源 —— 车道协议、能力、是否支持 provider 都由服务端定义。
// 本文件只有「这个 id 在不同端上叫什么、什么颜色、折叠时用哪个字母」。
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

/// id → 展示事实。id 就是会话记录里的 `cli` 字段（也是 [SessionCli.name]）。
///
/// claude-exp 与 codex-exp 复用各自家族的品牌色（浅色主题下不为两档再各造一个色），
/// 但名字必须分开 —— 它们是两个不同的产品。
///
/// 2026-09-26：两条常驻车道扶正为产品名，两条一次性车道退出 chat。
///
///   id         大字          小字（engine）         出现在
///   claude     Claude Code   （id = 要跑的命令）     仅终端
///   claude-exp Claude        Claude Agent SDK      仅 chat
///   codex      Codex Exec    （id = 要跑的命令）     仅终端
///   codex-exp  Codex         Codex App Server      仅 chat
///
/// `claude` 是 `claude -p`、`codex` 是 `codex exec`：chat 里已经没有它们的位置，
/// 但终端真的要把这两个可执行文件跑起来，所以只退出 chat。角标跟着名字走 ——
/// X 归 Codex，E 归 Codex Exec；两个 id 不能同用 X，否则同一张任务卡上两颗 X
/// 分不出是哪条车道。
const Map<String, CliDisplay> kCliDisplays = <String, CliDisplay>{
  'claude': CliDisplay('Claude Code', AppColors.claude, 'C', kinds: ['terminal']),
  'claude-exp': CliDisplay('Claude', AppColors.claude, 'A', engine: 'Claude Agent SDK', kinds: ['chat']),
  'codex': CliDisplay('Codex Exec', AppColors.codex, 'E', deprecated: true, replacedBy: 'codex-exp', kinds: ['terminal']),
  'codex-exp': CliDisplay('Codex', AppColors.codex, 'X', engine: 'Codex App Server', kinds: ['chat']),
  'opencode': CliDisplay('OpenCode', AppColors.opencode, 'O'),
  'zcode': CliDisplay('ZCode', AppColors.zcode, 'Z'),
  'qoder': CliDisplay('Qoder CN', AppColors.qoder, 'Q', providerless: true),
  'kimi': CliDisplay('Kimi Code', AppColors.kimi, 'K'),
  'codebuddy': CliDisplay('WorkBuddy', AppColors.codebuddy, 'W', providerless: true),
  'dsh': CliDisplay('DSH', AppColors.dsh, 'D', providerless: true),
  'gemini': CliDisplay('Gemini', AppColors.gemini, 'G', providerless: true),
  'grok': CliDisplay('Grok', AppColors.grok, 'R', providerless: true),
};

String _key(String? id) => (id ?? '').trim().toLowerCase();

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
