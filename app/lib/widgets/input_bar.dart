import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../providers/chat_provider.dart';
import '../providers/session_manager.dart';
import '../models/message.dart';
import '../services/annotation_inbox.dart';
import '../services/attachment_picker.dart';
import '../services/chat_service.dart';
import '../services/voice_launch_service.dart';
import '../utils/dispatch_hint.dart';
import 'chat_runtime_panels.dart';
import 'dispatch_mode_selector.dart';
import 'scheduled_send_dock.dart';
import 'scheduled_send_store.dart';
import 'voice_composer.dart';
import 'run_config/run_chip.dart';

class InputBar extends StatefulWidget {
  /// 草稿和光标可以由外面拿着：手机上空闲时输入区会折成一条胶囊，胶囊要
  /// 显示还没发出去的草稿，点开时也要把光标放回输入框 —— 两件事都得从外面
  /// 够得着这两个对象。不传就还是自己管，行为不变。
  final TextEditingController? controller;
  final FocusNode? focusNode;

  /// 定时发送。传了才画 ⏱（和它的待执行角标）；不传的老调用点一行没变。
  final ScheduledSendStore? scheduledSend;

  /// 宿主在这里接走「怎么读当前草稿」：定时消息的悬浮球展开时也要能读到输入
  /// 框里已经写好的那句话，而草稿（正文 + 附件）归这里所有。
  final ValueNotifier<ScheduledSendDraftReader?>? draftSink;

  const InputBar({
    super.key,
    this.controller,
    this.focusNode,
    this.scheduledSend,
    this.draftSink,
  });

  @override
  State<InputBar> createState() => _InputBarState();
}

class _InputBarState extends State<InputBar> {
  late final _ctrl = widget.controller ?? TextEditingController();
  late final _focusNode = widget.focusNode ?? FocusNode();
  bool _hasText = false;

  // Attachments: list of {path, name} from server upload
  final List<Map<String, String>> _attachments = [];
  bool _uploading = false;

  // 语音输入（流式听写 /ws/voice，起不来回退整段 m4a → /api/voice/stt）。
  // 这一套与目录快速新建共用同一个 [VoiceComposerController] —— 交互只有一份。
  late final VoiceComposerController _voice;

  // Commander 专属的「派发方式」四选一，按会话记住（web 端同一组下拉）。
  DispatchMode _dispatchMode = DispatchMode.defaultMode;
  String _dispatchModeSessionId = '';

