// 宿主级动作：显示桌面 / 调度中心 / 切换窗口。
///
/// 这些都不是新的输入 op —— 远端只认点击、滚轮、按键和弦，所以这里给出的
/// 是 `press` 的键位串（`native/remote/src/routes.rs` 的 op 白名单）。
/// 只对 macOS 有定义：另外两个平台的桌面 Agent 还不支持远程屏幕，
/// 硬编一套 Windows/Linux 快捷键只会让按钮按下去没反应。
class RemoteHostAction {
  const RemoteHostAction({
    required this.id,
    required this.labelKey,
    required this.fallbackLabel,
    required this.keys,
  });

  final String id;

  /// i18n 键（zh.json / en.json）。
  final String labelKey;

  /// 字典缺失时的中文兜底，也让单测不依赖 i18n 初始化。
  final String fallbackLabel;

  /// `press` 的键位串，如 `ctrl+up`。
  final String keys;
}

const List<RemoteHostAction> _macActions = [
  RemoteHostAction(
    id: 'desktop',
    labelKey: 'rsHostDesktop',
    fallbackLabel: '显示桌面',
    keys: 'f11',
  ),
  RemoteHostAction(
    id: 'mission',
    labelKey: 'rsHostMission',
    fallbackLabel: '调度中心',
    keys: 'ctrl+up',
  ),
  RemoteHostAction(
    id: 'windows',
    labelKey: 'rsHostWindows',
    fallbackLabel: '切换窗口',
    keys: 'ctrl+down',
  ),
  RemoteHostAction(
    id: 'switcher',
    labelKey: 'rsHostSwitcher',
    fallbackLabel: '切换应用',
    keys: 'cmd+tab',
  ),
];

/// 按能力画像的 `modifier` 选表。`cmd` = macOS；其余平台目前没有远控 Agent，
/// 返回空表让侧栏收起这一项，而不是给一排死按钮。
List<RemoteHostAction> remoteHostActions(String hostModifier) =>
    hostModifier == 'cmd' ? _macActions : const [];
