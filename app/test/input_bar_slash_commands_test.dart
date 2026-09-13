import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/input_bar.dart';

/// 输入框的斜杠命令（对齐 web chat-composer.js 的 send()）。
///
/// 真 provider 的 sendMessage 要一条活着的 socket，所以这里只记「它收到了
/// 什么」：命令有没有被消化、透传的正文是不是原文、goal 标志有没有带上。
class _RecordingProvider extends ChatProvider {
  final List<String> sent = [];
  final List<bool> sentGoal = [];
  final List<int> clearedKeep = [];
  final List<String> localSystemLines = [];
  ChatConnectionState _connectionState = ChatConnectionState.connected;

  _RecordingProvider({required super.settings})
    : super(sessionName: 'slash-test', sessionCwd: '/tmp');

  @override
  ChatConnectionState get connectionState => _connectionState;

  void setConnectionState(ChatConnectionState value) {
    _connectionState = value;
    notifyListeners();
  }

  @override
  bool get isStreaming => false;

  @override
  void sendMessage(
    String text, {
    bool goal = false,
    Map<String, dynamic>? goalLimits,
  }) {
    sent.add(text);
    sentGoal.add(goal);
  }

  @override
  void clearHistory({int keep = 0}) => clearedKeep.add(keep);

  @override
  void addLocalSystemMessage(String text) => localSystemLines.add(text);
}

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:1',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

Widget _host({
  required SessionManager manager,
  required ChatProvider provider,
}) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<SessionManager>.value(value: manager),
      ChangeNotifierProvider<ChatProvider>.value(value: provider),
    ],
    child: const MaterialApp(
      home: Scaffold(
        body: Column(
          children: [
            Expanded(child: ColoredBox(color: Colors.black)),
            InputBar(),
          ],
        ),
      ),
    ),
  );
}

Finder get _input => find.byKey(const Key('chat-message-input'));

String _inputText(WidgetTester tester) =>
    tester.widget<TextField>(_input).controller!.text;

Future<void> _sendText(WidgetTester tester, String text) async {
  await tester.enterText(_input, text);
  await tester.pump();
  await tester.tap(find.byIcon(Icons.send_rounded));
  await tester.pump();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  Future<_RecordingProvider> pumpComposer(
    WidgetTester tester, {
    required SessionManager manager,
  }) async {
    final provider = _RecordingProvider(settings: await _settings());
    await tester.pumpWidget(_host(manager: manager, provider: provider));
    return provider;
  }

  testWidgets('/help 在本机回显命令表，不进对话流', (tester) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = await pumpComposer(tester, manager: manager);

    await _sendText(tester, '/help');

    expect(provider.sent, isEmpty);
    expect(provider.localSystemLines, [t('slashHelp')]);
    expect(_inputText(tester), isEmpty, reason: '命令发完要把输入框清干净');

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('命令名大小写不敏感（与 web 的 toLowerCase 判定一致）', (tester) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = await pumpComposer(tester, manager: manager);

    await _sendText(tester, '/HELP');

    expect(provider.sent, isEmpty);
    expect(provider.localSystemLines, [t('slashHelp')]);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('/clear 走服务端的清理显示，不把命令行当消息发出去', (tester) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = await pumpComposer(tester, manager: manager);

    await _sendText(tester, '/clear');
    await tester.pump();

    expect(provider.clearedKeep, [0]);
    expect(provider.sent, isEmpty);
    expect(_inputText(tester), isEmpty);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('/goal <任务> 跳过预检直接以 Goal 模式发送', (tester) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = await pumpComposer(tester, manager: manager);

    await _sendText(tester, '/goal 修好登录流程');

    expect(provider.sent, [
      t('goalExecutionPrompt', {'task': '修好登录流程'}),
    ]);
    expect(provider.sentGoal, [true], reason: '必须带上 goal 标志，服务端才按目标模式跑');
    expect(provider.localSystemLines, isEmpty);
    expect(_inputText(tester), isEmpty);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('/goal 不带任务时只回用法，不发空消息', (tester) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = await pumpComposer(tester, manager: manager);

    await _sendText(tester, '/goal');

    expect(provider.sent, isEmpty);
    expect(provider.localSystemLines, [t('slashGoalUsage')]);
    expect(_inputText(tester), isEmpty);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('认不出的斜杠命令照旧透传给 CLI（/compact、/cost 靠 CLI 自己接）', (
    tester,
  ) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = await pumpComposer(tester, manager: manager);

    await _sendText(tester, '/compact');

    expect(provider.sent, ['/compact']);
    expect(provider.sentGoal, [false]);
    expect(provider.localSystemLines, isEmpty);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('带参数的 /clear 仍按命令名判定（web 只看第一个词）', (tester) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = await pumpComposer(tester, manager: manager);

    await _sendText(tester, '/clear now');

    expect(provider.clearedKeep, [0]);
    expect(provider.sent, isEmpty);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });
}
