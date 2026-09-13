import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../models/task_artifact.dart';
import '../services/settings_service.dart';
import '../services/task_artifacts_service.dart';

/// 产物边栏 —— Web `public/task-artifacts.js` + `task-artifacts.css`。
///
/// 布局跟着 CSS 走：宽 310、贴右边缘；宽屏（web 的 `min-width:760px`）开着时
/// 把正文让出 310px，窄屏则直接盖上去（`min(310px, 100% - 18px)`）。
/// 「让位」那半由调用方做（见 chat_screen 里的 `_artifactsWidth`）。
class TaskArtifactsPanel extends StatefulWidget {
  const TaskArtifactsPanel({
    super.key,
    required this.controller,
    required this.settings,
    required this.onClose,
    required this.panelWidth,
  });

  final TaskArtifactsController controller;
  final SettingsService settings;
  final VoidCallback onClose;

  /// 面板实际占的宽度（窄屏会被裁到 100% - 18px）。
  final double panelWidth;

  /// 收起时整块面板不吃点击的那一层。给它一个稳定的 key：树里还有别的
  /// `IgnorePointer`（输入框内部就有一个），测试要抓的是这一个。
  static const ignoreKey = Key('task-artifacts-ignore');

  @override
  State<TaskArtifactsPanel> createState() => _TaskArtifactsPanelState();
}

class _TaskArtifactsPanelState extends State<TaskArtifactsPanel> {
  final _searchCtrl = TextEditingController();
  String? _lastTaskId;

