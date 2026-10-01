// 语音输入只有一份实现：会话页输入条（InputBar）与目录「快速新建」
// （AirQuickComposer）用的是同一个 [VoiceComposerController]、同一颗
// [VoiceMicButton]、同一块 [VoiceDictationHud]。
//
// 这组用例钉的就是「目录页以会话页为准」：两边同一个流程 —— 点麦克风开始 →
// 出现实时浮层 → 提交 → 文本按同一条规则插进输入框；取消路径也一致。
// 真录音/真 socket 在 widget 测试里没有，走 [VoiceComposerController] 的
// debug 钩子塞假实现。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/voice_clip_recorder.dart';
import 'package:multicc_app/services/voice_dictation_service.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';
import 'package:multicc_app/widgets/air/air_task_config.dart';
import 'package:multicc_app/widgets/input_bar.dart';
import 'package:multicc_app/widgets/voice_composer.dart';

/// 假的流式听写：不起 socket、不开麦，测试自己推状态与文本。
class _FakeDictation extends VoiceDictationService {
  // 传一个「永远打不开麦」的 opener，免得基类去建真的 AudioRecorder（测试里没有
  // 平台通道）。于是这个参数不能转成 super 参数。
  // ignore: use_super_parameters
  _FakeDictation({required SettingsService settings})
    : super(settings: settings, micOpener: (_) async => null);

  /// 点麦克风时「能不能开始」。false 触发回退到整段录音。
  bool startResult = true;

  VoiceDictationState _fakeState = VoiceDictationState.idle;
  String finalText = '';
  String partialText = '';
  String refinedText = '';

  @override
  VoiceDictationState get state => _fakeState;

  @override
  bool get isBusy =>
      _fakeState == VoiceDictationState.starting ||
      _fakeState == VoiceDictationState.listening ||
      _fakeState == VoiceDictationState.finalizing;

  @override
  bool get hasText =>
      finalText.trim().isNotEmpty || partialText.trim().isNotEmpty;

  @override
  String get rawFinal => finalText;

  @override
  String get rawPartial => partialText;

  @override
  String get refined => refinedText;

  @override
  String get errorDetail => '';

  @override
  Future<bool> start({String provider = 'auto'}) async {
    if (!startResult) return false;
    _fakeState = VoiceDictationState.listening;
    notifyListeners();
    return true;
  }

  @override
  Future<VoiceDictationResult> commit() async {
    _fakeState = VoiceDictationState.finalizing;
    notifyListeners();
    final raw = finalText.trim();
    final refined = refinedText.trim();
    _fakeState = VoiceDictationState.done;
    notifyListeners();
    return VoiceDictationResult(
      raw: raw,
      refined: refined,
      text: refined.isNotEmpty ? refined : raw,
    );
  }

  @override
  void cancel() {
    _fakeState = VoiceDictationState.idle;
    finalText = '';
    partialText = '';
    notifyListeners();
  }

  @override
  void reportFeedback(VoiceDictationResult result, {String? userFinal}) {}
}

/// 假的整段录音器。
class _FakeClip implements VoiceClipRecording {
  bool recording = false;
  bool startResult = true;
  String sttText = '';

  @override
  bool get isRecording => recording;

  @override
  bool get isTranscribing => false;

  @override
  Future<bool> start() async {
    if (!startResult) return false;
    recording = true;
    return true;
  }

  @override
  Future<String> stopAndTranscribe(SettingsService settings) async {
    recording = false;
    return sttText;
  }

  @override
  Future<void> cancel() async {
    recording = false;
  }

  @override
  void dispose() {}
}

class _ConnectedChatProvider extends ChatProvider {
  _ConnectedChatProvider({required super.settings})
    : super(sessionName: 'voice-test', sessionCwd: '/tmp');

  @override
  ChatConnectionState get connectionState => ChatConnectionState.connected;

  @override
  bool get isStreaming => false;

  @override
  String? sendMessage(
    String text, {
    String? clientMsgId,
    bool goal = false,
    Map<String, dynamic>? goalLimits,
    String? voiceRaw,
  }) => 'test-msg';
}

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:1',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

/// 造一份会话页输入条（带它要的 provider）。
Widget _chatHost({
  required SettingsService settings,
  required SessionManager manager,
  required ChatProvider provider,
}) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<SessionManager>.value(value: manager),
      ChangeNotifierProvider<ChatProvider>.value(value: provider),
    ],
    child: const MaterialApp(home: Scaffold(body: InputBar())),
  );
}

/// 造一份目录「快速新建」并展开到整块面板。
Future<void> _pumpDirectory(WidgetTester tester, SettingsService settings) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomCenter,
          child: AirQuickComposer(
            settings: settings,
            clis: const ['claude-exp'],
            busy: false,
            docked: true,
            onSubmit:
                ({
                  required String text,
                  required String cli,
                  required AirTaskRuntime runtime,
                  required List<AirRoleBinding> roles,
                  required bool goal,
                  int? goalRounds,
                  int? goalBudget,
                }) async => true,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('air-quick-input')));
  await tester.pumpAndSettle();
}