  @override
  void initState() {
    super.initState();
    _voice = VoiceComposerController(
      settings: context.read<ChatProvider>().settings,
      target: _ctrl,
    );
    // 录音/转写状态会改写输入框的边框色与提示语，所以整条输入条要跟着重建
    // （原先这些 setState 散在录音流程里，现在由控制器统一通知）。
    _voice.addListener(_onVoiceChanged);
    widget.draftSink?.value = _scheduleDraft;
    _focusNode.addListener(_onFocusChanged);
    _ctrl.addListener(() {
      final has = _ctrl.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
    AnnotationInbox.draft.addListener(_onAnnotationDraft);
    WidgetsBinding.instance.addPostFrameCallback((_) => _onAnnotationDraft());
  }

  void _onFocusChanged() {
    if (mounted) setState(() {});
  }

  void _onVoiceChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    AnnotationInbox.draft.removeListener(_onAnnotationDraft);
    _voice.dispose();
    // 谁建的谁销毁：外面传进来的还归外面，这里只摘掉自己挂的监听。
    _focusNode.removeListener(_onFocusChanged);
    if (widget.focusNode == null) _focusNode.dispose();
    if (widget.controller == null) _ctrl.dispose();
    super.dispose();
  }

  // ── File attachment ──

  Future<void> _pickAndUpload() async {
    // iOS 弹「文件 / 相册」二选一（文档选择器够不到相册）；其它平台直接选文件。
    final picked = await pickChatAttachment(context);
    if (picked == null || !mounted) return;
    await _uploadPicked(picked);
  }

  Future<void> _uploadPicked(PickedAttachment picked) async {
    final settings = context.read<ChatProvider>().settings;
    setState(() => _uploading = true);
    try {
      final uploaded = await uploadChatAttachment(
        settings: settings,
        picked: picked,
      );
      if (mounted) {
        setState(() {
          _attachments.add({'path': uploaded.path, 'name': uploaded.name});
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Upload error: $e'),
            backgroundColor: const Color(0xFFb64e43),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  // ── Screenshot annotation hand-off (image viewer → composer) ──

  /// Consume-once: only a mounted input bar on the current, ticking route takes
  /// the draft. The viewer pops before publishing, so the chat route may still
  /// be settling — retry for a few frames before leaving it for someone else.
  void _onAnnotationDraft([int attempt = 0]) {
    if (!mounted || AnnotationInbox.draft.value == null) return;
    final route = ModalRoute.of(context);
    final visible =
        (route == null || route.isCurrent) && TickerMode.of(context);
    if (!visible) {
      if (attempt < 30) {
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _onAnnotationDraft(attempt + 1),
        );
      }
      return;
    }
    final draft = AnnotationInbox.take();
    if (draft == null) return;
    final cur = _ctrl.text;
    final text = cur.trim().isEmpty
        ? draft.text
        : '${cur.trimRight()}\n\n${draft.text}';
    _ctrl.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    // 注释草稿是另一条来源，别让上一条听写的 voice 标记粘到它上面。
    _voice.clearPendingVoice();
    _focusNode.requestFocus();
    final png = draft.png;
    if (png != null) {
      _uploadPicked(
        PickedAttachment(
          bytes: png,
          filename: draft.filename,
          mimeType: 'image/png',
        ),
      );
    }
  }

  // ── Realtime voice call ──
  //
  // 普通语音输入（点麦克风说一句）在 [VoiceComposerController] 里，与目录快速
  // 新建共用；这里这颗只负责「打语音电话」。实时语音走全局 Qwen 语音网关：这里
  // 只向 Host 申请一张 launch 票据，
  // 带上当前会话 id 表示「在这个会话里说话」，Host 会固定投给该会话。只有
  // Dashboard 的全局入口才由 worker-only Router 选择项目和普通 Worker；App
  // 不参与决定，也不携带长期 token。
  Future<void> _openVoiceCall() async {
    final provider = context.read<ChatProvider>();
    final service = VoiceLaunchService(settings: provider.settings);
    final result = await service.launch(sourceSessionId: provider.sessionName);
    if (!mounted || result.ok) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          result.message ?? VoiceLaunchService.describe(result.errorCode),
        ),
        backgroundColor: const Color(0xFFb64e43),
      ),
    );
  }

  // ── Dispatch hint (commander only) ──

  /// 切到别的会话时把选中项对齐到那个会话记住的值。读是同步的（
  /// SharedPreferences 早已加载），所以直接在 build 里调用，不用等下一帧；
  /// 没写过的会话回落默认（dispatch_master async），不回写默认值。
  void _syncDispatchMode(ChatProvider provider) {
    final sessionId = provider.sessionName;
    if (sessionId == _dispatchModeSessionId) return;
    _dispatchModeSessionId = sessionId;
    _dispatchMode = provider.settings.readDispatchMode(sessionId);
  }

  void _setDispatchMode(ChatProvider provider, DispatchMode value) {
    setState(() => _dispatchMode = value);
    provider.settings.saveDispatchMode(provider.sessionName, value);
  }

  // ── Send ──

  void _dismissIosKeyboard() {
    if (!mounted || Theme.of(context).platform != TargetPlatform.iOS) return;
    _focusNode.unfocus();
  }

  bool _guardConnectedSend(ChatProvider provider) {
    if (provider.connectionState == ChatConnectionState.connected) return true;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(t('connectionLostRetry')),
        backgroundColor: const Color(0xFF8b9cae),
      ),
    );
    return false;
  }