  @override
  void initState() {
    super.initState();
    _lastTaskId = widget.controller.taskId;
    widget.controller.addListener(_onController);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onController);
    _searchCtrl.dispose();
    super.dispose();
  }

  /// 换任务时 web 会连搜索框一起清掉（`search.value = ''`）。列表那边由
  /// controller 负责，输入框里的字得在这里跟着清，否则会出现「搜的是上一个
  /// 任务的词、列表却已经是新任务的」这种对不上的状态。
  void _onController() {
    if (widget.controller.taskId == _lastTaskId) return;
    _lastTaskId = widget.controller.taskId;
    if (_searchCtrl.text.isNotEmpty) _searchCtrl.clear();
  }

  Future<void> _open(String url) async {
    final uri = Uri.tryParse(widget.settings.buildHttpUrl(url));
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  Future<void> _copy(String url) async {
    try {
      await Clipboard.setData(
        ClipboardData(text: widget.settings.buildHttpUrl(url)),
      );
      widget.controller.markCopied(true);
    } catch (_) {
      widget.controller.markCopied(false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        final controller = widget.controller;
        return AnimatedSlide(
          offset: controller.open ? Offset.zero : const Offset(1.05, 0),
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
          child: Align(
            alignment: Alignment.centerRight,
            child: IgnorePointer(
              key: TaskArtifactsPanel.ignoreKey,
              ignoring: !controller.open,
              child: SizedBox(
                width: widget.panelWidth,
                height: double.infinity,
                child: Material(
                  color: const Color(0xFFf7faff),
                  elevation: 12,
                  child: DecoratedBox(
                    decoration: const BoxDecoration(
                      border: Border(
                        left: BorderSide(color: Color(0xFFdce6f1)),
                      ),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.all(18),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _head(),
                          const SizedBox(height: 12),
                          if (controller.title.isNotEmpty)
                            _taskTitle(controller.title),
                          _search(),
                          const SizedBox(height: 12),
                          _actions(),
                          _statusLine(),
                          const SizedBox(height: 8),
                          Expanded(child: _list(controller)),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _head() => Row(
    children: [
      Expanded(
        child: Text(
          t('taskArtifactsTitle'),
          style: const TextStyle(
            fontSize: 17,
            fontWeight: FontWeight.w600,
            color: Color(0xFF25334a),
          ),
        ),
      ),
      Tooltip(
        message: t('taskArtifactsCollapse'),
        child: InkWell(
          onTap: widget.onClose,
          borderRadius: BorderRadius.circular(6),
          child: const Padding(
            padding: EdgeInsets.symmetric(horizontal: 4, vertical: 2),
            child: Text(
              '×',
              style: TextStyle(
                fontSize: 24,
                height: 1,
                color: Color(0xFF25334a),
              ),
            ),
          ),
        ),
      ),
    ],
  );

  Widget _taskTitle(String title) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(
      title,
      maxLines: 3,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(fontSize: 12, color: Color(0xFF69778e)),
    ),
  );

  Widget _search() => TextField(
    controller: _searchCtrl,
    onChanged: widget.controller.setQuery,
    style: const TextStyle(fontSize: 14, color: Color(0xFF25334a)),
    decoration: InputDecoration(
      hintText: t('taskArtifactsSearch'),
      hintStyle: const TextStyle(fontSize: 13, color: Color(0xFF8a99ad)),
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Color(0xFFdce6f1)),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Color(0xFFdce6f1)),
      ),
    ),
  );

  Widget _actions() => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      children: [
        _MiniBtn(
          label: t('taskArtifactsRefresh'),
          onTap: () => widget.controller.refresh(),
        ),
        const Spacer(),
        InkWell(
          onTap: () => _open('/manage?view=docs'),
          child: Text(
            t('taskArtifactsManage'),
            style: const TextStyle(fontSize: 12, color: Color(0xFF246ac4)),
          ),
        ),
      ],
    ),
  );

  Widget _statusLine() {
    final text = switch (widget.controller.status) {
      TaskArtifactsStatus.none => '',
      // 还没拉到时就把「正在加载」摆出来，免得空列表被读成「没有产物」。
      TaskArtifactsStatus.loading => t('taskArtifactsLoading'),
      TaskArtifactsStatus.failed => t('taskArtifactsLoadFailed'),
      TaskArtifactsStatus.copied => t('taskArtifactsCopied'),
      TaskArtifactsStatus.copyFailed => t('taskArtifactsCopyFailed'),
    };
    if (text.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(
        text,
        style: const TextStyle(fontSize: 12, color: Color(0xFFa05226)),
      ),
    );
  }

  Widget _list(TaskArtifactsController controller) {
    final visible = controller.visible;
    if (visible.isEmpty) {
      return Text(
        t(controller.hasQuery ? 'taskArtifactsNoMatch' : 'taskArtifactsEmpty'),
        style: const TextStyle(
          fontSize: 13,
          height: 1.8,
          color: Color(0xFF69778e),
        ),
      );
    }
    return ListView.builder(
      padding: EdgeInsets.zero,
      itemCount: visible.length,
      itemBuilder: (_, i) => _ArtifactRow(
        artifact: visible[i],
        onOpen: () => _open(visible[i].url),
        onCopy: () => _copy(visible[i].url),
      ),
    );
  }
}

class _MiniBtn extends StatelessWidget {
  const _MiniBtn({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(9),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: const Color(0xFFFFFFFF),
          border: Border.all(color: const Color(0xFFdce6f1)),
          borderRadius: BorderRadius.circular(9),
        ),
        child: Text(
          label,
          style: const TextStyle(fontSize: 12, color: Color(0xFF25334a)),
        ),
      ),
    );
  }
}

class _ArtifactRow extends StatelessWidget {
  const _ArtifactRow({
    required this.artifact,
    required this.onOpen,
    required this.onCopy,
  });

  final TaskArtifact artifact;
  final VoidCallback onOpen;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    final meta = [
      t(artifact.isPage ? 'taskArtifactsPage' : 'taskArtifactsFile'),
      if (artifact.dateLabel.isNotEmpty) artifact.dateLabel,
    ].join(' · ');
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFFFFFFF),
        border: Border.all(color: const Color(0xFFe6edf5)),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: onOpen,
            child: Text(
              artifact.title,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: Color(0xFF246ac4),
              ),
            ),
          ),
          const SizedBox(height: 7),
          Text(
            artifact.url,
            style: const TextStyle(fontSize: 11, color: Color(0xFF8a99ad)),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: Text(
                  meta,
                  style: const TextStyle(
                    fontSize: 11,
                    color: Color(0xFF69778e),
                  ),
                ),
              ),
              if (artifact.expired)
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Text(
                    t('taskArtifactsExpired'),
                    style: const TextStyle(
                      fontSize: 11,
                      color: Color(0xFFa05226),
                    ),
                  ),
                ),
              const SizedBox(width: 8),
              _MiniBtn(label: t('taskArtifactsCopy'), onTap: onCopy),
            ],
          ),
        ],
      ),
    );
  }
}
