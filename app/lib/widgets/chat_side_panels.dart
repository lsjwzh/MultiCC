import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../i18n.dart';
import '../services/settings_service.dart';
import '../services/task_artifacts_service.dart';
import 'chat_debug_panel.dart';
import 'task_artifacts_panel.dart';

/// 聊天页右侧那两个抽屉（调试面板 + 产物边栏）的编排。
///
/// 这两件事本来都摊在 `chat_screen` 里，而那个文件已经顶到行数闸门；边界也
/// 正好整齐 —— 两个抽屉都只依赖「当前会话的 shellId」，跟消息列表无关。
class ChatSidePanels {
  ChatSidePanels({
    required SettingsService settings,
    required bool Function() isAlive,
    required VoidCallback onChanged,
  }) : _onChanged = onChanged,
       artifacts = TaskArtifactsController(settings: settings, isAlive: isAlive);

  final VoidCallback _onChanged;

  /// 产物边栏的状态（列表、轮询、展开偏好都在它身上）。
  final TaskArtifactsController artifacts;

  bool _debugOpen = false;
  bool _polling = false;
  // 页面真正渲染出来的产物状态只有两件：面板开没开、入口上的条数。轮询每 5s
  // 都会通知一次，但绝大多数时候这两件都没变 —— 只有变了才惊动页面，免得把
  // 整条消息列表按轮询频率重建。
  bool _seenOpen = false;
  bool _seenLoaded = false;
  int _seenCount = 0;

  bool get debugOpen => _debugOpen;
  bool get artifactsOpen => artifacts.open;

  void toggleDebug() {
    _debugOpen = !_debugOpen;
    _onChanged();
  }

  void closeDebug() {
    if (!_debugOpen) return;
    _debugOpen = false;
    _onChanged();
  }

  void toggleArtifacts() => unawaited(artifacts.setOpen(!artifacts.open));

  void closeArtifacts() => unawaited(artifacts.setOpen(false));

  /// 每帧喊一次：会话所在的 shell 变了就换 scope；第一次拿到就开始轮询。
  void sync(String? shellId) {
    artifacts.syncScope(shellId);
    if (!_polling && artifacts.available) {
      _polling = true;
      artifacts.startPolling();
    }
  }

  /// 页头那颗「产物」入口的文案。还没拿到 shell 就没有入口（web 在没有 scope
  /// 时连按钮都不建），拉到列表之后才把条数补上去。
  String? get artifactsLabel => !artifacts.available
      ? null
      : (artifacts.loaded
            ? '${t('taskArtifactsTitle')} ${artifacts.items.length}'
            : t('taskArtifactsTitle'));

  void start() => artifacts.addListener(_onArtifacts);

  void dispose() {
    artifacts.removeListener(_onArtifacts);
    artifacts.dispose();
  }

  void _onArtifacts() {
    final open = artifacts.open;
    final loaded = artifacts.loaded;
    final count = artifacts.items.length;
    if (open == _seenOpen && loaded == _seenLoaded && count == _seenCount) {
      return;
    }
    _seenOpen = open;
    _seenLoaded = loaded;
    _seenCount = count;
    _onChanged();
  }
}

/// 产物边栏的宽度，以及宽屏时正文要让出多少（web `task-artifacts.css` 的
/// `min-width:760px` 那条）：宽屏开着时正文让出整块，窄屏面板直接盖上去。
({double width, double push}) sidePanelMetrics({
  required BoxConstraints constraints,
  required bool panelOpen,
}) {
  final width = math.min(310.0, constraints.maxWidth - 18);
  final push = panelOpen && constraints.maxWidth >= 760 ? width : 0.0;
  return (width: width, push: push);
}

/// 两个抽屉的叠放。产物排在前面 —— 调试面板的 z 序更高（对齐 web 的
/// `#debug-panel` z-index 18000 与产物边栏 1100，两个都开着时调试面板在上）。
///
/// 两个面板都常驻在树上、只滑出屏幕：读日志时经常要点着页面别处对照，
/// 销毁重建会把滚动位置和输入框一起丢掉。
class ChatSidePanelStack extends StatelessWidget {
  const ChatSidePanelStack({
    super.key,
    required this.panels,
    required this.settings,
    required this.panelWidth,
  });

  final ChatSidePanels panels;
  final SettingsService settings;
  final double panelWidth;

  @override
  Widget build(BuildContext context) => Stack(
    children: [
      Positioned.fill(
        child: TaskArtifactsPanel(
          controller: panels.artifacts,
          settings: settings,
          onClose: panels.closeArtifacts,
          panelWidth: panelWidth,
        ),
      ),
      Positioned.fill(
        child: ChatDebugPanel(
          open: panels.debugOpen,
          onClose: panels.closeDebug,
        ),
      ),
    ],
  );
}