  /// 斜杠命令：与 web `chat-composer.js` 的 send() 同一套语义 —— 命令在本机
  /// 处理，不进对话流、不送达模型。只认去掉参数后的第一个词，认不出的照旧当
  /// 普通消息发给 CLI（`/compact`、`/cost` 本来就是 CLI 自己的命令）。
  ///
  /// 返回要发送的正文；返回 null 表示这条已经被命令消化掉了。
  String? _runSlashCommand(
    ChatProvider provider,
    String command,
    String input,
  ) {
    switch (command) {
      case '/clear':
        // 与聊天头部的「清理显示」同一条服务端路径。清空后的提示交给
        // chat_history_reset 统一给（见 ChatProvider）：在这里补一条本地行会
        // 被紧随其后换进来的历史冲掉，等于什么都没说。
        provider.clearHistory(keep: 0);
        return null;
      case '/help':
        provider.addLocalSystemMessage(t('slashHelp'));
        return null;
      default:
        return input;
    }
  }

  void _send(ChatProvider provider, {required bool commander}) {
    var text = _ctrl.text.trim();
    if (text.startsWith('/')) {
      // 命令判定只看输入框里的原文：附件路径是发出时才拼上去的（web 同理）。
      final command = text.split(RegExp(r'\s+')).first.toLowerCase();
      final resolved = _runSlashCommand(provider, command, text);
      if (resolved == null) {
        // 只清正文：附件是用户自己挑的，命令没用到就不替他丢掉。
        _ctrl.clear();
        _dismissIosKeyboard();
        return;
      }
      text = resolved;
    }
    if (!_guardConnectedSend(provider)) return;
    // 听写来源：提交听写时记下的原始转写。发出去后连同反馈一起清掉。
    final voiceRaw = _voice.pendingVoiceRaw;
    // Append attachment paths
    if (_attachments.isNotEmpty) {
      final paths = _attachments.map((a) => a['path']!).join(' ');
      text = text.isEmpty ? paths : '$text $paths';
    }
    if (text.isEmpty) return;
    // 反馈只学用户自己写的话：附件路径与下面的派发装饰都是 App 加上去的，不算
    // 用户词汇，所以在这两处拼接之前先把这一份留下来。
    final userFinal = text;
    // 装饰必须在交给 provider 之前：气泡与真正发出去的 payload 用同一个字符串。
    text = decorateDispatchHint(text, enabled: commander, mode: _dispatchMode);
    provider.sendMessage(text, voiceRaw: voiceRaw);
    if (voiceRaw != null) _voice.reportVoiceFeedback(userFinal);
    _voice.clearPendingVoice();
    _ctrl.clear();
    // Unlike Android, iOS has no persistent system affordance for hiding the
    // software keyboard. A completed composer action must therefore release
    // focus explicitly; otherwise the keyboard remains pinned over the chat.
    _dismissIosKeyboard();
    setState(() {
      _hasText = false;
      _attachments.clear();
    });
  }

  /// 排定时消息时交给面板的那份草稿。
  ///
  /// 拼装规则与 [_send] 逐条一致（正文 + 附件路径 + 派发装饰），否则「定时发」
  /// 和「立刻发」发出去的不是同一句话。清空也照 [_send] 的收尾来 —— 草稿归
  /// 输入框所有，所以面板成功之后回头调这里把框清干净。
  ///
  /// commander 现算而不接 build 的局部变量：这个闭包也交给宿主拿着，会活到
  /// 下一次会话切换之后，冻住的值就错了。
  ScheduledSendDraft _scheduleDraft() {
    final provider = context.read<ChatProvider>();
    final smgr = context.read<SessionManager>();
    Session? active;
    for (final session in smgr.sessions) {
      if (session.id == provider.sessionName) {
        active = session;
        break;
      }
    }
    final commander = isCommanderSessionType(active?.type);
    return _scheduleDraftFor(commander);
  }

  ScheduledSendDraft _scheduleDraftFor(bool commander) => ScheduledSendDraft(
    text: _ctrl.text,
    attachmentPaths: [
      for (final attachment in _attachments)
        if (attachment['path'] != null) attachment['path']!,
    ],
    decorate: (text) =>
        decorateDispatchHint(text, enabled: commander, mode: _dispatchMode),
    clearAfterSchedule: () {
      _ctrl.clear();
      if (!mounted) return;
      setState(() {
        _hasText = false;
        _attachments.clear();
      });
    },
  );