Future<void> _drain(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  tearDown(() {
    VoiceComposerController.debugDictationBuilder = null;
    VoiceComposerController.debugClipBuilder = null;
  });

  testWidgets('会话页输入条：点麦克风 → 实时浮层 → 提交，文本按换行接进草稿', (
    tester,
  ) async {
    final settings = await _settings();
    _FakeDictation? fake;
    VoiceComposerController.debugDictationBuilder = (s) =>
        fake = _FakeDictation(settings: s);
    VoiceComposerController.debugClipBuilder = () => _FakeClip();

    final manager = SessionManager(settings: settings);
    final provider = _ConnectedChatProvider(settings: settings);
    await tester.pumpWidget(
      _chatHost(settings: settings, manager: manager, provider: provider),
    );
    await tester.pump();

    expect(find.byType(VoiceMicButton), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('chat-message-input')),
      '写一句：',
    );
    await tester.pump();

    await tester.tap(find.byType(VoiceMicButton));
    await _drain(tester);

    expect(fake, isNotNull);
    expect(find.byType(VoiceDictationHud), findsOneWidget);
    expect(find.text(t('voiceListening')), findsOneWidget);

    fake!.finalText = '你好世界';
    fake!.notifyListeners();
    await _drain(tester);
    expect(find.text('你好世界'), findsOneWidget);

    await tester.tap(find.text(t('voiceSubmit')));
    await _drain(tester);

    expect(find.byType(VoiceDictationHud), findsNothing);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('chat-message-input')))
          .controller!
          .text,
      '写一句：\n你好世界',
    );

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('目录快速新建：点麦克风 → 实时浮层 → 提交，规则与会话页逐字节相同', (
    tester,
  ) async {
    final settings = await _settings();
    _FakeDictation? fake;
    VoiceComposerController.debugDictationBuilder = (s) =>
        fake = _FakeDictation(settings: s);
    VoiceComposerController.debugClipBuilder = () => _FakeClip();

    await _pumpDirectory(tester, settings);

    // 同一颗按钮、同一块浮层组件 —— 目录页不再是自己那套。
    expect(find.byType(VoiceMicButton), findsOneWidget);
    expect(find.byType(VoiceDictationHud), findsNothing);

    await tester.enterText(find.byType(TextField), '写一句：');
    await tester.pump();

    await tester.tap(find.byType(VoiceMicButton));
    await _drain(tester);

    expect(fake, isNotNull);
    expect(find.byType(VoiceDictationHud), findsOneWidget);
    expect(find.text(t('voiceListening')), findsOneWidget);

    fake!.finalText = '你好世界';
    fake!.notifyListeners();
    await _drain(tester);
    expect(find.text('你好世界'), findsOneWidget);

    await tester.tap(find.text(t('voiceSubmit')));
    await _drain(tester);

    expect(find.byType(VoiceDictationHud), findsNothing);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '写一句：\n你好世界',
    );
  });

  testWidgets('取消路径：两边都是浮层消失、草稿原封不动', (tester) async {
    final settings = await _settings();
    _FakeDictation? fake;
    VoiceComposerController.debugDictationBuilder = (s) =>
        fake = _FakeDictation(settings: s);
    VoiceComposerController.debugClipBuilder = () => _FakeClip();

    await _pumpDirectory(tester, settings);
    await tester.enterText(find.byType(TextField), '别动我');
    await tester.pump();
    await tester.tap(find.byType(VoiceMicButton));
    await _drain(tester);
    fake!.partialText = '半句';
    fake!.notifyListeners();
    await _drain(tester);
    expect(find.byType(VoiceDictationHud), findsOneWidget);

    await tester.tap(find.text(t('cancel')));
    await _drain(tester);

    expect(find.byType(VoiceDictationHud), findsNothing);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '别动我',
    );
  });

  testWidgets('流式听写起不来时，目录页也回退到整段录音（与会话页同一条退路）', (
    tester,
  ) async {
    final settings = await _settings();
    VoiceComposerController.debugDictationBuilder = (s) =>
        _FakeDictation(settings: s)..startResult = false;
    final clip = _FakeClip()..sttText = '整段识别结果';
    VoiceComposerController.debugClipBuilder = () => clip;

    await _pumpDirectory(tester, settings);
    // 先写点草稿：贴底面板「空草稿失焦就收回一条」，有字才不会中途收起。
    await tester.enterText(find.byType(TextField), '草稿：');
    await tester.pump();

    await tester.tap(find.byType(VoiceMicButton));
    await _drain(tester);

    // /ws/voice 起不来 → 静默回退到整段录音（与会话页同一条退路：不弹 HUD，
    // 直接开录）。
    expect(find.byType(VoiceDictationHud), findsNothing);
    expect(clip.recording, isTrue);

    // 再点一下收尾 → 弹出原文面板 → 用原文填进草稿（空格相接，同会话页退路）。
    await tester.pumpAndSettle();
    await tester.tap(find.byType(VoiceMicButton));
    await tester.pumpAndSettle();

    expect(find.text(t('voiceRecognition')), findsNothing); // 提示里带 🎤 前缀
    expect(find.textContaining(t('voiceRecognition')), findsOneWidget);
    await tester.tap(find.text(t('useOriginalText')));
    await tester.pumpAndSettle();

    // 空格相接（会话页退路那条规则），不是流式听写那条换行规则。
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '草稿： 整段识别结果',
    );
  });
}