  Future<bool> _confirmQueueChange(String action) async {
    if (!const {
      'skip',
      'cancel',
      'cancel_queued',
      'insert_queued',
    }.contains(action)) {
      return true;
    }
    // 插队会当场掐断正在生成的回复，手机上误触代价比 web 大，所以和取消一样
    // 走一次确认；文案单列，别让用户以为只是「排到前面」。
    final body = action == 'insert_queued'
        ? t('confirmInsertQueuedBody')
        : t('confirmQueueChangeBody');
    return await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: Text(t('confirmQueueChangeTitle')),
            content: Text(body),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: Text(t('cancel')),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialogContext, true),
                child: Text(t('confirm')),
              ),
            ],
          ),
        ) ??
        false;
  }

  Future<void> _runQueueAction(
    ChatProvider provider,
    String action, {
    String? entryId,
    int? toIndex,
    String? text,
  }) async {
    if (!await _confirmQueueChange(action)) return;
    try {
      final started = await provider.queueAction(
        action,
        entryId: entryId,
        toIndex: toIndex,
        text: text,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            action == 'insert_queued'
                ? (started ? t('queueInsertAccepted') : t('queueInsertPending'))
                : action == 'reorder_queued'
                ? t('queueReorderAccepted')
                : t('queueActionAccepted'),
          ),
        ),
      );
    } catch (error) {
      if (!mounted) rethrow;
      // 调度器已经领走这条消息是最常见的失败，原始 code 对用户没有意义。
      final queueError = error is QueueActionException ? error : null;
      final claimed = queueError?.code == 'queued_entry_already_claimed';
      // 超长也单列：原文是 raw code，用户读不出「删减后重试」这条出路。
      final tooLong = queueError?.code == 'queued_entry_text_too_long';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            claimed
                ? t('queueEntryAlreadyClaimed')
                : tooLong
                ? t('queueEntryTextTooLong', {
                    'n': '${queueError?.limit ?? 20000}',
                  })
                : t('queueActionFailed', {'error': '$error'}),
          ),
          backgroundColor: const Color(0xFFfff1ef),
        ),
      );
      // 失败必须传回面板：否则 _editQueued 会在失败之上再弹一条「已修改」，
      // 列表没更新却被读成保存成功（重开还是旧正文）。
      rethrow;
    }
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ChatProvider>();
    final smgr = context.watch<SessionManager>();
    Session? activeSess;
    for (final x in smgr.sessions) {
      if (x.id == provider.sessionName) {
        activeSess = x;
        break;
      }
    }
    // 会话角色读不到就当不是 commander：fail closed，绝不悄悄改写提示词。
    final isCommander = isCommanderSessionType(activeSess?.type);
    _syncDispatchMode(provider);
    final isStreaming = provider.isStreaming;
    final isConnected =
        provider.connectionState == ChatConnectionState.connected;
    final canSend = (_hasText || _attachments.isNotEmpty) && isConnected;
    // 语音输入要跟着当前会话的设置走（切会话后 token/host/lang 都会换）。
    _voice.syncSettings(provider.settings);

    // Web 移动端的 composer（public/composer.css + chat-air.css）：一张悬浮在
    // 对话列上的圆角卡片，四周留水、不贴边；卡片顶上贴一条「配置带」放运行
    // 配置药丸。外层透明，消息区的底色从卡片四周透出来。
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SessionQueuePanel(
              queue: provider.sessionQueue,
              enabled: isConnected,
              onAction: (action) => _runQueueAction(provider, action),
              onCancelQueued: (entryId) =>
                  _runQueueAction(provider, 'cancel_queued', entryId: entryId),
              onInsertQueued: (entryId) =>
                  _runQueueAction(provider, 'insert_queued', entryId: entryId),
              onReorderQueued: (entryId, toIndex) => _runQueueAction(
                provider,
                'reorder_queued',
                entryId: entryId,
                toIndex: toIndex,
              ),
              onEditQueued: (entryId, text) => _runQueueAction(
                provider,
                'edit_queued',
                entryId: entryId,
                text: text,
              ),
            ),

            // Attachment chips
            if (_attachments.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: _attachments.asMap().entries.map((e) {
                    final idx = e.key;
                    final att = e.value;
                    return Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xFFf8fbff),
                        border: Border.all(color: const Color(0xFFdce6f1)),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.attach_file,
                            size: 12,
                            color: Color(0xFF6f8096),
                          ),
                          const SizedBox(width: 4),
                          ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 150),
                            child: Text(
                              att['name']!,
                              style: const TextStyle(
                                color: Color(0xFF233249),
                                fontSize: 12,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 4),
                          GestureDetector(
                            onTap: () =>
                                setState(() => _attachments.removeAt(idx)),
                            child: const Icon(
                              Icons.close,
                              size: 12,
                              color: Color(0xFF6f8096),
                            ),
                          ),
                        ],
                      ),
                    );
                  }).toList(),
                ),
              ),

            // Commander 专属：这一轮怎么派发。四个选项平铺会把手机上的输入区
            // 挤掉，所以只留一枚显示当前档位的胶囊，改档去 BottomSheet 里选 ——
            // 与 web 同一形态。位置在输入框之上，和 web 的 #pre-input-bar 顺序
            // 一致。（子任务不再有外显胶囊：它只在 AI 配置面板里作为 provider
            // 后面的一行尾巴出现，没设就什么都不显示。）
            if (isCommander)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: DispatchModePill(
                    key: const Key('dispatch-mode-group'),
                    mode: _dispatchMode,
                    onChanged: (value) => _setDispatchMode(provider, value),
                  ),
                ),
              ),

            // Streaming voice dictation HUD — lives just above the input row so the
            // live transcript is visible while the keyboard / send button stay usable.
            if (_voice.showHud)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: VoiceDictationHud(controller: _voice),
              ),

            _ComposerBand(provider: provider),
            _composerCard(
              provider,
              isCommander,
              isStreaming,
              isConnected,
              canSend,
            ),
          ],
        ),
      ),
    );
  }

  /// 卡片本体，按 web ≤420px 的 `#input-bar` 排：第一行是输入框 + 发送/停止，
  /// 第二行是附件 / 语音 / 通话，定时发送靠右。
  Widget _composerCard(
    ChatProvider provider,
    bool isCommander,
    bool isStreaming,
    bool isConnected,
    bool canSend,
  ) {
    final borderColor = _voice.isRecording
        ? const Color(0xFFb64e43)
        : _focusNode.hasFocus
        ? const Color(0xFFc1d8ed)
        : const Color(0xFFdbe5ef);
    return Container(
      key: const Key('chat-composer-card'),
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: borderColor),
        // 配置带盖住卡片的上边：两者拼成一个盒子，接缝处不留双线和圆角。
        borderRadius: const BorderRadius.vertical(
          top: Radius.zero,
          bottom: Radius.circular(15),
        ),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFF315576).withValues(alpha: 0.08),
            blurRadius: 30,
            offset: const Offset(0, 10),
          ),
          BoxShadow(
            color: const Color(0xFF23599a).withValues(alpha: 0.03),
            blurRadius: 16,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 120),
                  child: TextField(
                    key: const Key('chat-message-input'),
                    controller: _ctrl,
                    focusNode: _focusNode,
                    maxLines: null,
                    textInputAction: TextInputAction.newline,
                    // Keep the draft editable through disconnects/reconnects.
                    // Connection state gates Send (and the adjacent actions),
                    // not the composer focus or the software keyboard.
                    style: const TextStyle(
                      color: Color(0xFF263b50),
                      fontSize: 15,
                      height: 1.4,
                    ),
                    decoration: InputDecoration(
                      hintText: _voice.isRecording
                          ? t('recording')
                          : _voice.isTranscribing
                          ? t('transcribing')
                          : t('typeMessage'),
                      hintStyle: TextStyle(
                        color: _voice.isRecording
                            ? const Color(0xFFb64e43)
                            : const Color(0xFF8b9cae),
                      ),
                      border: InputBorder.none,
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 10,
                      ),
                    ),
                    onSubmitted: canSend
                        ? (_) => _send(provider, commander: isCommander)
                        : null,
                    // Flutter intentionally keeps focus for touch-device
                    // outside taps by default. Override that convention on
                    // iOS so tapping the transcript/header hides the keyboard
                    // while leaving the draft untouched.
                    onTapOutside: (_) => _dismissIosKeyboard(),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              // Keep both actions available while streaming: Send stages the
              // message durably; Stop remains an explicit cancellation.
              if (isStreaming)
                _ActionButton(
                  onTap: provider.cancel,
                  color: const Color(0xFFb64e43),
                  icon: Icons.stop_rounded,
                ),
              if (isStreaming) const SizedBox(width: 4),
              _ActionButton(
                onTap: canSend
                    ? () => _send(provider, commander: isCommander)
                    : null,
                color: canSend
                    ? const Color(0xFF0965cf)
                    : const Color(0xFFf7faff),
                icon: Icons.send_rounded,
                iconColor: canSend ? Colors.white : const Color(0xFF8b9cae),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              // Attachment button
              _SmallButton(
                onTap: (!_uploading && isConnected) ? _pickAndUpload : null,
                icon: _uploading
                    ? Icons.hourglass_top_rounded
                    : Icons.attach_file_rounded,
                color: const Color(0xFF55718c),
              ),
              const SizedBox(width: 4),
              // Voice button — streaming /ws/voice dictation (falls back to the
              // legacy m4a → /api/voice/stt flow when the socket is unavailable).
              VoiceMicButton(
                key: const Key('chat-mic-button'),
                controller: _voice,
                enabled: isConnected,
                iconSize: 20,
              ),
              const SizedBox(width: 4),
              // Realtime voice — opens the one global voice gateway, scoped to
              // this session. Plain dictation stays on the mic button.
              _SmallButton(
                onTap: isConnected
                    ? () {
                        _openVoiceCall();
                      }
                    : null,
                icon: Icons.phone_in_talk_rounded,
                color: const Color(0xFF0965cf),
              ),
              const Spacer(),
              // 定时发送（Web 的 #schedule-send-btn）：有待执行的消息时右上角
              // 挂一个条数角标。
              if (widget.scheduledSend != null)
                ScheduledSendButton(
                  store: widget.scheduledSend!,
                  onDraft: _scheduleDraft,
                  onTap: () => openScheduledSendSheet(
                    context,
                    widget.scheduledSend!,
                    onDraft: _scheduleDraft,
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 卡片顶上的「配置带」（web 的 `#air-composer-meta.mc-composer__aux`）：运行
/// 配置药丸（CLI · 线路 · 模型 · 强度）常驻于此，简易/进阶模式一样可点。
/// `desiredCli` + `pending`：会话忙时换道是「下轮生效」，药丸跟着用户选好的
/// 那条车道走，否则列的还是旧车道的 Provider 池。
class _ComposerBand extends StatelessWidget {
  const _ComposerBand({required this.provider});

  final ChatProvider provider;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('chat-composer-band'),
      padding: const EdgeInsets.fromLTRB(10, 7, 10, 7),
      decoration: const BoxDecoration(
        color: Color(0xFFf8fbff),
        border: Border(
          top: BorderSide(color: Color(0xFFdbe5ef)),
          left: BorderSide(color: Color(0xFFdbe5ef)),
          right: BorderSide(color: Color(0xFFdbe5ef)),
        ),
        borderRadius: BorderRadius.vertical(top: Radius.circular(15)),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) => Align(
          alignment: Alignment.centerLeft,
          child: RunChip(
            sessionId: provider.executionSessionName,
            cli: provider.pendingConfiguration.desiredCli(provider.cli),
            pending: provider.pendingConfiguration.value,
            settings: provider.settings,
            // web 的 `max-width: min(68%, 320px)`；「下一轮生效」角标另占一截。
            maxLabelWidth: (constraints.maxWidth * 0.68).clamp(80.0, 320.0),
          ),
        ),
      ),
    );
  }
}

class _SmallButton extends StatelessWidget {
  final VoidCallback? onTap;
  final IconData icon;
  final Color color;

  const _SmallButton({
    required this.onTap,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 34,
        height: 40,
        alignment: Alignment.center,
        child: Icon(
          icon,
          color: onTap != null ? color : const Color(0xFF8b9cae),
          size: 20,
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  final VoidCallback? onTap;
  final Color color;
  final IconData icon;
  final Color iconColor;

  const _ActionButton({
    required this.onTap,
    required this.color,
    required this.icon,
    this.iconColor = Colors.white,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(icon, color: iconColor, size: 20),
      ),
    );
  }
}
